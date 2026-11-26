# Creating a Personal Ledger Bank Importer Plugin

This guide walks through creating, testing, and validating a new `pluginApiVersion: "1"` bank importer from scratch using only synthetic data.

Read [`docs/plugin-api-v1.md`](./plugin-api-v1.md) for the complete normative contract.

---

## 1. Choose a Starting Template

Copy one of the reference templates into `plugins/<your-plugin-id>/` (or work in a new plugin folder):

- **JavaScript CSV importer**: [`templates/javascript-importer/`](../templates/javascript-importer/) — minimal setup, no build step required (`entrypoint: "importer.mjs"`).
- **TypeScript PDF + CSV importer**: [`templates/typescript-importer/`](../templates/typescript-importer/) — strict TypeScript checked against `sdk/index.d.ts`, compiled ahead of distribution to `dist/importer.mjs`.

> **Important rules**:
> - Never use real bank exports, real IBANs, real account numbers, or real names in fixtures or tests.
> - Never import external npm packages, `node:*` modules, `../` parent paths, or Node globals (`Buffer`, `process`, `require`, `fs`).

---

## 2. Author `manifest.json`

Create `manifest.json` matching [`schemas/plugin-manifest.v1.schema.json`](../schemas/plugin-manifest.v1.schema.json):

```json
{
  "$schema": "../../schemas/plugin-manifest.v1.schema.json",
  "id": "acme-bank-pt",
  "name": "ACME Bank Portugal Importer",
  "version": "1.0.0",
  "pluginApiVersion": "1",
  "type": "bank-importer",
  "description": "Parses ACME Bank Portugal CSV exports.",
  "author": { "name": "Your Name" },
  "license": "MIT",
  "institution": {
    "id": "acme-bank",
    "name": "ACME Bank",
    "country": "PT"
  },
  "formats": ["csv"],
  "mimeTypes": ["text/csv"],
  "extensions": [".csv"],
  "entrypoint": "importer.mjs",
  "accountTypes": ["bank"],
  "capabilities": {
    "supportsRunningBalance": true,
    "supportsSourceIds": false,
    "supportsMultiCurrency": false,
    "supportsYearInference": false,
    "supportsInvestments": false
  },
  "limits": {
    "maxFileBytes": 10485760,
    "timeoutMs": 5000,
    "maxMemoryMb": 128
  },
  "permissions": []
}
```

Key checks:
- `id` must be kebab-case with at least two segments (`^[a-z0-9]+(?:-[a-z0-9]+)+$`).
- `permissions` **must** be `[]`.
- `entrypoint` must be a relative `.mjs` path without leading `/` or `..`.

---

## 3. Implement `detect(input, sdk)`

`detect` decides whether an unknown file belongs to your institution.

### For CSV Importers

1. Check `if (input.format !== 'csv') return { matched: false, confidence: 0, reason: '...' };`.
2. Decode bytes with `sdk.csv.decodeBytes(input.bytes)` (automatically handles UTF-8, BOM stripping, Latin-1 fallback, and double-encoded UTF-8 mojibake).
3. Parse rows with `sdk.csv.parseRows(text)` inside a `try/catch` so malformed non-matching files return `{ matched: false, confidence: 0, reason: '...' }` instead of throwing.
4. Normalize header cells with `sdk.csv.normalizeHeader(cell)` and verify the exact combination of columns unique to your bank.

### For PDF Importers

1. Check `if (input.format !== 'pdf' || !input.pdf) return { matched: false, confidence: 0, reason: '...' };`.
2. Call `sdk.pdf.extractTableWords(input.pdf, { headerRegex, footerRegex })` inside a `try/catch`.
3. Optionally boost `confidence` (e.g. `0.98` vs `0.90`) if bank-specific header/closing markers are also present in `input.pdf.pages`.

---

## 4. Implement `parse(input, sdk)`

### CSV Importer Pattern

1. Guard `input.format !== 'csv'` with `new sdk.ImporterError(sdk.ERROR_CODES.UNSUPPORTED_FORMAT, ...)`.
2. Decode and parse rows (`sdk.csv.decodeBytes`, `sdk.csv.parseRows`). Throw `HEADER_NOT_FOUND` if the expected header row is absent.
3. For each data row:
   - Parse dates with `sdk.dates.parseIsoDatePrefix(raw)` or `sdk.dates.parseDisplayDate(raw, '/')` (always producing calendar-valid `YYYY-MM-DD`).
   - Normalize amounts and balances with `sdk.money.normalizeDecimal` or `sdk.money.normalizePortugueseDecimal`.
   - Keep `description` completely raw (never clean or categorize).
   - Keep real `"0.00"` / `"0"` balances; omit `balance` only when the statement has no balance value.
   - Do **not** deduplicate identical transactions — preserve every valid occurrence with its 1-based CSV row (`evidence: { row: i + 1, locator: \`Record ${i + 1}\`, ... }`).
   - Push filtered or malformed rows to `diagnostics` with `{ locator, reason, ... }`.
4. If `transactions.length === 0` (and no `sideInvestments`), throw `new sdk.ImporterError(sdk.ERROR_CODES.NO_TRANSACTIONS, ...)`.

### PDF Importer Pattern

Use `sdk.pdf.parsePositionedTable(input.pdf, config)`:

- Provide `headerKeywords`, `headerRegex`, optional `footerRegex`, `marginToIgnore`, `columnsConfig(headerWords)`, and `extractDataFromRow(rowWords, columns)`.
- Set `decimalFormat: 'pt'` when the bank uses `.` thousands and `,` decimal separators (`1.234,56`).
- If the PDF omits years (like `MM.DD`), implement `dateNormalizer(statementText)` to extract the statement closing year, handle December-on-January rollover, and return `{ date, yearInferred: true }`.
- Implement `isEndOfPage` (e.g. `row.description.includes('A TRANSPORTAR')`) so multi-page headers re-bind columns on subsequent pages.

---

## 5. Build Synthetic Fixtures & Tests

Create at least three synthetic fixtures under `fixtures/`:

1. `fixtures/valid.csv` (or `valid.pdf`): covers credits, debits, accents/encoding, multi-page or header variations, zero balance `"0.00"`, and invalid rows landing in `diagnostics`.
2. `fixtures/duplicates-and-zero.csv` (or `duplicates.pdf`): two identical transactions on the same date plus a real `"0.00"` balance.
3. `fixtures/negative-unrelated.csv` (or `negative-unrelated.pdf`): an unrelated file that must return `{ matched: false, confidence: 0 }` from `detect()` and throw `ImporterError` from `parse()`.

For synthetic PDFs, use `buildPositionedPdf` from [`sdk/pdf-fixture.mjs`](../sdk/pdf-fixture.mjs).

In `test/importer.test.mjs`, call `validatePluginContract(PLUGIN_DIR)` from `sdk/harness.mjs` plus domain-specific assertions.

---

## 6. Build & Validate

If using TypeScript, keep `import type` references pointed to `sdk/index.d.ts`, configure `"types": []` and `"lib": ["ES2022"]` in `tsconfig.json`, and compile to `dist/importer.mjs`:

```bash
npm run build:templates
npm test
```

Both `build:templates` and all `*.test.mjs` files under `test/`, `templates/`, and `plugins/` must pass before opening a pull request.
