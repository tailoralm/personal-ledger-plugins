# Marketplace Registry, CI Verification & Release Pipeline

This document specifies how Personal Ledger bank importer plugins are indexed, verified, reproducibly packaged, released on GitHub, and safely discovered by Personal Ledger clients and MCP tooling.

---

## 1. Unauthenticated Registry Discovery

Personal Ledger discovers available plugins without requiring GitHub REST API authentication or risking unauthenticated API rate limits by fetching the committed index directly from raw GitHub content:

- **Raw Registry URL**: `https://raw.githubusercontent.com/tailoralm/personal-ledger-plugins/main/registry.json`
- **Schema**: [`schemas/registry.v1.schema.json`](../schemas/registry.v1.schema.json) (JSON Schema Draft 2020-12)

`registry.json` is generated deterministically from `plugins/*` using [`scripts/build-registry.mjs`](../scripts/build-registry.mjs) and contains no volatile timestamps (`generatedAt`), keeping diffs clean and reproducible (`npm run registry:check`).

### Top-Level Structure

- `schemaVersion`: `"1"`
- `repository`: `"tailoralm/personal-ledger-plugins"`
- `rawRegistryUrl`: `"https://raw.githubusercontent.com/tailoralm/personal-ledger-plugins/main/registry.json"`
- `plugins`: Array of plugin catalog entries sorted ascending by `id` (unique `id`s)

### Trust Tiers (`official` vs `community`)

Every registry entry carries an explicit `tier`:

- **`official`**: Maintained or directly verified by Personal Ledger maintainers (default for first-party bank importers).
- **`community`**: Contributed and maintained by community authors (default when `tier` is omitted in `manifest.json`).

Clients display the tier prominently so users can make informed installation decisions.

---

## 2. Deterministic Release URLs, Integrity & Safe Unpacking

Each published plugin version in `plugins[].versions[]` includes:

- `version`: Strict SemVer string (`MAJOR.MINOR.PATCH`)
- `pluginApiVersion`: `"1"`
- `tag`: `${id}@${version}` (e.g. `pt-activobank@1.0.0`)
- `packageFile`: `${id}-${version}.zip` (must match `^[a-z0-9-]+-\d+\.\d+\.\d+\.zip$`)
- `downloadUrl`: `https://github.com/tailoralm/personal-ledger-plugins/releases/download/${id}%40${version}/${id}-${version}.zip`
- `sourcePath`: `plugins/${id}`
- `sha256`: 64-character lowercase hex SHA-256 digest of the deterministic `.zip`
- `sizeBytes`: Exact compressed `.zip` byte length
- `changelog`: Release notes extracted from the matching `## [<version>]` or `## <version>` section in `CHANGELOG.md`

### Reproducible Packaging (`scripts/lib/deterministic-zip.mjs` & `scripts/package-plugin.mjs`)

Plugin archives are built using pure Node.js (`node:zlib`) with zero external archive tools so identical inputs always yield byte-for-byte identical `.zip` files and SHA-256 digests:

- Fixed DOS timestamp: `1980-01-01 00:00:00`
- Fixed UNIX regular file permissions: `0644`
- Sorted POSIX relative paths (code-unit order, locale-independent)
- Deterministic inclusion allowlist: `manifest.json`, `README.md`, `CHANGELOG.md`, `LICENSE*`, `importer.mjs`, `manifest.entrypoint` (plus local `./` imports), `tsconfig.json`, `dist/**`, `src/**`, `fixtures/**`, `test/**`
- Deterministic exclusions: `node_modules`, `.git`, `dist-packages`, hidden dotfiles/dotdirs, and temporary artifacts (`*.tmp`, `*.bak`, `*.log`, `*.zip`, `*.tgz`, `*.sha256`)

### Archive Safety Limits & Rejection Rules

Both ZIP generation and ZIP inspection/unpacking (`parseDeterministicZip`, `unpackDeterministicZip`) enforce strict safety checks:

- **Safe archive filename**: `^[a-z0-9-]+-\d+\.\d+\.\d+\.zip$`
- **Path safety**: Rejects `..` traversal, leading `/`, backslashes `\`, Windows drive letters (`C:`), null bytes, hidden dotfiles/dotdirs (`.` prefix), `node_modules`, and `dist-packages`
- **Symlink rejection**: Rejects symlinks during filesystem scans and rejects UNIX symlink file attributes (`0120000`) inside ZIP central directories
- **Size & entry caps**:
  - Max entries: `64`
  - Max single uncompressed file: `2 MiB` (`2 * 1024 * 1024`)
  - Max total uncompressed size: `5 MiB` (`5 * 1024 * 1024`)
  - Max compressed `.zip` size: `2 MiB` (`2 * 1024 * 1024`)
  - Compression ratio / zip-bomb guard: rejects entries exceeding `100:1` compression ratio (above 4 KiB) and caps `inflateRawSync` output strictly at `2 MiB`
- **Integrity checks**: Verifies local vs central directory metadata, uncompressed lengths, and CRC-32 checksums before extracting

Personal Ledger clients MUST verify downloaded `.zip` bytes against the registry entry's `sha256` and `sizeBytes` (and may also validate via the `.zip.sha256` release asset) before unpacking or loading a plugin.

---

## 3. Version Immutability, Manual Upgrades & Rollback

1. **Immutable Published Versions**:
   - Once `(id, version)` is recorded in `registry.json`, its `sha256`, `sizeBytes`, `packageFile`, `tag`, `downloadUrl`, `pluginApiVersion`, and `sourcePath` are immutable.
   - `npm run registry:build` / `npm run registry:check` fails if code, metadata, or docs for an already-published version change without bumping `manifest.version`.
   - `.github/workflows/release.yml` refuses to create or overwrite a release if `gh release view <tag>` already exists.
2. **Manual-Only Upgrades**:
   - Personal Ledger clients must **never** silently auto-upgrade installed plugins in the background. Users explicitly trigger updates after reviewing version changes and changelogs.
3. **Version Pinning & Rollback**:
   - `plugins[].versions[]` retains all previously published versions sorted descending by SemVer (`latestVersion` equals `versions[0].version`).
   - Users can pin a specific version or roll back to any prior immutable version at any time.

---

## 4. Security & Privacy Verification Rules

[`scripts/lib/security-scan.mjs`](../scripts/lib/security-scan.mjs) strips JS/TS comments, string literals, and regex literals accurately while preserving `${...}` template expressions, then scans plugin code, tests, docs, and fixtures (including extracted PDF text via MuPDF):

- **Forbidden imports** (outside `./` local plugin files, except TypeScript `import type` referencing `sdk/index.d.ts` or `sdk/index.js` in `.ts`/`.mts` files):
  - `node:*` built-ins, `fs`, `fs/promises`, `path`, `os`, `child_process`, `net`, `http`, `https`, `tls`, `dns`, `dgram`, `worker_threads`, `vm`, `module`, `mupdf`, `sqlite`, `node:sqlite`, parent-relative `../`, `http://`, `https://`, `file://`, `data:`, absolute paths, or bare npm packages
- **Forbidden runtime globals/APIs**:
  - `process`, `Deno`, `Bun`, `require`, `eval`, `Function`, `fetch`, `XMLHttpRequest`, `WebSocket`, `globalThis`, dynamic `import(...)`, `Buffer`, `__dirname`, `__filename`
- **Privacy & Secret Leak Rules**:
  - **Private key headers**: Rejects `-----BEGIN (RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----`
  - **API tokens**: Rejects `ghp_...`, `github_pat_...`, `sk_live_...`, and `AKIA[0-9A-Z]{16}`
  - **Payment card PANs**: Rejects 13–19 digit sequences matching payment card IIN prefixes (Visa, Mastercard, Amex, Discover, UnionPay, Diners, Maestro) that pass Luhn validation (all-zero and masked `****`/`XXXX` placeholders are allowed)
  - **Personal IBANs**: Rejects MOD-97 valid IBANs unless clearly synthetic/placeholder:
    - Country code `XX` or `ZZ`
    - All-zero BBAN (`^[A-Z]{2}\d{2}0+$`) or repeating single-digit BBAN
    - Explicit placeholder markers (`TEST`, `FAKE`, `DEMO`, `SYNTH`, `EXAMPLE`, `DUMMY`) in the BBAN

---

## 5. Contributor PR & Release Workflow

1. **Fork & Scaffold**: Fork `tailoralm/personal-ledger-plugins` and scaffold `plugins/<plugin-id>/` from `templates/javascript-importer` or `templates/typescript-importer`.
2. **Author Synthetic Fixtures & Tests**:
   - Include positive fixtures (with credits, debits, duplicates, zero balances, diagnostics) and negative unrelated fixtures under `fixtures/`.
   - Add `test/*.test.mjs` calling `validatePluginContract` from `sdk/harness.mjs`.
   - Ensure `README.md` and `CHANGELOG.md` (with `## [<version>]` or `## <version>`) are present.
3. **Update Registry & Verify Locally**:
   ```bash
   npm run registry:build
   npm run ci:verify
   npm test
   ```
   If authoring in TypeScript, run `npm run build:templates` (or `tsc`) and commit `dist/importer.mjs` alongside `src/`.
4. **Open Pull Request**: Complete every item in [`.github/PULL_REQUEST_TEMPLATE.md`](../.github/PULL_REQUEST_TEMPLATE.md).
5. **CI & Maintainer Review**: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs `npm run ci:verify` and `npm test` on Node 22 and Node 24, verifying schema compliance, isolation, privacy rules, cross-plugin mutual exclusion, deterministic packaging, unpacked ZIP execution, and registry synchronization.
6. **Tag & Release**: After merging to `main`, a maintainer tags `<plugin-id>@<version>` (e.g. `pt-activobank@1.0.0`). [`.github/workflows/release.yml`](../.github/workflows/release.yml) re-verifies CI/tests, builds the deterministic `.zip` and `.zip.sha256`, confirms the SHA-256 matches `registry.json`, verifies no release already exists for that tag, and publishes the GitHub Release.

---

## 6. Provenance and Code-Review Limits

Automated CI verification and maintainer code review provide defense-in-depth, **not a guarantee of absolute security**:

- Static scanning catches known forbidden imports, globals, secrets, and real PAN/IBAN patterns, and contract verification validates behavior against synthetic fixtures.
- Code review confirms manifest accuracy, mutual-exclusion detection, and clean parsing logic, **but reviewers can miss subtle logic flaws, obfuscation, or unexpected edge cases**.
- Approval in this repository **does not** eliminate the need for runtime sandboxing: Personal Ledger hosts MUST execute plugins inside an isolated sandbox (QuickJS/Wasm or equivalent non-privileged runtime) with `"permissions": []`, deep-frozen `ImportInput`, host-only MuPDF extraction, and strict memory/timeout enforcement.
- Users should verify the plugin `tier` (`official` vs `community`), inspect source changes and changelogs when upgrading, and install only plugins from institutions they trust.

---

## 7. Reusable APIs for Personal Ledger & MCP Discovery

The following modules and schemas are exported for reuse by Personal Ledger's marketplace client, verification tooling, and MCP server discovery:

- [`schemas/registry.v1.schema.json`](../schemas/registry.v1.schema.json) — Draft 2020-12 JSON Schema for `registry.json`
- [`scripts/lib/schema-validator.mjs`](../scripts/lib/schema-validator.mjs) — `validateRegistrySemantics`, `validateManifestSemantics`, `compareSemVer`
- [`scripts/lib/deterministic-zip.mjs`](../scripts/lib/deterministic-zip.mjs) — `buildDeterministicZip`, `parseDeterministicZip`, `unpackDeterministicZip`, `validateArchiveFileName`, `validateArchiveEntryPath`, `ZIP_LIMITS`
- [`scripts/lib/security-scan.mjs`](../scripts/lib/security-scan.mjs) — `scanPluginDirectory`, `scanSourceText`, `scanPrivacyAndSecrets`
- [`scripts/package-plugin.mjs`](../scripts/package-plugin.mjs) — `packagePlugin`
- [`scripts/build-registry.mjs`](../scripts/build-registry.mjs) — `buildRegistry`, `extractChangelogSection`
- [`scripts/ci-verify.mjs`](../scripts/ci-verify.mjs) — `runCiVerification`, `runCrossPluginDetectionMatrix`
