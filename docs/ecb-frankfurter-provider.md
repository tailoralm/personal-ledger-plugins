# ECB reference rates via Frankfurter

Provider ID **org.personal-ledger.ecb-frankfurter**, version **1.0.0**, implements FX only. It supports all six directions among EUR, USD and GBP, with USD and GBP reference series starting on 4 January 1999. The ECB usually publishes around 16:00 CET on working days except TARGET closing days. Rates are daily reference observations for information. The ECB strongly discourages using them to execute transactions. Frankfurter's public API can be delayed, is rate-limited against abuse, and offers no uptime guarantee or fixed public request quota. [ECB reference rates](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html), [ECB historical series](https://data.ecb.europa.eu/data/datasets/EXR), [Frankfurter API](https://frankfurter.dev/)

## Build and install

From the plugins repository, build the ZIP and verify the checksum sidecar.

```sh
npm run provider:package -- providers/ecb-frankfurter
cd dist-packages
unzip -l org.personal-ledger.ecb-frankfurter-1.0.0.zip
sha256sum -c org.personal-ledger.ecb-frankfurter-1.0.0.zip.sha256
```

The ZIP has a root `plugin.json` and `index.mjs`. Compare the ZIP SHA-256 and package digest with the version's entry in the [provider catalog](../provider-catalog.json). The catalog tag identifies the intended release. The ZIP can be built locally from this source.

Use the provider backend API in the Personal Ledger host. The following assumes `zipBytes` contains the verified local ZIP and `repo` is the open host ledger repository. Use the reviewed digest from the catalog as `expectedDigest`.

```js
const entries = await readProviderSource({ kind: 'zip', bytes: zipBytes });
const { manifest, digest } = inspectProviderPackage(entries);
if (digest !== expectedDigest) throw new Error('Unexpected ECB FX package digest.');

const instances = new ProviderInstances(repo);
await instances.install(entries, expectedDigest);
const id = instances.create(digest, 'ECB reference rates');
```

The instance starts disabled. Review `manifest.routes` and `manifest.authentication`. The sole permission is an exact GET to `https://api.frankfurter.dev/v2/providers/ecb/rates`. The provider asks for explicit inclusive `from` and `to` dates, `base=EUR` and `quotes=GBP,USD`. It uses the ECB-specific endpoint exclusively and requires no key, guest-supplied headers or redirect. After human review approve with `instances.approve(id, digest, digest, actor)`, where `actor` identifies the reviewer. Core binds approval to the release and executes all HTTP and publication. [Provider SDK](market-data-providers.md), [Pinned core backend guide](https://github.com/tailoralm/Personal-Ledger/blob/f145429702c100bdeeb5b4311b92f53db6bb0f13/docs/market-data-provider-v1.md), [Frankfurter methodology](https://frankfurter.dev/methodology/)

## Historical and latest available rates

Pass uppercase ISO currency codes and inclusive `DD/MM/YYYY` date bounds to the host broker. Each request may contain up to six distinct directed pairs. Set `rangeDays: 166` when submitting through `enqueueBatch` so core splits longer requests into consecutive windows. Use `enqueue` only for ranges of 166 days or fewer. Longer unsplit requests fail before dispatch. The provider has no cursor and never truncates. At most 996 canonical rows fit in one page, even with all six directions populated every calendar day. The two upstream series and bounded decimal fields keep normal responses below the 1 MiB caps.

```js
const broker = new SqliteMarketBroker(repo);
const { jobId } = broker.enqueueBatch(id, digest, [{
  operation: 'fx',
  pairs: [{ base: 'USD', quote: 'GBP' }],
  from: '01/01/2024',
  to: '31/12/2024',
}], { rangeDays: 166, priority: 'backfill' });
```

Use `broker.jobStatus(jobId)` to check work while the host runtime drains the queue. Core v1 uses the same FX operation for latest and historical queries. For latest available, compute today in the ECB's local time zone (`Europe/Berlin`) and request today and the preceding six calendar days. After the job succeeds, select the greatest publication date returned or persisted for that pair and approved release within the window. An empty window means no observation is available in that window. Unavailable currencies and dates yield no observation. The normalizer drops out-of-range observations, including prior fixings Frankfurter may return for a weekend or TARGET holiday.

For historical transaction validation, core should use an available observation for the intended historical date from the approved provider. Keep the rate unavailable when that date has no observation. Today's value, a bank's transaction execution rate, and another day's reference rate each describe a different observation. The pinned backend exposes the ingestion path for core [#63](https://github.com/tailoralm/Personal-Ledger/issues/63). Downstream historical matching [#66](https://github.com/tailoralm/Personal-Ledger/issues/66) and historical valuation and reporting [#69](https://github.com/tailoralm/Personal-Ledger/issues/69) can use this path with their own date and source selection.

## Local quotas and scheduling

The manifest recommends six requests per rolling minute, 120 credits per day and a 1,440-minute refresh interval. Each attempted HTTP call costs one local credit, including retries. These are editable local limits and do not represent an upstream entitlement. Core initializes concurrency to one and reserves 10% of default daily credits for non-backfill work. To set explicit limits and a Frankfurt-local midnight reset after approval, call the backend with the same instance ID and digest.

```js
instances.configureQueue(id, digest, {
  limits: [
    { metric: 'requests', count: 6, every: 1, unit: 'minute' },
    { metric: 'credits', count: 120, every: 1, unit: 'day', reserve: 12 },
  ],
  concurrency: 1,
  timezone: 'Europe/Berlin',
  resetTime: '00:00',
});
```

Edit the counts, windows, reserve or concurrency by resubmitting that configuration. Pass `null` to restore queue defaults. Quotas apply per instance and do not count traffic from other workspaces or applications. Use `broker.telemetry(id)` to inspect throttling and cooldown. Core handles transient failures and Retry-After. Invalid JSON, malformed rate rows, conflicting in-window duplicates and provider errors in successful HTTP envelopes fail the page. Equal observations for one date and currency collapse. Permanent HTTP errors and redirects fail at the broker.

Keep the built-in schedule manual-only with `broker.configureSchedule(id, digest, null)`. A host-managed daily job can compute the rolling window each day and submit it with `priority: 'daily'` after the usual ECB update, for example at 18:00 `Europe/Berlin`. Allow for delayed publication and upstream cache lag. The backend `configureSchedule(id, digest, { everyDays, time, timezone, requests, rangeDays })` repeats the same literal dates in `requests` and is appropriate only when intentionally re-fetching a fixed historical range. Release changes require review and schedule reconfiguration.

## Precision, provenance and attribution

The ECB publishes EUR-based reference rates. A direct EUR→USD or EUR→GBP observation preserves the numeric value of the decimal token Frankfurter delivers and uses the SDK's canonical spelling. The feed sends JSON numbers with source-dependent decimal precision and no significant-digit or trailing-zero metadata. For a reversed EUR pair, divide one by the same-day EUR rate. For a USD/GBP cross, divide the same-day EUR-to-quote rate by the EUR-to-base rate. Both calculations use integers and round half up to 18 fractional digits, then remove trailing zeros. Those additional digits express arithmetic precision. A missing leg leaves that direction unavailable for the day.

The actual upstream publication day is carried in `date`. Frankfurter's row has day precision. The `timestamp` is a nominal UTC midnight on that day and `timezone` is `UTC` for SDK validation. The timestamp encodes a date and has no intraday publication meaning. Core records fetch time separately. The v1 FX item supports `base`, `quote`, `date`, `timezone`, `timestamp` and `rate`. Core stores the provider instance, release digest and request linkage. With this release, EUR as base means a direct source value, EUR as quote means an inverse, and all other emitted pairs are EUR-derived crosses.

Use “Source: ECB statistics (euro foreign exchange reference rates), via Frankfurter” when displaying or redistributing the direct rates. Explicitly label inverse and cross results as calculations derived from the ECB EUR reference rates. The ESCB reuse policy permits commercial and non-commercial reuse of public unmodified statistics with attribution. The ECB copyright notice also requires accurate reproduction, explicit disclosure of modifications and disclosure in sold materials that the original information is freely available, before payment and whenever it is accessed. Frankfurter software is MIT-licensed, and the ECB data retains ECB terms. [ECB statistics reuse policy](https://www.ecb.europa.eu/stats/ecb_statistics/governance_and_quality_framework/html/usage_policy.en.html), [ECB disclaimer and copyright](https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html), [Frankfurter license and terms](https://frankfurter.dev/license/)
