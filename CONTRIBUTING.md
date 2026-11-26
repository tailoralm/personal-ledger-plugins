# Contributing to Personal Ledger Plugins

Thank you for contributing bank statement importer plugins, schemas, or fixtures to `personal-ledger-plugins`.

## Contribution Rules

### 1. Synthetic Fixtures Only (Strict Privacy Policy)

- **Never** commit real bank statements, personal IBANs, card numbers, account numbers, names, addresses, or real transaction exports.
- Use fictional merchants, amounts, and account IDs in every fixture and test.
- Generate synthetic positioned PDFs using [`sdk/pdf-fixture.mjs`](sdk/pdf-fixture.mjs).

### 2. Plugin Self-Containment & Security

- Every plugin entrypoint (`importer.mjs` or compiled `dist/importer.mjs`) must be **100% self-contained**.
- **Forbidden**: `node:*` imports, npm package imports, parent-directory (`../`) imports, dynamic `import()`, `require()`, `Buffer`, `process`, `__dirname`, `__filename`, filesystem calls, or network calls.
- `manifest.json` must declare `"permissions": []` and conform to [`schemas/plugin-manifest.v1.schema.json`](schemas/plugin-manifest.v1.schema.json).
- TypeScript plugins must use `import type` only against [`sdk/index.d.ts`](sdk/index.d.ts) and commit their compiled `dist/importer.mjs` output.

### 3. Required Plugin Package Contents

Every plugin under `plugins/<plugin-id>/` must include:

- `manifest.json`
- Self-contained `.mjs` entrypoint (plus `tsconfig.json` and `src/` if authored in TypeScript)
- `README.md` and `CHANGELOG.md`
- `fixtures/` containing valid, duplicate/zero-balance, and negative/unrelated synthetic fixtures
- `test/*.test.mjs` invoking `validatePluginContract` from [`sdk/harness.mjs`](sdk/harness.mjs)

### 4. Versioning & Verification

- Follow [Semantic Versioning](https://semver.org/) in `manifest.json`.
- Before submitting a pull request, run:

```bash
npm run build:templates
npm test
```

All schemas, template builds, isolation checks, compatibility fixtures, and plugin tests must pass cleanly.
