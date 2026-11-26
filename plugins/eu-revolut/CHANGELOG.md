# Changelog

## [1.0.0]

- Initial standalone Plugin SDK v1 release migrated from Personal Ledger's `RevolutCsvParserService` and `CsvReaderService`.
- Supports Portuguese and English Revolut CSV headers (including reordered columns and legacy positional fallback), comma/semicolon/tab delimiter auto-detection, quoted fields, double-encoded UTF-8 mojibake repair, and Latin-1 fallback.
- Emits canonical calendar-valid ISO `YYYY-MM-DD` dates, raw descriptions, normalized `.`-decimal amounts and running balances (including `"0"` / `"0.00"`), uppercase ISO 4217 multi-currency codes, `sourceId`, `evidence`, and structured row diagnostics (`FILTERED_PRODUCT`, `INVALID_ROW`, `INVALID_CURRENCY`).
