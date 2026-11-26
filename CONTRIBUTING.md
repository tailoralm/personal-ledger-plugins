# Contributing to Personal Ledger Plugins

Thank you for contributing bank statement importer plugins, schemas, or fixtures to `personal-ledger-plugins`.

## Contribution Rules

### 1. Synthetic Fixtures Only (Strict Privacy Policy)

- **Never** commit real bank statements, personal IBANs, Luhn-valid payment card numbers, account numbers, private keys, API tokens, names, addresses, or real transaction exports.
- Use fictional merchants, amounts, and account IDs (or masked / zero-fill / `XX`-prefixed synthetic IBANs) in every fixture and test.
- Generate synthetic positioned PDFs using [`sdk/pdf-fixture.mjs`](sdk/pdf-fixture.mjs).

### 2. Plugin Self-Containment & Security

- Every plugin entrypoint (`importer.mjs` or compiled `dist/importer.mjs`) must be **100% self-contained**.
- **Forbidden**: `node:*` imports, npm package imports, parent-directory (`../`) imports, URL imports (`http://`, `https://`, `file://`, `data:`), dynamic `import()`, `require()`, `eval()`, `Function`, `fetch`, `XMLHttpRequest`, `WebSocket`, `globalThis`, `Buffer`, `process`, `Deno`, `Bun`, `__dirname`, `__filename`, filesystem calls, or network calls.
- `manifest.json` must declare `"permissions": []` and conform to [`schemas/plugin-manifest.v1.schema.json`](schemas/plugin-manifest.v1.schema.json).
- TypeScript plugins must use `import type` only against [`sdk/index.d.ts`](sdk/index.d.ts) and commit their compiled `dist/importer.mjs` output.

### 3. Required Plugin Package Contents

Every plugin under `plugins/<plugin-id>/` (where directory name equals `manifest.id`) must include:

- `manifest.json`
- Self-contained `.mjs` entrypoint (plus `tsconfig.json` and `src/` if authored in TypeScript)
- `README.md` and `CHANGELOG.md` (with a non-empty `## [<version>]` or `## <version>` section matching `manifest.version`)
- `fixtures/` containing valid, duplicate/zero-balance, and negative/unrelated synthetic fixtures (must also reject every other plugin's positive fixtures with `matched: false, confidence: 0`)
- `test/*.test.mjs` invoking `validatePluginContract` from [`sdk/harness.mjs`](sdk/harness.mjs)

### 4. Versioning, Registry & Verification

- Follow [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`) in `manifest.json`.
- Published versions in [`registry.json`](registry.json) and GitHub Releases are **immutable** — bump `manifest.version` and update `CHANGELOG.md` before changing any published plugin.
- Before submitting a pull request, regenerate the registry and run full CI verification:

```bash
npm run build:templates
npm run registry:build
npm run ci:verify
npm test
```

All schemas, template builds, static security/privacy checks, cross-plugin mutual-exclusion checks, reproducible ZIP packaging checks, registry sync checks, and plugin tests must pass cleanly. See [Marketplace Registry, CI Verification & Release Pipeline](docs/marketplace-and-releases.md) for full details on release tags, trust tiers, and review scope limits.
