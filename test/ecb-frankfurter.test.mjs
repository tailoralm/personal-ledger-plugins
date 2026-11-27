import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import provider from '../providers/ecb-frankfurter/index.mjs';
import manifest from '../providers/ecb-frankfurter/plugin.json' with { type: 'json' };
import fixture from '../fixtures/providers/ecb-frankfurter.json' with { type: 'json' };

const { rows, pairs, fridayRates } = fixture;
const request = { operation: 'fx', pairs, from: '05/01/2024', to: '08/01/2024' };
const normalize = (body, overrides = {}) =>
  provider.normalizeResponse({ ...request, ...overrides }, { status: 200, body });
const empty = { operation: 'fx', items: [] };

test('ECB plans use a fixed EUR basis, date bounds and a single unauthenticated route', () => {
  const plan = provider.buildRequest(request);
  const route = manifest.routes.find(({ id }) => id === plan.route);
  assert.deepEqual(manifest.authentication, []);
  assert.equal(manifest.capabilities.fx.batchSize, pairs.length);
  assert.equal(manifest.capabilities.fx.pagination, false);
  const url = new URL(route.url);
  for (const [key, value] of plan.query) url.searchParams.append(key, value);
  assert.equal(url.href,
    'https://api.frankfurter.dev/v2/providers/ecb/rates?from=2024-01-05&to=2024-01-08&base=EUR&quotes=GBP%2CUSD');
  assert.ok(plan.query.length <= 32);
  assert.ok(Buffer.byteLength(url.href) <= 8192);
  assert.doesNotThrow(() => provider.buildRequest({ ...request, from: '01/01/2024', to: '14/06/2024' }));
  assert.throws(() => provider.buildRequest({ ...request, from: '01/01/2024', to: '15/06/2024' }), /166/);
  assert.ok(166 * manifest.capabilities.fx.batchSize <= 1000);
});

test('ECB FX publishes only requested directions on each available date', () => {
  const response = normalize(JSON.stringify([...rows].reverse()));
  assert.deepEqual(response, {
    operation: 'fx',
    items: [
      ...pairs.map((pair, i) => ({
        ...pair, date: '05/01/2024', timezone: 'UTC', timestamp: '2024-01-05T00:00:00.000Z', rate: fridayRates[i],
      })),
      ...[0, 2].map((index, i) => ({
        ...pairs[index], date: '08/01/2024', timezone: 'UTC', timestamp: '2024-01-08T00:00:00.000Z',
        rate: ['1.125', '0.888888888888888889'][i],
      })),
    ],
  });
});

test('ECB FX fits a dense maximum-size window without dropping any rows', () => {
  const dense = [];
  const date = new Date('2024-01-01');
  // Model one fixing for every weekday in the maximum calendar window.
  for (let i = 0; i < 166; i++) {
    const iso = date.toISOString().slice(0, 10);
    if (date.getUTCDay() % 6 !== 0) dense.push(...rows.slice(0, 2).map(row => ({ ...row, date: iso })));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  const body = JSON.stringify(dense);
  const result = normalize(body, { from: '01/01/2024', to: '14/06/2024' });
  assert.equal(result.items.length, 120 * 6);
  assert.ok(Buffer.byteLength(body) < 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1024 * 1024);
});

test('ECB FX leaves weekends, holidays and absent currencies empty', () => {
  assert.deepEqual(normalize('[]'), empty);
  assert.deepEqual(normalize(JSON.stringify(rows.slice(0, 2)),
    { from: '06/01/2024', to: '07/01/2024' }), empty);
  assert.deepEqual(normalize(JSON.stringify([{ ...rows[0], date: '2024-01-06' }]),
    { from: '06/01/2024', to: '07/01/2024' }), empty);
  const priorFixing = [{ ...rows[0], date: '2024-12-24' }];
  assert.deepEqual(normalize(JSON.stringify(priorFixing), { from: '25/12/2024', to: '26/12/2024' }), empty);
  assert.deepEqual(normalize(JSON.stringify(rows), { pairs: [{ base: 'EUR', quote: 'JPY' }] }), empty);
  const mixed = normalize(JSON.stringify(rows), { pairs: [pairs[1], { base: 'JPY', quote: 'USD' }] });
  assert.deepEqual(mixed.items.map(row => [row.quote, row.rate]), [['GBP', '0.8']]);
});

test('ECB FX retains exact numeric tokens and rounds a derived half upward', () => {
  const precision = '[{"date":"2024-01-05","base":"EUR","quote":"USD","rate":1.234567890123456789}]';
  assert.equal(normalize(precision).items[0].rate, '1.234567890123456789');
  const halfway = '[{"date":"2024-01-05","base":"EUR","quote":"USD","rate":2},' +
    '{"date":"2024-01-05","base":"EUR","quote":"GBP","rate":5e-18}]';
  const { items } = normalize(halfway, { pairs: [pairs[1], pairs[4]] });
  assert.deepEqual(items.map(row => row.rate), ['0.000000000000000005', '0.000000000000000003']);
});

test('ECB FX coalesces identical rows and rejects conflicts, invalid data and error envelopes', () => {
  const body = JSON.stringify(rows);
  assert.deepEqual(normalize(JSON.stringify([...rows, rows[0]])), normalize(body));
  for (const bad of [
    '[', 'null', '{}', '{"status":422,"message":"invalid currency"}',
    ...[
      { rate: '1.25' }, { rate: 0 }, { rate: -1 }, { rate: 1e-19 }, { rate: 1e18 },
      { date: '2024-02-30' }, { date: '05/01/2024' }, { base: 'GBP' }, { quote: 'CAD' }, { rate: null },
    ].map(changes => JSON.stringify([{ ...rows[0], ...changes }])),
    JSON.stringify([...rows, { ...rows[0], rate: 0.9 }]),
  ]) {
    assert.deepEqual(normalize(bad), { error: 'invalid-data' }, bad);
  }
  for (const [status, expected] of [
    [302, { error: 'invalid-data' }],
    [400, { error: 'invalid-request' }],
    [401, { error: 'authentication' }],
    [403, { error: 'authentication' }],
    [404, { error: 'invalid-request' }],
    [422, { error: 'invalid-request' }],
    [408, { error: 'unavailable', retryAfterSeconds: 4 }],
    [429, { error: 'rate-limited', retryAfterSeconds: 4 }],
    [503, { error: 'unavailable', retryAfterSeconds: 4 }],
  ]) {
    assert.deepEqual(provider.normalizeResponse(request, { status, body: '{}', retryAfterSeconds: 4 }), expected);
  }
});

test('ECB FX has an immutable provider-catalog record and stays out of the importer registry', () => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../provider-catalog.json', import.meta.url)));
  const registry = fs.readFileSync(new URL('../registry.json', import.meta.url), 'utf8');
  const release = catalog.releases.find(({ id }) => id === manifest.id);
  assert.equal(release.type, manifest.type);
  assert.equal(release.tag, 'provider/' + manifest.id + '@' + manifest.version);
  assert.ok(!registry.includes(manifest.id));
});
