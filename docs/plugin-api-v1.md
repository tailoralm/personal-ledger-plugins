# Personal Ledger Plugin API v1 Specification

This document defines the normative contract for `pluginApiVersion: "1"` bank statement importer plugins in `personal-ledger-plugins` and their execution by Personal Ledger.

---

## 1. Architecture & Isolation Model

Bank importer plugins run inside an isolated runtime boundary:

- **Host runtime**: Reads files from disk, enforces size/time/memory limits, decodes/extracts positioned PDF words with MuPDF (`sdk/pdf-host.mjs`), constructs a deep-frozen `ImportInput`, provides `ImporterSdk`, validates returned `DetectionResult` and `ImportResult` payloads against JSON Schemas (`schemas/*.v1.schema.json`), and adapts results for Personal Ledger (`sdk/compat.mjs`).
- **Plugin package**: A self-contained directory containing `manifest.json`, an ESM entrypoint (e.g. `importer.mjs` or compiled `dist/importer.mjs`), documentation, and synthetic test fixtures.

### Hard Isolation Invariants

1. **Zero external or parent imports**: Plugins (`importer.mjs`, `dist/importer.mjs`, and any helper under the plugin folder) **must not** import npm packages, `node:*` built-in modules, or `../` parent paths. Only `./` relative imports inside the same plugin directory are allowed.
2. **Zero host globals**: Plugins **must not** reference `Buffer`, `process`, `require`, `__dirname`, `__filename`, `fs`, or network APIs. All decoding, CSV parsing, calendar math, decimal normalization, and PDF table utilities are provided through `(input, sdk)`.
3. **Zero permissions in v1**: `manifest.permissions` must be `[]` (`maxItems: 0`).
4. **Read-only pure transformation**: Plugins never read or write `categories.json`, `descriptions.json`, SQLite databases, or output CSVs. Personal Ledger applies rule cleanup and categorization after receiving raw descriptions from the plugin.

---

## 2. Manifest Contract (`manifest.json`)

Every plugin directory must contain a `manifest.json` valid against [`schemas/plugin-manifest.v1.schema.json`](../schemas/plugin-manifest.v1.schema.json).

### Required Top-Level Fields

| Field | Type / Pattern | Description |
|---|---|---|
| `id` | `^[a-z0-9]+(?:-[a-z0-9]+)+$` | Unique kebab-case plugin identifier (minimum two segments, e.g. `example-csv-bank`). |
| `name` | non-empty `string` | Human-readable plugin title. |
| `version` | Strict SemVer `string` | Semantic version (e.g. `1.0.0`, `1.2.0-rc.1`). |
| `pluginApiVersion` | `"1"` | Must be the literal string `"1"`. |
| `type` | `"bank-importer"` | Plugin kind; v1 supports `"bank-importer"`. |
| `description` | non-empty `string` | Concise summary of supported bank statements. |
| `author` | `{ name, url? }` | Author display name and optional `http(s)://` URL. |
| `license` | non-empty `string` | SPDX license identifier (e.g. `MIT`). |
| `institution` | `{ id, name, country, legacyNames? }` | Target institution metadata. `id` matches `^[a-z0-9]+(?:-[a-z0-9]+)*$`; `country` matches `^([A-Z]{2}|EU|INT)$`. `legacyNames` preserves historical Personal Ledger institution display names. |
| `formats` | non-empty unique array | Subset of `["pdf", "csv", "xlsx"]`. |
| `mimeTypes` | non-empty unique `string[]` | Supported MIME types (e.g. `["text/csv"]`, `["application/pdf"]`). |
| `extensions` | non-empty unique `string[]` | Lowercase extensions matching `^\.[a-z0-9]+$` (e.g. `[".csv"]`). |
| `entrypoint` | `^[a-zA-Z0-9._/-]+\.mjs$` | Relative ESM entrypoint inside the plugin directory (no leading `/` and no `..`). |
| `accountTypes` | non-empty unique array | Subset of `["bank", "savings", "spend", "invest", "manual", "coverflex"]`. |
| `capabilities` | `object` | Feature flags and optional user/caller options (see below). |
| `limits` | `{ maxFileBytes, timeoutMs, maxMemoryMb }` | Positive integer resource bounds declared by the plugin. |
| `permissions` | `[]` | Must be an empty array (`maxItems: 0`). |

Optional fields: `$schema`, `homepage` (`https?://`), `languages` (`^[a-z]{2}(?:-[A-Z]{2})?$`), `keywords`, `tier` (`"official" | "community"`).

### `capabilities` Object

Required boolean flags:

- `supportsRunningBalance`: Plugin populates `transaction.balance` / `evidence.runningBalance` when present in statements.
- `supportsSourceIds`: Plugin emits stable bank-supplied `transaction.sourceId` identifiers.
- `supportsMultiCurrency`: Plugin can emit non-EUR or mixed currencies per statement.
- `supportsYearInference`: Plugin can infer missing years from statement headers (`evidence.yearInferred = true`).
- `supportsInvestments`: Plugin emits structured `evidence.investment` records (`buy`, `sell`, `dividend`).

Optional fields:

- `supportsSideInvestments`: Plugin emits legacy `sideInvestments` records (`investments.csv` parity).
- `supportsBackfill`: Plugin supports deterministic row/sourceId matching for missing-record backfill.
- `options`: Array of option definitions:
  - `id` (`^[a-z][a-zA-Z0-9_-]*$`), `label`, `description`, `type` (`"boolean" | "enum"`), `default`, optional `legacyCliDefault`, and `values` (required when `type === "enum"`; `default` and `legacyCliDefault` must belong to `values`).

---

## 3. Module Export & `ImportInput`

The `entrypoint` `.mjs` module must export an object (either `export default { detect, parse }` or named exports `detect` and `parse`):

```ts
export default {
  detect(input: ImportInput, sdk: ImporterSdk): DetectionResult | Promise<DetectionResult> { ... },
  parse(input: ImportInput, sdk: ImporterSdk): ImportResult | Promise<ImportResult> { ... },
};
```

### `ImportInput`

The host prepares and deep-freezes `ImportInput` before invoking `detect` or `parse`. Attempting to mutate `input`, `input.options`, `input.pdf`, or any extracted `PdfWord` throws a `TypeError`.

- `fileName`: Original file name (e.g. `"statement.csv"`).
- `format`: `"pdf" | "csv" | "xlsx" | "unknown"`.
- `mimeType`: Resolved MIME type.
- `bytes`: Raw input bytes as `Uint8Array` (never a Node `Buffer`).
- `text` *(optional)*: Pre-decoded text for CSV inputs (via `sdk.csv.decodeBytes(bytes)`).
- `pdf` *(optional)*: Populated for PDF inputs by the trusted host extractor (`sdk/pdf-host.mjs`):
  - `pageCount`: Total page count.
  - `pages`: Array of `{ page, text, words }`, where each `word` has `{ text, x, y, width, height, page }`.
- `options`: Frozen key/value map of caller options.

---

## 4. `DetectionResult` Contract

`detect(input, sdk)` must return an object matching [`schemas/detection-result.v1.schema.json`](../schemas/detection-result.v1.schema.json):

- `matched` (`boolean`, required)
- `confidence` (`number` in `[0, 1]`, required):
  - **When `matched === false`, `confidence` MUST be `0`.**
  - **When `matched === true`, `confidence` MUST be strictly greater than `0` (`0 < confidence <= 1`).**
- `reason` (`string`, required, non-empty): Clear diagnostic explanation for match or rejection.
- `format` *(optional)*: `"pdf" | "csv" | "xlsx"`.
- `institutionId` *(optional)*: Institution ID if matched.
- `ambiguity` *(optional)*: `{ possibleOverlap: boolean, notes?: string }`.
- `metadata` *(optional)*: Diagnostic object.

`detect()` should return `{ matched: false, confidence: 0, reason: "..." }` for wrong formats, missing headers, or malformed non-matching files instead of throwing.

### Auto-Detection Resolution

When multiple plugins are tried in automatic mode:

1. Only plugins returning `matched: true` are candidates.
2. If one plugin matches, it wins.
3. If multiple plugins match, the host may run `parse()` on top candidates and break ties by confidence, parsed transaction count, or configured priority.
4. Mutually rejecting unrelated statements cleanly (`matched: false, confidence: 0`) prevents false positives.

---

## 5. `ImportResult` Contract

`parse(input, sdk)` returns an object matching [`schemas/import-result.v1.schema.json`](../schemas/import-result.v1.schema.json):

- `pluginApiVersion`: `"1"`
- `pluginId`: Must equal `manifest.id`.
- `institutionId`: Must equal `manifest.institution.id`.
- `transactions`: Array of `NormalizedTransaction`.
- `diagnostics`: Array of `ImportDiagnostic` (skipped, filtered, or invalid rows).
- `sideInvestments` *(optional)*: Legacy investment rows (`Investment` model parity).
- `metadata` *(optional)*: Extra non-transactional parse summary.

### `NormalizedTransaction`

| Field | Required | Format / Rule |
|---|---|---|
| `date` | Yes | Canonical ISO 8601 calendar date `YYYY-MM-DD` (`1900`–`2100`, leap years validated). |
| `description` | Yes | Raw original description from statement (non-empty, non-whitespace). Never pre-cleaned or categorized. |
| `amount` | Yes | Signed normalized `.`-decimal string matching `^-?\d+(?:\.\d+)?$` (debits negative, credits positive, no currency symbol or thousands separator). |
| `currency` | Yes | Uppercase ISO 4217 3-letter code (`^[A-Z]{3}$`) when stated by the source, or `""` when omitted by the statement. |
| `balance` | No | Signed normalized `.`-decimal string matching `^-?\d+(?:\.\d+)?$`. Preserve real `"0"` / `"0.00"` when present; omit when absent. |
| `sourceId` | No | Stable source-provided transaction ID (for overlap/backfill matching). |
| `accountReference` | No | Source account/IBAN/card reference if available. |
| `evidence` | Yes | `{ row, page?, locator, rawDate?, rawAmount?, runningBalance?, yearInferred?, action?, investment? }`. |

### Canonical Date Rules

- Plugins **always** emit `YYYY-MM-DD` calendar-valid dates (`sdk.dates.toIsoDate`, `sdk.dates.parseDisplayDate`, `sdk.dates.parseIsoDatePrefix`).
- All date validation uses timezone-independent integer calendar math (`1900 <= year <= 2100`, valid leap-year Feb 29 handling).
- When a bank PDF omits the year (e.g. `MM.DD`), plugins infer the year from statement header context, handle year-boundary rollovers (e.g. December postings on a January statement), set `evidence.yearInferred = true`, and populate `evidence.rawDate` so Personal Ledger can prompt the user to confirm.
- Personal Ledger's host compatibility adapter (`sdk/compat.mjs`) converts `YYYY-MM-DD` to Personal Ledger's legacy display format `DD/MM/YYYY` where needed.

### Signed Decimal Money Rules

- Use string-preserving decimal helpers (`sdk.money.normalizeDecimal`, `sdk.money.normalizePortugueseDecimal`, `sdk.money.withSign`) rather than floating-point `Number()` math to prevent rounding or precision loss.
- Outflows/debits are negative (`"-12.50"`), inflows/credits are positive (`"1500.00"`), zero amounts are unsigned (`"0.00"` or `"0"`).
- Never drop a real `"0"` or `"0.00"` running balance. Omit `balance` only when the statement has no running balance column or cell.

### Duplicate Rows & Evidence Rules

- **Never deduplicate identical rows inside a plugin.** Two identical coffee purchases on the same day must both appear in `transactions` with their respective `evidence.row` and `evidence.locator`.
- PDF rows use `Page <page>, row <rowNumber>` locators (`evidence.page` set to 1-based page number).
- CSV rows use `Record <rowNumber>` locators (1-based CSV record index).

---

## 6. Sandbox Boundary for MuPDF Positioned Words

MuPDF runs strictly in the **trusted host** (`sdk/pdf-host.mjs`):

1. Host opens the PDF bytes via `mupdf.Document.openDocument(bytes, 'application/pdf')`.
2. For each page (`1..pageCount`), host calls `page.toStructuredText('preserve-whitespace').walk({ onChar, endLine })`.
3. Words are flushed on `' '`, `'\t'`, and `endLine`, capturing:
   - `x = origin[0]`
   - `y = origin[1]`
   - `width = quad[2] - wordX`
   - `height = Math.max(wordHeight, size)`
   - `page = pageNum` (1-based)
4. Host enforces limits (`maxFileBytes`, `maxPages = 200`, `maxWords = 250_000`), throwing `ImporterError('PDF_EXTRACTION_FAILED', ...)` on failure or limit breach.
5. Plugins receive the frozen `input.pdf` structure and parse tables using pure-JS helpers in `sdk.pdf`:
   - `extractTableWords(pdfDoc, { headerRegex, footerRegex })`
   - `groupRows(words, { marginToIgnore, tolerance, pageOffset })` (never mutates input words)
   - `parsePositionedTable(pdfDoc, config)`

---

## 7. Standard Error Codes

Plugins throw `new sdk.ImporterError(code, message, details?)` for file-level failures:

| Code | When to Throw |
|---|---|
| `EMPTY_INPUT` | Input has 0 bytes or no readable records. |
| `FILE_TOO_LARGE` | Input exceeds `manifest.limits.maxFileBytes`. |
| `UNSUPPORTED_FORMAT` | File format/MIME is unsupported by this plugin. |
| `HEADER_NOT_FOUND` | Expected statement table or CSV columns were not found. |
| `UNRECOGNIZED_STATEMENT` | Structure does not belong to this institution. |
| `NO_TRANSACTIONS` | Statement matched structurally but yielded 0 valid transactions (and 0 side investments). |
| `PDF_EXTRACTION_FAILED` | Host failed to extract PDF words or exceeded PDF page/word caps. |
| `INVALID_STATEMENT` | Corrupt CSV quoting or malformed statement structure. |

Row-level rejections (filtered account types, unknown actions, unparseable row dates/amounts) belong in `ImportResult.diagnostics`, **not** thrown exceptions, as long as valid transactions remain.

---

## 8. Resource Limits & Evolution Policy

### Resource Limits

- Hosts must enforce `manifest.limits` (`maxFileBytes`, `timeoutMs`, `maxMemoryMb`) and PDF extraction caps (`maxPages = 200`, `maxWords = 250_000`).
- Plugins must declare realistic bounds; typical values are `maxFileBytes: 10485760`–`20971520` (10–20 MiB), `timeoutMs: 5000`–`10000`, `maxMemoryMb: 128`.

### SemVer & Schema Evolution

- `pluginApiVersion: "1"` guarantees backward compatibility for all additive optional fields on `ImportInput`, `ImporterSdk`, `DetectionResult`, and `ImportResult`.
- Breaking changes to required fields, error semantics, or coordinate conventions require a new `pluginApiVersion` (`"2"`) and new `*.v2.schema.json` schemas.
- Plugin authors bump their own `manifest.version` following SemVer:
  - **PATCH**: bug fixes, edge-case diagnostics, description/documentation updates.
  - **MINOR**: supporting a new bank export locale/column alias or optional capability without breaking existing fixtures.
  - **MAJOR**: changing `institution.id`, removing supported formats/options, or altering emitted `sourceId` schemes.

---

## 9. Personal Ledger Consumption & Legacy Compatibility

`sdk/compat.mjs` bridges `ImportResult` into existing Personal Ledger models:

- `toLegacyTransactions(importResult, { rawPdfValues })`:
  - Converts `YYYY-MM-DD` → `DD/MM/YYYY`.
  - Sets `cleanDescription: ''` and `category: ''` for downstream `TransformService` rule application.
  - Preserves `"0"` / `"0.00"` balances in `balance` and `evidence.runningBalance`.
  - Maps `evidence` and `diagnostics` into `StatementEvidence` and `StatementDiagnostic` shapes, plus `sideInvestments` into `Investment[]`.
- `toLegacyNormalizedCsv(importResult, institutionName)`:
  - Produces 6-column `;`-delimited CSV (`date;description;cleanDescription;category;value;bank`) with `,` decimal separator.
- Plugins that change behavior between Ledger full-activity mode and CLI statement-only mode read `sdk.options.isStatementOnlyMode(input)` and declare `legacyCliDefault` on their `capabilities.options` entry.
