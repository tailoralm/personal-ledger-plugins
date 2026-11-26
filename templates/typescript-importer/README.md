# TypeScript PDF & CSV Bank Importer Template

Self-contained TypeScript reference plugin implementing Plugin SDK v1 for multi-page positioned PDF statements and CSV exports.

## Build & Verify

`src/importer.ts` uses `import type` exclusively against `sdk/index.d.ts`, producing a pure, zero-import `dist/importer.mjs` bundle with no Node or DOM globals (`Buffer`, `process`, `fs`).

From the repository root:

```bash
npm run build:templates
npm test
```

## Features Demonstrated

- **Multi-page positioned PDF extraction**: uses `sdk.pdf.parsePositionedTable` with dynamic column detection, `A TRANSPORTAR` page breaks, and `SALDO FINAL` footer detection.
- **Year inference**: infers statement year from `YY/MM/DD EXT. N. YYYY/NNN` headers including December-on-January rollover, attaching `evidence.yearInferred = true` and `evidence.rawDate`.
- **Portuguese decimal formatting**: normalizes `1.500,00` and `0,00` into signed `.`-decimal strings while preserving real `"0.00"` balances.
- **CSV secondary format**: supports `.csv` exports alongside `.pdf`.
