# personal-ledger-plugins

Bank statement importer plugin SDK v1, Draft 2020-12 JSON Schemas, reference templates, and cross-repository compatibility fixtures for Personal Ledger.

## Repository Layout

```text
schemas/
  plugin-manifest.v1.schema.json      # Plugin manifest contract
  detection-result.v1.schema.json     # Detection output contract
  import-result.v1.schema.json        # Parsed transactions, diagnostics & side investments
sdk/
  index.mjs / index.d.ts              # Pure JS SDK v1 (QuickJS/Wasm safe, zero Node imports)
  pdf-host.mjs                        # Trusted host MuPDF positioned-word extractor
  compat.mjs                          # Personal Ledger legacy Transaction / CSV adapters
  harness.mjs                         # Input freezing, plugin loading & contract validator
  pdf-fixture.mjs                     # Synthetic multi-page %PDF-1.4 fixture builder
scripts/
  lib/schema-validator.mjs            # Zero-dependency JSON Schema Draft 2020-12 validator
  build-templates.mjs                 # TypeScript template compiler & diagnostic checker
  run-tests.mjs                       # Test runner across test/, templates/, and plugins/
templates/
  javascript-importer/                # Self-contained JS CSV importer template
  typescript-importer/                # Strict TS PDF + CSV importer template
fixtures/
  compatibility/                      # Cross-repo compatibility cases & synthetic inputs
docs/
  plugin-api-v1.md                    # Normative Plugin API v1 specification
  creating-plugins.md                 # Step-by-step plugin authoring guide
test/
  schemas.test.mjs                    # Schema & semantic validation tests
  sdk-v1.test.mjs                     # SDK, MuPDF host, harness, compat & fixture tests
  templates.test.mjs                  # Template build, isolation & contract tests
```

## Quick Start

Requires Node.js `>=22.0.0`.

```bash
# Install devDependencies (mupdf, typescript)
npm ci

# Build TypeScript importer templates
npm run build:templates

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
- [Compatibility Fixtures Guide](fixtures/compatibility/README.md)
- [Contributing Guide](CONTRIBUTING.md)
