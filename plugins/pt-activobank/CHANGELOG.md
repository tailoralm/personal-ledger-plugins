# Changelog

## [1.0.1]

- Move PDF differential and staging parity checks to the repository-level pinned core gate.

## [1.0.0]

- Initial standalone Plugin SDK v1 release migrated from Personal Ledger's `PdfParserActivobankService`.
- Supports positioned multi-page PDF column extraction, `A TRANSPORTAR` page breaks, `SALDO FINAL` footer stops, and `EXT. N. YYYY/NNN` statement-level year inference with December-on-January rollover.
- Emits canonical ISO `YYYY-MM-DD` dates, normalized `.`-decimal amounts and running balances (including `0.00`), raw PDF evidence (`rawDate`, `rawAmount`, `runningBalance`, `yearInferred`), and row diagnostics.
