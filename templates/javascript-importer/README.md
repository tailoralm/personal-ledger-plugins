# JavaScript CSV Bank Importer Template

Self-contained JavaScript reference plugin implementing Plugin SDK v1 for CSV bank statements.

## Features Demonstrated

- **Zero dependencies & zero imports**: `importer.mjs` receives `(input, sdk)` directly from the host.
- **Mojibake-safe decoding**: uses `sdk.csv.decodeBytes(input.bytes)` and `sdk.csv.parseRows`.
- **Localized header matching**: uses `sdk.csv.normalizeHeader` to support English and Portuguese headers in arbitrary column order.
- **Strict calendar & decimal rules**: outputs canonical `YYYY-MM-DD` dates and signed `.`-decimal strings, keeping real `"0.00"` balances and `"0.00"` amounts intact.
- **Diagnostics & duplicates**: moves filtered/invalid rows to `diagnostics` with row locators while preserving identical duplicate transactions.
- **Manifest options**: demonstrates `includePending` option handling via `sdk.options.resolveOption`.

## Running Tests

From the repository root:

```bash
npm test
```
