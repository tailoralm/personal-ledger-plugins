# Cross-Repository Compatibility Fixtures

This suite defines synthetic, anonymized inputs and canonical SDK v1 / legacy compatibility expectations shared between `personal-ledger-plugins` and `personal-ledger`.

All files in `inputs/` and `cases/` use 100% synthetic data. Never add real bank exports or personal identifiers.

## Cases

| Case | Scenario | Input |
|---|---|---|
| `01-valid-parse-and-mojibake.json` | Double-encoded UTF-8 mojibake repair, multi-currency rows, and diagnostics | `inputs/valid-revolut-mojibake.csv` |
| `02-negative-unrelated.json` | Rejection of unrelated CSV and PDF documents (`confidence: 0`, `ImporterError`) | `inputs/negative-unrelated.csv`, `inputs/negative-unrelated.pdf` |
| `03-duplicate-identical-rows.json` | Retention of identical duplicate purchases on the same date/timestamp | `inputs/duplicates-and-zero.csv` |
| `04-real-zero-balance.json` | Preservation of real `"0.00"` running balances across SDK v1 and legacy compat | `inputs/duplicates-and-zero.csv` |
| `05-inferred-year-pdf.json` | Positioned PDF year inference (`yearInferred: true`), Dec-on-Jan rollover, and `rawPdfValues` compat | `inputs/inferred-year-activobank.pdf` |
| `06-multi-and-empty-currency.json` | Explicit ISO 4217 currencies (`JPY`, `USD`) and omitted `""` currency for EUR-default handling | (schema & compat) |
| `07-structured-investment-evidence.json` | Buy/sell/dividend structured `investment` evidence and `sideInvestments` legacy store parity | `inputs/trading212-full-activity.csv` |

## Verification

Every case is verified against:

1. `schemas/detection-result.v1.schema.json` and `schemas/import-result.v1.schema.json`
2. Calendar date validity (`sdk.dates.isValidIsoDate`)
3. `sdk/compat.mjs` conversion to Personal-Ledger legacy `Transaction[]`, `StatementEvidence[]`, `StatementDiagnostic[]`, `Investment[]`, and 6-column `;`-delimited normalized CSV.
