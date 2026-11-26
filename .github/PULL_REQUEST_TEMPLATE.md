## Summary

<!-- Describe the plugin, schema, SDK, or registry change and the target institution/format (if applicable). -->

## Privacy & Synthetic Fixtures Checklist

- [ ] **Synthetic fixtures only**: No real bank statements, personal names, real IBANs, Luhn-valid payment card numbers (PANs), account numbers, private keys, or API tokens appear anywhere in fixtures, tests, docs, or commit history.
- [ ] **Privacy & consent confirmation**: Every fixture was generated synthetically (e.g. via `sdk/pdf-fixture.mjs` or crafted fictional CSVs) or uses only approved synthetic/zero-fill/masked placeholders, and I have full rights to publish all contributed code and test data under the repository license.

## Contract, Mutual Exclusion & Versioning Checklist

- [ ] **Schema & contract validation**: `manifest.json` conforms to `schemas/plugin-manifest.v1.schema.json`, TypeScript plugins commit freshly compiled `dist/importer.mjs` artifacts, and `validatePluginContract` passes for all positive and negative fixtures.
- [ ] **Mutual rejection / cross-plugin matrix**: The plugin returns `{ matched: false, confidence: 0 }` on unrelated statements and on every other plugin's positive fixtures.
- [ ] **SemVer & `CHANGELOG.md`**: Any change to an already-published plugin bumps `manifest.version` (published versions are immutable) and includes a non-empty `## [<version>]` or `## <version>` section in `CHANGELOG.md`.

## Security Review Acknowledgement

- [ ] **Zero permissions & strict isolation**: `manifest.json` specifies `"permissions": []`; plugin code contains zero external/parent/Node imports (`node:*`, `../`, bare packages, URL schemes) and zero host globals/APIs (`process`, `Deno`, `Bun`, `Buffer`, `require`, `eval`, `Function`, `fetch`, `XMLHttpRequest`, `WebSocket`, `globalThis`, `import()`, `__dirname`, `__filename`, `fs`).
- [ ] **Review scope acknowledgement**: I understand that CI checks and maintainer code review verify sandbox isolation, schema compliance, deterministic packaging, and known leak patterns, but approval does not guarantee runtime infallibility.

## Local Verification

Run the following commands before opening or updating this PR:

```bash
npm run registry:build
npm run ci:verify
npm test
```

- [ ] `npm run registry:build` (and `registry.json` changes committed if applicable)
- [ ] `npm run ci:verify` passed
- [ ] `npm test` passed
