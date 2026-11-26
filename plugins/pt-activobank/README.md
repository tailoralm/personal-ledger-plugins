# ActivoBank PDF Importer (`pt-activobank`)

Official Personal Ledger Plugin SDK v1 importer for **ActivoBank Portugal** PDF account statements (`bank` and `savings` accounts).

## Supported Format & Layout

- **Input format**: `.pdf` (`application/pdf`) extracted into positioned words by the host MuPDF runtime (`sdk/pdf-host.mjs`).
- **Table header detection**: Matches `Data Lanc. Data Valor ... Descritivo ... Debito ... Credito ... Saldo` (case-insensitive) and binds dynamic column bounds from the header row (`lanc.`, `valor`, `descritivo`, `debito`, `credito`, `saldo`), ignoring left-margin artifacts (`x < 50`).
- **Multi-page handling**:
  - `A TRANSPORTAR` resets column bindings so repeated table headers on subsequent pages re-bind cleanly.
  - `SALDO FINAL` stops page collection at the end of the page containing the statement footer.
- **Row priority & cleanup**:
  - `date`: First whitespace-delimited token inside `lanc.` (`MM.DD` or full `DD/MM/YYYY`).
  - `description`: Words in `[valor.x1, debit.x0)` with `[",;\r\n\t]` stripped and whitespace collapsed; left completely raw (no rule-based cleanup or categorization).
  - `amount`: `Credito` if present (positive), otherwise `-` + `Debito` (negative), parsed using Portuguese decimal formatting (`.` thousands, `,` decimal).
  - `balance`: `Saldo` running balance (preserving real `"0.00"` / `"0,00"` balances).
  - `currency`: `""` (omitted by ActivoBank statement rows; Personal Ledger maps empty currency to the account currency / `EUR`).

## Year Inference & Options

ActivoBank statement tables print `MM.DD` dates without a year:

1. The importer scans pre-table `statementText` for the closing header `YY/MM/DD EXT. N. YYYY/NNN`, verifying that `YYYY` ends with `YY` and `DD/MM/YYYY` is a valid calendar date.
2. When a row date matches `MM.DD`, it sets `evidence.yearInferred = true` and resolves the year as:
   `closingDate.year - Number(month > closingDate.month)` (so `12.31` on a `26/01/30 EXT. N. 2026/001` statement resolves to `2025-12-31`).
3. When no valid closing header is present, the year falls back to `input.options?.referenceYear` (4-digit integer or string in `1900..2100`) and otherwise `new Date().getUTCFullYear()`.

## Usage

```js
import { loadPlugin, prepareImportInput, runDetection, runParse } from '../../sdk/harness.mjs';
import { toLegacyTransactions, toLegacyNormalizedCsv } from '../../sdk/compat.mjs';

const loaded = await loadPlugin('./plugins/pt-activobank');
const input = await prepareImportInput({
  fileName: 'statement.pdf',
  bytes: pdfBytes,
  limits: loaded.manifest.limits,
  options: { referenceYear: 2026 },
});

const detection = await runDetection(loaded, input);
if (detection.matched) {
  const result = await runParse(loaded, input);
  const legacy = toLegacyTransactions(result, { rawPdfValues: true });
  const csv = toLegacyNormalizedCsv(result, 'ActivoBank');
}
```

## Synthetic Fixtures

All fixtures under `fixtures/` are 100% synthetic PDFs generated via `sdk/pdf-fixture.mjs`:

- `fixtures/activobank-rollover.pdf`: Closing header `26/01/30 EXT. N. 2026/001`, Dec `12.31` -> `2025-12-31` rollover credit (`500,00`), Jan `01.05` repeated identical `Cafe` debits (`-12,50`), and a `0,00` running balance row.
- `fixtures/activobank-multipage.pdf`: Multi-page statement with `A TRANSPORTAR` page break, repeated page-2 headers, thousands-formatted numbers (`1.250,50`), invalid calendar date `02.30` row recorded in `diagnostics`, and `SALDO FINAL` stopping collection before page 3.
- `fixtures/negative-header-only.pdf`: ActivoBank headers and `SALDO FINAL` with zero valid transactions (rejected by `detect()` and throws `NO_TRANSACTIONS` on `parse()`).
- `fixtures/negative-unrelated.pdf`: BankInter-layout PDF rejected cleanly (`matched: false`, `HEADER_NOT_FOUND`).

## SDK Audit Findings & Differences vs Legacy `PdfParserActivobankService`

### SDK Audit Fixes Applied

1. **`sdk.pdf.parsePositionedTable` raw `runningBalance` support (`sdk/index.mjs`, `sdk/index.d.ts`)**:
   - Previously, `parsePositionedTable` always wrote `evidence.runningBalance = normalizedBalance ?? rawBalance` (ignoring `row.runningBalance`), whereas `rawDate` and `rawAmount` respected plugin-supplied values. `parsePositionedTable` now preserves `row.runningBalance` when supplied (falling back to `normalizedBalance ?? rawBalance` when omitted), allowing `pt-activobank` to preserve raw Portuguese balances (`"100,00"`, `"0,00"`, `"1.250,50"`) for `toLegacyTransactions(..., { rawPdfValues: true })` parity without breaking existing templates.
2. **`parsePositionedTable` amount source consistency (`sdk/index.mjs`)**:
   - Normalized `rawValue = String(row.value ?? row.rawAmount ?? '').trim()` consistently instead of checking `rawAmount !== ''` while normalizing `row.value`.

### Audited Behavioral Differences vs Legacy

| Area | Legacy `PdfParserActivobankService` + `PdfParserService` | `pt-activobank` Plugin (SDK v1) |
|---|---|---|
| Output date & money format | Returns `DD/MM/YYYY` and raw Portuguese strings (`"-12,50"`, `"1.250,50"`, `"0,00"`). | Emits canonical ISO `YYYY-MM-DD` and `.`-decimal strings (`"-12.50"`, `"1250.50"`, `"0.00"`). `toLegacyTransactions(..., { rawPdfValues: true })` restores `DD/MM/YYYY` and raw PDF `value`/`balance`. |
| Empty amount with valid balance | Emitted a `Transaction` with `value: ""` (failing later in Ledger or producing an empty CSV cell). | Schema v1 requires numeric `amount`; `parsePositionedTable` records a diagnostic (`"Invalid or missing amount"`) and skips the row. |
| Thousands & malformed decimals | Stripped commas only and matched `/^-?\d+\.?\d*$/` (single-dot `"1.250,50"` passed incidentally; multi-dot `"1.250.500,50"` failed; trailing `"12,"` passed; `CsvDataService` broke `"1.250,50"` into `"1,250,50"`). | `sdk.money.normalizePortugueseDecimal` strips all `.` thousands separators, converts `,` to `.`, rejects trailing `"12,"`, and `toLegacyNormalizedCsv` exports `1250,50` cleanly. |
| Invalid calendar dates (`02.30`) | Skipped with `{ locator, reason, date: '30/02/2026', description, value }` in `statementDiagnostics`. | Produces diagnostic with `date: '30/02/2026'`, `rawDate: '02.30'`, `description`, and `value`; `compat.mjs` retains `30/02/2026`. |
| Fallback year | Always used `new Date().getFullYear()` when closing header was missing. | Uses `input.options?.referenceYear` when provided (`1900`–`2100`), otherwise `new Date().getUTCFullYear()`. |
| Errors & detection | Threw plain `Error`; `DetectionService` ran full `parsePdf()` to accept/reject. | Throws typed `ImporterError` (`UNSUPPORTED_FORMAT`, `HEADER_NOT_FOUND`, `NO_TRANSACTIONS`); `detect()` verifies non-empty valid transactions so header-only PDFs return `matched: false, confidence: 0`. |
