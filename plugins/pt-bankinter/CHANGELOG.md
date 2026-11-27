# Changelog

## [1.0.1]

- Move PDF differential and staging parity checks to the repository-level pinned core gate.

## [1.0.0]

- Initial standalone Plugin SDK v1 release migrated from Personal Ledger's `PdfParserBankinterService`.
- Supports positioned multi-page PDF column extraction, `A TRANSPORTAR` page breaks, `Conforme` footer stops, `Moeda` ISO currency extraction, and `Taxa Câmbio` exchange-fee fallback.
- Emits canonical ISO `YYYY-MM-DD` dates, normalized `.`-decimal amounts and running balances (including `0.00`), raw PDF evidence (`rawDate`, `rawAmount`, `runningBalance`), and row diagnostics.
