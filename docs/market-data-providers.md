# Market data provider SDK v1

The authoritative provider contract is Personal Ledger commit `f145429702c100bdeeb5b4311b92f53db6bb0f13`, which includes the provider runtime and durable broker. The five [JSON schemas](../schemas/market-data/v1/) and [TypeScript declarations](../sdk/market-data/v1/sdk-types.ts) are byte-for-byte copies of `src/application/market-data/v1/` at that commit. The two packages in [providers](../providers/) and [pages.json](../fixtures/providers/pages.json) come from its `test/fixtures/providers/`. The [negative fixtures](../fixtures/providers/negative.json) exercise additional broker and runtime cases in this repository. [Pinned core guide](https://github.com/tailoralm/Personal-Ledger/blob/f145429702c100bdeeb5b4311b92f53db6bb0f13/docs/market-data-provider-v1.md), [Core #63](https://github.com/tailoralm/Personal-Ledger/issues/63), [Core #64](https://github.com/tailoralm/Personal-Ledger/issues/64)

See the [Yahoo Finance and Twelve Data assessment](market-data-provider-assessment.md) for the release blockers and a US daily-history alternative.
See the [EODHD and Alpha Vantage assessment](eodhd-alpha-vantage-assessment.md) for plan limits, data rights and the broker changes required for those integrations.

## Author a provider

Create a self-contained folder under `providers/` with a root `plugin.json` and an ESM entrypoint. Use `pluginApiVersion: "1"`, type `market-data-provider` for any supported combination or `exchange-rate-provider` for FX only. Specify the supported markets, exact HTTPS routes, authentication slots, and each implemented operation's page support, batch size and static credit cost. Search can accept ticker, name or ISIN. Other operations cover metadata, latest quotes, historical OHLC, FX and corporate actions according to the capabilities declared by the package.

Default-export an object with synchronous `buildRequest(request)` and `normalizeResponse(request, response)` functions. The former returns a route ID and ordered query pairs. The latter returns `{ operation, items, nextCursor? }` or a typed error. Use in-package relative modules and compile TypeScript before packaging. The declarations are compile-time imports. Each call runs in a fresh QuickJS guest with a JSON-only interface. Use opaque cursors that can be persisted safely. Test the largest declared batch with URL encoding against the 32-pair and 8,192-byte host limits.

Carry the durable upstream listing symbol and action ID where applicable. Preserve the listing's currency, unit and adjustment basis. Use day-first `DD/MM/YYYY` market dates, exact UTC timestamps with milliseconds, and IANA timezones. Normalize prices and rates to canonical decimal strings. Preserve precision through string conversion and keep an accurate distinction between raw, split-adjusted and total-return-adjusted prices. Report empty success as `items: []`, and map provider-level failure envelopes to typed errors.

Both examples use reserved `market.example.test` routes and synthetic responses that already match the canonical success format. The market example demonstrates public search, a bearer slot for its data route, all six operations and paging. The FX example demonstrates unauthenticated FX only. The example costs and quotas are synthetic. The offline tests supply every upstream response through mock transport.

## Install and configure

Use the provider backend API with a folder, ZIP, stable HTTPS ZIP URL or pinned GitHub source. Inspect via `readProviderSource` and `inspectProviderPackage`, review the manifest and expected package digest, and install with `ProviderInstances.install(entries, expectedDigest)`. Create a disabled instance. Review the candidate release's exact routes and auth slots, then approve with the current and candidate digests. A release switch requires renewed approval and clears old credentials. Review any added or changed exact hostname, path or slot before approval.

A public route needs no slot. For authenticated routes, v1 supports bearer authorization or a declared lower-case `x-` API-key header. Set each value through the host on the approved instance. Core stores values encrypted and injects them only for the route referencing the slot. Core owns HTTP dispatch, DNS and redirect safeguards, secrets, retry policy, persistence, identity, matching, scheduling and valuation. Use its durable broker for every call. Ordinary importer manifests still use `manifest.json` with `permissions: []` and their existing offline inputs and SDK.

Search and metadata yield candidates. Approve a listing-to-provider-symbol mapping for the specific instance, release and effective dates before publishing prices or actions. Core validates currency and timezone at publication. FX uses the requested currency pair. Existing investment evidence and history remain intact across installation and updates.

Recommended request and credit values initialize editable defaults. The package interval is a hint, and a new instance starts with manual scheduling. Edit concurrency, concurrent request/credit windows, timezone and reset time via `configureQueue`. Use `limits: []` for unlimited local quotas or `null` for defaults. Configure a schedule via `configureSchedule`, for example daily at local midnight, or use `null` for manual-only. Every dispatched attempt consumes one request and the operation's declared credits, including pagination and retry. Use `enqueueBatch` to combine and split compatible logical requests, and review progress and accounting with `jobStatus` and `telemetry`. [Pinned broker and schedule guide](https://github.com/tailoralm/Personal-Ledger/blob/f145429702c100bdeeb5b4311b92f53db6bb0f13/docs/market-data-provider-v1.md#durable-broker-and-schedules-64)

## Validate and prepare a release

```sh
npm test
npm run ci:verify
PERSONAL_LEDGER_CORE_SOURCE=/path/to/Personal-Ledger npm run provider:test:core
npm run provider:catalog:build
npm run provider:catalog:check
npm run provider:package -- providers/synthetic-fx
(cd dist-packages && sha256sum -c example.synthetic-fx-1.0.0.zip.sha256)
```

The core check builds two temporary source snapshots. It checks contract and fixture parity against the current core pin and runs its market and importer manager suites. The retired PDF parsers come from the separate pre-#61 oracle pin `7f39fe5bf4493c8b629680a68cdd0bc9083be298`. ActivoBank and BankInter differential tests compare against those parsers and stage through current core's installed, approved and institution-linked PluginManager. Standalone `npm test` runs the offline suite. The pinned gate runs the PDF parity tests. The original 1.0.0 importer release records retain their published artifact metadata, and 1.0.1 moves the parity checks out of package-local tests. It reuses existing core dependencies when available, or installs the locked dependencies in the snapshot. The default source path is the local sibling statement-processor checkout. CI runs the offline checks on pull requests and main, and runs the pinned core check on main when a read-only `PERSONAL_LEDGER_CORE_READ_TOKEN` is configured for the private core repository.

The deterministic packager archives all files in the provider folder and includes a checksum sidecar. Keep working files and fixtures outside that folder unless they are intended release contents. The repository packager applies its existing 64-file and 2 MiB ZIP caps. Stored ZIP entries give consistent bytes across supported Node versions. Catalog metadata includes the type, SDK version, immutable package version, tag, exact asset filename and size, ZIP SHA-256 and core package digest. The two digests cover different inputs. The SHA-256 verifies the downloaded ZIP bytes, and the core digest binds approval to the sorted package paths and file contents for either ZIP or folder installation.

Bump the manifest version when the package changes, rebuild the catalog, and retain previous catalog records. The pinned core gate rebuilds each catalog ZIP, checks its digests and loads its entrypoint in QuickJS. It uses working source for current versions and the local catalog release tag for historical versions, so keep those tags available when rebuilding a catalog with historical entries. Verify the exact ZIP and sidecar from the reviewed tag and publish those assets together under the catalog tag `provider/<id>@<version>` when authorized. Use the ZIP's explicit URL until core supports provider discovery. Keep provider entries in [provider-catalog.json](../provider-catalog.json). The existing importer release workflow and importer-only [registry.json](../registry.json) continue to serve bank importers. The synthetic catalog records describe reproducible test artifacts.
