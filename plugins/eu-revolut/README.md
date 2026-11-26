# Revolut CSV Importer (`eu-revolut`)

Official Personal Ledger Plugin SDK v1 importer for Portuguese and English **Revolut** account statement CSV exports (`bank` and `savings` accounts).

## Supported Format & Layout

- **Input format**: `.csv` (`text/csv`, `application/csv`, `text/plain`) decoded via `sdk.csv.decodeBytes(input.bytes)` (repairs double-encoded UTF-8 mojibake, falls back to Latin-1 for invalid UTF-8 bytes, and strips UTF-8 BOMs) and parsed via `sdk.csv.parseRows`. The importer checks alternate delimiters when a preamble hides the header from delimiter detection.
- **Delimiters & quoting**: Automatically detects comma (`,`), semicolon (`;`), and tab (`\t`) delimiters across CRLF/LF line endings and RFC-4180 quoted fields (including internal commas, newlines, and `""` escaped quotes).
- **Header resolution**: Scans up to the first 10 non-empty rows using `sdk.csv.normalizeHeader`:
  - `product`: `Produto` / `Product`
  - `completedDate`: prefix `Data de conclusão` (`data de conclus`) / `Completed Date` (`completed date`)
  - `description`: `Descrição` / `Description`
  - `amount`: `Montante` / `Amount`
  - Optional columns on the matched header row (or row 0 in fallback mode):
    - `currency`: `Currency (Total)`, `Currency`, `Moeda`
    - `id`: `ID`, `Transaction ID`
    - `balance`: `Balance`, `Saldo`
  - **Legacy column-order fallback**: When no recognized header row is found in the first 10 rows, falls back to `DEFAULT_COLUMNS = { product: 1, completedDate: 3, description: 4, amount: 5 }` with `headerIndex = 0`, succeeding only if at least one valid `Atual`/`Current` row parses (`detect()` confidence `0.85` vs `0.98` when headers match).
- **Product filtering & validation**:
  - Retains only rows whose `Product`/`Produto` cell equals `Atual` or `Current` (case-insensitive, trimmed). Other products (e.g., `Poupança`, `Savings`) emit an `info` diagnostic with `code: "FILTERED_PRODUCT"` (`"Product outside Atual/Current"`).
  - Parses `Completed Date` via `sdk.dates.parseIsoDatePrefix` (`YYYY-MM-DD`, leap-year and calendar validated). Missing or invalid dates, blank descriptions, or unparseable amounts emit a `warning` diagnostic with `code: "INVALID_ROW"` (`"Missing or invalid date, description, or amount"`).
  - Uppercases non-empty 3-letter ISO 4217 currency codes (`""` when omitted or empty) and records `INVALID_CURRENCY` diagnostics for malformed non-empty codes.
  - Preserves raw descriptions (no cleaning or categorization), retains repeated identical purchases without deduplication, emits `sourceId` when `ID`/`Transaction ID` is non-empty, and preserves genuine `"0"` / `"0.00"` running balances in both `balance` and `evidence.runningBalance` (omitting both when the balance cell is empty).

## Usage

```js
import { loadPlugin, prepareImportInput, runDetection, runParse } from '../../sdk/harness.mjs';
import { toLegacyTransactions, toLegacyNormalizedCsv } from '../../sdk/compat.mjs';

const loaded = await loadPlugin('./plugins/eu-revolut');
const input = await prepareImportInput({
  fileName: 'revolut-statement.csv',
  bytes: csvBytes,
  limits: loaded.manifest.limits,
});

const detection = await runDetection(loaded, input);
if (detection.matched) {
  const result = await runParse(loaded, input);
  const legacy = toLegacyTransactions(result);
  const csv = toLegacyNormalizedCsv(result, 'Revolut');
}
```

## Synthetic Fixtures

All fixtures under `fixtures/` are 100% synthetic:

- `fixtures/revolut-pt-mojibake.csv`: Portuguese headers with real raw double-encoded UTF-8 bytes (`DescriÃ§Ã£o`, `CafÃ© Central`, `Padaria SÃ£o JoÃ£o`), CRLF endings, quoted field with an internal comma (`"Depósito, Salário"`), `Atual` & `Poupança` rows, `"0.00"` balance, and `ID` column.
- `fixtures/revolut-en-multicurrency.csv`: Reordered English headers (`Amount,Description,Completed Date,Product,Currency,Balance,ID`), `Current` vs `Savings` rows, `EUR` + `USD` + `GBP` currencies, repeated identical `Cafe` rows on the same timestamp (`-5.00`), genuine `"0.00"` running balance, and invalid rows (`2026-02-30`, empty description, `"invalid"` amount) emitted as diagnostics.
- `fixtures/negative-savings-only.csv`: Valid Revolut headers containing only `Savings` / `Poupança` rows (rejected by `detect()`, throws `NO_TRANSACTIONS` on `parse()`).
- `fixtures/negative-unrelated.csv`: Non-Revolut Trading212-shaped CSV rejected cleanly (`matched: false`, `NO_TRANSACTIONS`).

## Audited Differences vs Legacy `RevolutCsvParserService`

| Area | Legacy `RevolutCsvParserService` + `CsvReaderService` | `eu-revolut` Plugin (SDK v1) |
|---|---|---|
| Output dates, balances & side channels | Returned `DD/MM/YYYY` dates and `balance: ''`, attaching `sourceId`, `currency`, `runningBalance`, and `diagnostics` via `WeakMap` side channels. | Emits canonical ISO `YYYY-MM-DD` dates, normalized `.`-decimal `amount` and optional `balance`, uppercase `currency`, `sourceId`, `evidence`, and `diagnostics` directly in `ImportResult`. `toLegacyTransactions` and `toLegacyNormalizedCsv` convert back for legacy consumers. |
| Calendar-invalid dates (`2026-02-30`) | `CsvReaderService.parseDate()` matched `/^(\d{4})-(\d{2})-(\d{2})$/` without calendar validation, converting `2026-02-30` to `30/02/2026` until `LedgerImports` rejected it during staging. | `sdk.dates.parseIsoDatePrefix()` validates real calendar dates (including leap years) during parsing, rejecting `2026-02-30` immediately and recording an `INVALID_ROW` diagnostic (`date: "2026-02-30"`, `rawDate: "2026-02-30 12:00:00"`). |
| Delimiter auto-detection & quoting | `CsvReaderService.parseCsv()` hardcoded comma `,` delimiters and silently accepted malformed quotes. | The importer uses SDK helpers to detect and parse `,`, `;`, and `\t` delimiters across CRLF/LF and raises `ImporterError(INVALID_STATEMENT)` on malformed CSV quotes. |
| Normalized `balance` preservation | Stored raw trimmed `runningBalance` in `statementEvidence` and kept `transaction.balance = ''` until `LedgerImports` normalized it. | Normalizes non-empty balances via `sdk.money.normalizeDecimal()` into both `tx.balance` and `evidence.runningBalance` (preserving genuine `"0"` / `"0.00"`), omits both when empty, and keeps unparseable non-empty raw strings only in `evidence.runningBalance` without breaking valid transactions. |
| Currency validation | Stored raw trimmed currency in `statementEvidence` and deferred ISO 4217 validation to `LedgerImports`. | Uppercases `currency` (`""` when omitted or empty) and emits an `INVALID_CURRENCY` warning diagnostic if non-empty currency is not a 3-letter ISO 4217 code. |
| Header normalization & typed errors | Normalized headers via `NFD` + trim + lowercase; threw plain `Error`; `DetectionService` called full `parse()`. | Uses `sdk.csv.normalizeHeader()` (also collapsing repeated whitespace), throws typed `ImporterError` (`UNSUPPORTED_FORMAT`, `EMPTY_INPUT`, `INVALID_STATEMENT`, `NO_TRANSACTIONS`), and catches `ImporterError` in `detect()` (`confidence: 0.98` matched headers / `0.85` fallback). |

## Legacy parity test

Point `PERSONAL_LEDGER_DIST` at the built Personal Ledger `dist` directory to run the optional cross-repository test. The test compares the legacy parser with the plugin JSON and feeds the converted plugin records into real ledger staging through a test adapter. It checks overlapping purchases, duplicate source IDs, currency routing and reconciliation with a zero balance. Production plugin integration is tracked in Personal Ledger #61.
