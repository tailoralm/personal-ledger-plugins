# personal-ledger-plugins

Bank statement importer plugin SDK v1, Draft 2020-12 JSON Schemas, reference templates, and cross-repository compatibility fixtures for Personal Ledger.

## Repository Layout

```text
registry.json                          # Deterministic unauthenticated marketplace index
schemas/
  plugin-manifest.v1.schema.json       # Plugin manifest contract
  detection-result.v1.schema.json      # Detection output contract
  import-result.v1.schema.json         # Parsed transactions, diagnostics & side investments
  registry.v1.schema.json              # Marketplace registry index contract
sdk/
  index.mjs / index.d.ts               # Pure JS SDK v1 (QuickJS/Wasm safe, zero Node imports)
  pdf-host.mjs                         # Trusted host MuPDF positioned-word extractor
  compat.mjs                           # Personal Ledger legacy Transaction / CSV adapters
  harness.mjs                          # Input freezing, plugin loading & contract validator
  pdf-fixture.mjs                      # Synthetic multi-page %PDF-1.4 fixture builder
scripts/
  lib/schema-validator.mjs             # Zero-dependency JSON Schema Draft 2020-12 validator
  lib/deterministic-zip.mjs            # Pure-Node deterministic ZIP builder & safe inspector
  lib/security-scan.mjs                # Static isolation, secret & PII leak scanner
  build-templates.mjs                  # TypeScript template compiler & diagnostic checker
  build-registry.mjs                   # Deterministic registry builder & immutability checker
  package-plugin.mjs                   # Reproducible plugin ZIP + SHA-256 packager
  ci-verify.mjs                        # Full CI verification & cross-plugin matrix pipeline
  run-tests.mjs                        # Test runner across test/, templates/, and plugins/
templates/
  javascript-importer/                 # Self-contained JS CSV importer template
  typescript-importer/                 # Strict TS PDF + CSV importer template
fixtures/
  compatibility/                       # Cross-repo compatibility cases & synthetic inputs
docs/
  plugin-api-v1.md                     # Normative Plugin API v1 specification
  creating-plugins.md                  # Step-by-step plugin authoring guide
  marketplace-and-releases.md          # Registry, CI verification & immutable release pipeline
test/
  schemas.test.mjs                     # Schema & semantic validation tests
  sdk-v1.test.mjs                      # SDK, MuPDF host, harness, compat & fixture tests
  templates.test.mjs                   # Template build, isolation & contract tests
  marketplace-ci.test.mjs              # Registry, deterministic ZIP, scanner & CI pipeline tests
```

## Quick Start

Requires Node.js `>=22.0.0`.

```bash
# Install devDependencies (mupdf, typescript)
npm ci

# Build TypeScript importer templates
npm run build:templates

# Regenerate or verify registry.json
npm run registry:build
npm run registry:check

# Run full CI verification (schemas, security/privacy, contracts, matrix, ZIPs, registry)
npm run ci:verify

# Build templates and run the full test suite
npm test
```

In offline sibling worktrees without local `node_modules/`, host tooling (`sdk/pdf-host.mjs` and `scripts/build-templates.mjs`) resolves `mupdf` and `typescript` via:

1. `PERSONAL_LEDGER_MUPDF_PATH` / `PERSONAL_LEDGER_TSC_PATH` environment overrides
2. Standard `node_modules` (`import('mupdf')` / `import('typescript')`)
3. Sibling `/media/second/workspace/projects/statement-processor/node_modules` fallback

## Documentation

- [Plugin API v1 Specification](docs/plugin-api-v1.md)
- [Creating a Bank Importer Plugin](docs/creating-plugins.md)
- [Marketplace Registry, CI Verification & Release Pipeline](docs/marketplace-and-releases.md)
- [Compatibility Fixtures Guide](fixtures/compatibility/README.md)
- [Contributing Guide](CONTRIBUTING.md)
