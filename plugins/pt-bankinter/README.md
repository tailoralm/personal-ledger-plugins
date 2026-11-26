# BankInter PDF Importer (`pt-bankinter`)

Official Personal Ledger Plugin SDK v1 importer for **BankInter Portugal** PDF account statements (`bank` and `savings` accounts).

## Supported Format & Layout

- **Input format**: `.pdf` (`application/pdf`) extracted into positioned words by the host MuPDF runtime (`sdk/pdf-host.mjs`).
- **Table header detection**: Matches `Data Movimento Data Valor ... Descrição ... Transação ... Montante ... Moeda ... Saldo ... Taxa Câmbio` (case-insensitive) and binds dynamic column bounds from the header row (`Movimento`, `Descri...`, `Transação`, `Montante`, `Moeda`, `Saldo`, `Taxa`, `Câmbio`).
- **Multi-page handling**:
  - `A TRANSPORTAR` resets column bindings so repeated table headers on subsequent pages re-bind cleanly.
  - `Conforme` stops page collection at the end of the page containing the statement footer.
- **Columns & row priority**:
  - `Data Movimento` (`date1`): `DD-MM-YYYY` (converted to `DD/MM/YYYY` internally and emitted as canonical ISO `YYYY-MM-DD`; `evidence.rawDate` preserves the original `DD-MM-YYYY` token).
  - `Descrição` (`[date2[1], description[1])`): Words up to the `Transação` column start with `[",;\r\n\t]` stripped and whitespace collapsed; left completely raw (no rule-based cleanup or categorization).
  - `Montante` (`credit`): Portuguese-formatted signed numbers (`-12,50`, `1.250,00`); `.` thousands separators are stripped before recording `evidence.rawAmount` and normalizing to `.`-decimal `amount`. Standalone `"-"` placeholders are ignored.
  - `Moeda` (`[credit[1], balance[0])`): When a 3-letter ISO currency code (`EUR`, `USD`, etc.) is present in the `Moeda` column, emits it uppercased as `currency`; when blank, emits `""` for backward compatibility with legacy EUR-default accounts.
  - `Taxa Câmbio` (`debit`): Fallback amount column when `Montante` is empty or `"-"`; any numeric value (e.g. `2,50`) is negated as an exchange-fee debit (`-2,50` -> `-2.50`).
  - `Saldo` (`balance`): Running balance (preserving real `"0.00"` / `"0,00"` balances; `evidence.runningBalance` retains the raw Portuguese balance with `.` thousands removed).

## Usage

```js
import { loadPlugin, prepareImportInput, runDetection, runParse } from '../../sdk/harness.mjs';
import { toLegacyTransactions, toLegacyNormalizedCsv } from '../../sdk/compat.mjs';

const loaded = await loadPlugin('./plugins/pt-bankinter');
const input = await prepareImportInput({
  fileName: 'statement.pdf',
  bytes: pdfBytes,
  limits: loaded.manifest.limits,
});

const detection = await runDetection(loaded, input);
if (detection.matched) {
  const result = await runParse(loaded, input);
  const legacy = toLegacyTransactions(result, { rawPdfValues: true });
  const csv = toLegacyNormalizedCsv(result, 'BankInter');
}
```

## Synthetic Fixtures

All fixtures under `fixtures/` are 100% synthetic PDFs generated deterministically via `sdk/pdf-fixture.mjs`:

- `fixtures/bankinter-standard.pdf`: BankInter header + standard debits (`-12,50`), credits with Portuguese thousands separator (`1.250,00`), `Taxa Câmbio` fallback row (`2,50` -> `-2.50` with `"-"` in `Montante`), repeated identical purchases, `0,00` zero running balance row, and `Conforme` footer.
- `fixtures/bankinter-multipage-currency.pdf`: Multi-page statement with `A TRANSPORTAR` page break, repeated page-2 header, explicit `EUR` / `USD` codes in `Moeda`, description punctuation cleanup (`;`, `"`), invalid calendar date `30-02-2026` row recorded in `diagnostics`, and `Conforme` footer stopping collection before page 3.
- `fixtures/negative-empty-table.pdf`: BankInter header and `Conforme` footer with zero valid transactions (rejected by `detect()` and throws `NO_TRANSACTIONS` on `parse()`).
- `fixtures/negative-unrelated.pdf`: ActivoBank-layout PDF rejected cleanly (`matched: false`, `HEADER_NOT_FOUND`).

## Audited Differences vs Legacy `PdfParserBankinterService`

| Area | Legacy `PdfParserBankinterService` + `PdfParserService` | `pt-bankinter` Plugin (SDK v1) |
|---|---|---|
| Output date & money format | Returns `DD/MM/YYYY` and raw Portuguese strings with `.` thousands stripped (`"-12,50"`, `"1250,00"`, `"0,00"`). | Emits canonical ISO `YYYY-MM-DD` and `.`-decimal strings (`"-12.50"`, `"1250.00"`, `"0.00"`). `toLegacyTransactions(..., { rawPdfValues: true })` restores `DD/MM/YYYY` and legacy raw strings. |
| `Moeda` currency column | Ignored the `Moeda` column (no `currency` evidence emitted). | Captures 3-letter ISO currency codes (`EUR`, `USD`, etc.) from `[credit[1], balance[0])`, emitting `""` when blank for backward compatibility. |
| Empty amount with valid balance | Emitted a `Transaction` with `value: ""` when both `Montante` and `Taxa Câmbio` were empty/dash. | Schema v1 requires numeric `amount`; `parsePositionedTable` records a diagnostic (`"Invalid or missing amount"`) and skips the row. |
| Malformed decimal strings | Stripped commas only and matched `/^-?\d+\.?\d*$/` (malformed `"12,50,00"` became `"125000"` and trailing `"12,"` became `"12"`). | `sdk.money.normalizePortugueseDecimal` rejects malformed decimals and records a row diagnostic cleanly. |
| Errors & detection | Threw plain `Error`; `DetectionService` ran full `parsePdf()` to accept/reject. | Throws typed `ImporterError` (`UNSUPPORTED_FORMAT`, `HEADER_NOT_FOUND`, `NO_TRANSACTIONS`); `detect()` verifies non-empty valid transactions so header-only PDFs return `matched: false, confidence: 0`. |
| Word array immutability | `PdfParserService.groupRows` mutated `word.y` in place across pages. | `sdk.pdf.groupRows` computes page offsets without mutating frozen `input.pdf` words. |
