# Agent Instructions (`personal-ledger-plugins`)

## Repository Scope

This repository defines Plugin SDK v1, Draft 2020-12 JSON Schemas, JavaScript and TypeScript importer templates, compatibility fixtures, and host validation harnesses for Personal Ledger bank statement importers.

## Critical Security & Isolation Rules

1. **Zero external or parent imports in plugins**:
   - Files under `templates/*/importer.mjs`, `templates/*/dist/importer.mjs`, and `plugins/*/*.mjs` must NEVER import external packages, `node:*` modules, or `../` parent paths.
   - Plugins must NOT reference `Buffer`, `process`, `require`, `__dirname`, `__filename`, `fs`, or network globals.
   - Plugins receive `(input, sdk)` directly from the host so each plugin folder/archive stays safe inside isolated runtimes (QuickJS/Wasm).
2. **MuPDF runs strictly in the host**:
   - PDF word extraction happens only in `sdk/pdf-host.mjs`. Plugins operate purely on frozen `input.pdf` data via `sdk.pdf`.
3. **Zero permissions**:
   - All v1 manifests must specify `"permissions": []`.
4. **Synthetic fixtures only**:
   - NEVER add real bank statements, personal names, IBANs, card numbers, or account numbers anywhere in the repository.

## Data Contracts

- **v1 Canonical Dates**: All `ImportResult.transactions[].date` values use calendar-valid ISO 8601 `YYYY-MM-DD` (`1900`–`2100`, leap years checked via `sdk.dates`). Legacy Personal Ledger `DD/MM/YYYY` formatting happens only in `sdk/compat.mjs`.
- **Signed Money Strings**: All `amount` and `balance` values use normalized `.`-decimal strings (`^-?\d+(?:\.\d+)?$`), negative for debits, positive for credits. Preserve real `"0"` / `"0.00"` balances; omit `balance` when absent.
- **Raw Descriptions & Duplicates**: Never clean or categorize descriptions inside plugins, and never deduplicate identical transactions.
- **Immutable Input**: `sdk/harness.mjs` deep-freezes `ImportInput`; SDK helpers (including `sdk.pdf.groupRows`) must never mutate input structures.

## Offline Sandbox Dependency Resolution

`package.json` declares `mupdf` (`^1.28.0`) and `typescript` (`^6.0.3`) in `devDependencies` for CI (`npm ci`). Host scripts (`sdk/pdf-host.mjs`, `scripts/build-templates.mjs`) follow this resolution order so tests work in offline worktrees without `node_modules/`:

1. `process.env.PERSONAL_LEDGER_MUPDF_PATH` / `process.env.PERSONAL_LEDGER_TSC_PATH`
2. Standard `import('mupdf')` / `import('typescript')`
3. Sibling fallback in `/media/second/workspace/projects/statement-processor/node_modules`

Do not modify `/media/second/workspace/projects/statement-processor` when working in this repository.

## Commands

- `npm run build:templates` — compiles TypeScript template(s) with full diagnostic checking and emits `dist/importer.mjs`.
- `npm test` — builds templates and runs all `*.test.mjs` files under `test/`, `templates/`, and `plugins/`.
