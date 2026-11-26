import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packageProvider } from '../scripts/package-provider.mjs';

const snapshot = process.env.PERSONAL_LEDGER_CORE_SNAPSHOT;
const fixture = name => JSON.parse(fs.readFileSync(new URL(`../fixtures/providers/${name}.json`, import.meta.url)));
const pages = fixture('pages');
const negative = fixture('negative');
const range = { from: '01/10/2026', to: '31/10/2026' };
const symbols = ['TEST.XNAS'];
const requests = {
  search: { operation: 'search', by: 'isin', query: pages.search.items[0].isin },
  metadata: { operation: 'metadata', symbols },
  quote: { operation: 'quote', symbols },
  history: { operation: 'history', symbols, ...range, basis: 'raw' },
  fx: { operation: 'fx', pairs: [{ base: 'USD', quote: 'EUR' }], ...range },
  'corporate-actions': { operation: 'corporate-actions', symbols, ...range },
};

async function coreModules() {
  const load = relative => import(pathToFileURL(path.join(snapshot, 'dist/application', `${relative}.js`)));
  const modules = await Promise.all([
    'market-data/instances', 'market-data/package', 'market-data/contract',
    'market-data/identity', 'market-data/broker', 'ledger/repository', 'plugins/sandbox',
  ].map(load));
  return Object.assign({}, ...modules);
}

const integration = (name, run) => test(name, {
  skip: snapshot ? false : 'Run npm run provider:test:core to build the pinned core snapshot',
}, run);

async function installFixture(t, name, core) {
  const folder = fileURLToPath(new URL(`../providers/${name}`, import.meta.url));
  const pkg = packageProvider(folder);
  assert.deepEqual(packageProvider(folder).bytes, pkg.bytes);
  const [folderEntries, zipEntries] = await Promise.all([
    core.readProviderSource({ kind: 'folder', directory: folder }),
    core.readProviderSource({ kind: 'zip', bytes: pkg.bytes }),
  ]);
  const inspected = await core.validateProviderPackage(folderEntries);
  assert.equal(inspected.digest, pkg.digest);
  assert.equal(core.inspectProviderPackage(zipEntries).digest, inspected.digest);
  assert.deepEqual(zipEntries, folderEntries);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-provider-test-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const repo = new core.LedgerRepository(path.join(tmp, '.ledger'));
  t.after(() => repo.close());
  const instances = new core.ProviderInstances(repo);
  await instances.install(zipEntries, pkg.digest);
  await instances.install(folderEntries, pkg.digest);
  const id = instances.create(pkg.digest, name);
  return { ...inspected, id, instances, repo };
}

integration('core validates provider manifests and both QuickJS hooks for every declared operation', async t => {
  const core = await coreModules();
  for (const name of ['synthetic-market', 'synthetic-fx']) {
    const { manifest, runtime } = await installFixture(t, name, core);
    for (const override of [
      { routes: [] },
      { routes: [{ id: 'test', url: 'http://market.example.test/v1' }] },
      { routes: [{ id: 'test', url: 'https://market.example.test/v1', credential: 'unknown' }] },
      { capabilities: {} },
      { permissions: [] },
    ]) assert.throws(() => core.validateManifest({ ...manifest, ...override }));
    if (manifest.type === 'exchange-rate-provider') {
      assert.throws(() => core.validateRequest(requests.quote, manifest), /Unsupported/);
    }

    for (const [operation, capability] of Object.entries(manifest.capabilities)) {
      const request = core.validateRequest(requests[operation], manifest);
      const runPlan = async input => core.validatePlan(
        await core.runSandbox({ ...runtime, operation: 'build-provider-request', request: input }), manifest,
      );
      const plan = await runPlan(request);
      assert.equal(plan.route, name === 'synthetic-fx' || operation === 'search' ? 'public' : 'market');
      const result = await core.runSandbox({ ...runtime, operation: 'normalize-provider-response', request,
        response: { status: 200, body: JSON.stringify(pages[operation]) } });
      assert.deepEqual(core.validateResponse(result, request, manifest), pages[operation]);

      // Exercise the declared maximum using worst-case URL encoding for each input field.
      const max = { ...request };
      if ('symbols' in max) max.symbols = Array.from({ length: capability.batchSize }, (_, i) => i + '/'.repeat(127));
      if ('pairs' in max) max.pairs = [{ base: 'USD', quote: 'EUR' }, { base: 'EUR', quote: 'USD' }];
      if (operation === 'search') Object.assign(max, { by: 'name', query: '€'.repeat(200) });
      if (capability.pagination) max.cursor = '/'.repeat(512);
      const largest = await runPlan(core.validateRequest(max, manifest));
      const url = new URL(manifest.routes.find(route => route.id === largest.route).url);
      for (const [key, value] of largest.query) url.searchParams.append(key, value);
      assert.ok(largest.query.length <= 32);
      assert.ok(Buffer.byteLength(url.href) <= 8192);
    }
  }
});

integration('broker rejects malformed pages and publishes prices only for an approved compatible mapping', async t => {
  const core = await coreModules();
  const { digest, id, instances, repo } = await installFixture(t, 'synthetic-market', core);
  const token = 'synthetic-fixture-value';
  let body;
  const broker = new core.SqliteMarketBroker(repo, async ({ beforeConnect, credential }) => {
    beforeConnect();
    assert.deepEqual(credential, { header: 'Authorization', value: `Bearer ${token}` });
    return { status: 200, body };
  });
  assert.throws(() => broker.enqueue(id, digest, requests.quote), /not approved/);
  instances.approve(id, digest, digest, 'fixture reviewer');
  instances.setCredential(id, digest, 'token', token);
  const send = async (request, payload, error) => {
    body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const { requestId } = broker.enqueue(id, digest, request);
    assert.equal(await broker.runNext(), requestId);
    const row = repo.one('SELECT state,error FROM market_requests WHERE id=?', requestId);
    assert.deepEqual([row.state, row.error], [error ? 'failed' : 'completed', error]);
    assert.equal(repo.one('SELECT credits FROM market_usage WHERE requestId=?', requestId).credits, 2);
  };
  const quote = pages.quote.items[0];
  const quotePage = (...items) => ({ operation: 'quote', items });
  for (const payload of [negative.malformedBody, negative.missingItems, negative.wrongOperation,
    negative.unsupportedCursor, quotePage(quote, quote),
    ...negative.invalidQuoteFields.map(fields => quotePage({ ...quote, ...fields }))]) {
    await send(requests.quote, payload, 'invalid-response');
  }
  await send(requests.history, { operation: 'history', items: [
    { ...pages.history.items[0], ...negative.wrongHistoryBasis },
  ] }, 'invalid-response');
  await send(requests.quote, negative.middlewareError, 'invalid-data');
  await send(requests.quote, negative.emptyPage, null);
  await send(requests.quote, pages.quote, 'observation-rejected');
  assert.equal(repo.all('SELECT * FROM market_prices').length, 0);

  const identity = new core.MarketIdentity(repo);
  const instrument = identity.createInstrument('Synthetic listing', 'equity', pages.search.items[0].isin);
  const listing = identity.createListing(instrument, 'XNAS', 'USD', 'America/New_York');
  const mappingId = identity.approveMapping({
    listingId: listing, instanceId: id, digest, symbol: symbols[0],
    from: '01/10/2026', actor: 'fixture reviewer', evidence: 'Synthetic listing ID and MIC',
  });
  await send(requests.quote, quotePage({ ...quote, currency: 'EUR' }), 'observation-rejected');
  await send(requests.quote, pages.quote, null);
  const row = repo.one('SELECT mappingId,payload FROM market_prices');
  assert.equal(row.mappingId, mappingId);
  assert.equal(JSON.parse(row.payload).price, quote.price);
});

integration('broker charges paginated and failed attempts, honors quota windows, and batches to the manifest limit', async t => {
  const core = await coreModules();
  const { digest, id, instances, repo } = await installFixture(t, 'synthetic-market', core);
  instances.approve(id, digest, digest, 'fixture reviewer');
  instances.setCredential(id, digest, 'token', 'synthetic-fixture-value');
  instances.configureQueue(id, digest, {
    limits: [{ metric: 'credits', count: 4, every: 1, unit: 'minute' }],
    concurrency: 1, timezone: 'UTC', resetTime: '00:00',
  });
  let now = Date.parse('2026-10-30T12:00:00Z');
  const dispatches = [];
  const broker = new core.SqliteMarketBroker(repo, async ({ beforeConnect, query }) => {
    beforeConnect();
    dispatches.push(query);
    const { operation, cursor } = Object.fromEntries(query);
    if (dispatches.length === 1) return { status: 429, body: '{}', retryAfterSeconds: 1 };
    const payload = operation === 'search' && !cursor ? pages.search : { operation, items: [] };
    return { status: 200, body: JSON.stringify(payload) };
  }, { now: () => now, random: () => 0 });
  const search = broker.enqueue(id, digest, requests.search);
  assert.equal(await broker.runNext(), search.requestId);
  assert.equal(await broker.runNext(), undefined);
  now += 1000;
  assert.equal(await broker.runNext(), search.requestId);
  assert.equal(await broker.runNext(), undefined);
  now += 60_000;
  assert.ok(await broker.runNext());
  assert.deepEqual(dispatches[2].find(([name]) => name === 'cursor'), ['cursor', pages.search.nextCursor]);
  assert.deepEqual(repo.all('SELECT httpStatus,credits FROM market_usage ORDER BY attemptAt,rowid')
    .map(({ httpStatus, credits }) => [httpStatus, credits]), [[429, 2], [200, 2], [200, 2]]);

  broker.enqueueBatch(id, digest, [
    { operation: 'quote', symbols: ['C', 'A'] },
    { operation: 'quote', symbols: ['B', 'A'] },
  ]);
  assert.ok(await broker.runNext());
  assert.equal(await broker.runNext(), undefined);
  now += 60_000;
  assert.ok(await broker.runNext());
  assert.deepEqual(dispatches.slice(3).map(query => query.filter(([name]) => name === 'symbol').map(([, value]) => value)),
    [['A', 'B'], ['C']]);
});
