import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { toLegacyNormalizedCsv, toLegacyTransactions } from '../../../sdk/compat.mjs';
import { loadPlugin, prepareImportInput, runDetection, runParse, validatePluginContract } from '../../../sdk/harness.mjs';
import { ERROR_CODES } from '../../../sdk/index.mjs';

const pluginDir = fileURLToPath(new URL('../', import.meta.url));
const loaded = await loadPlugin(pluginDir);
const legacyDist = process.env.PERSONAL_LEDGER_DIST;

async function fixture(name, callerOptions) {
  const bytes = await readFile(new URL(`../fixtures/${name}`, import.meta.url));
  return prepareImportInput({ fileName: name, bytes, options: callerOptions });
}

test('manifest, fixtures, and full activity match the versioned compatibility case', async () => {
  const { manifest, fixtureResults } = await validatePluginContract(pluginDir);
  assert.equal(fixtureResults.length, 3);
  const [activity] = manifest.capabilities.options;
  assert.equal(activity.id, 'includeAllActivity');
  assert.equal(activity.default, true);
  assert.equal(activity.legacyCliDefault, false);

  const input = await fixture('trading212-invest.csv');
  const result = await runParse(loaded, input);
  const { expectedImportResult } = JSON.parse(await readFile(
    new URL('../../../fixtures/compatibility/cases/07-structured-investment-evidence.json', import.meta.url),
  ));
  assert.deepEqual(result, {
    ...expectedImportResult,
    pluginId: 'eu-trading212',
    sideInvestments: expectedImportResult.sideInvestments.map(item => ({
      ...item, time: item.time.replace(/^(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1'),
    })),
  });

  const statementOnly = await runParse(loaded, await fixture('trading212-invest.csv', { includeAllActivity: false }));
  assert.deepEqual(statementOnly.transactions, result.transactions.slice(0, 2));
  assert.equal(statementOnly.diagnostics.length, 6);
  assert.deepEqual(toLegacyTransactions(statementOnly).sideInvestments, expectedImportResult.sideInvestments);
});

test('Spend preserves duplicate card rows and funding evidence and diagnoses invalid or unsupported rows', async () => {
  const result = await runParse(loaded, await fixture('trading212-spend.csv'));
  assert.deepEqual(result.transactions.map(tx => [
    tx.evidence.row, tx.description, tx.amount, tx.currency, tx.sourceId, tx.evidence.action, tx.balance,
  ]), [
    [4, 'Test Café, kiosk', '-5.25', 'EUR', undefined, 'card debit', undefined],
    [5, 'Test Café, kiosk', '-5.25', 'EUR', undefined, 'card debit', undefined],
    [6, 'Card credit', '1.75', 'GBP', 'refund-fixture', 'card credit', undefined],
    [7, 'Deposit', '30.00', '', 'deposit-fixture', 'deposit', undefined],
    [8, 'Withdrawal', '-20.00', 'USD', 'withdrawal-fixture', 'withdrawal', undefined],
  ]);
  assert.deepEqual(result.diagnostics.map(({ locator, code }) => [locator, code]), [
    ['Record 3', 'UNSUPPORTED_ACTION'],
    ['Record 9', 'INVALID_ROW'],
    ['Record 10', 'INVALID_CURRENCY'],
    ['Record 11', 'INVALID_ROW'],
    ['Record 12', 'UNSUPPORTED_ACTION'],
  ]);
});

test('Invest-only exports resolve named columns and maintain stable IDs and signed amounts', async () => {
  const input = await prepareImportInput({
    fileName: 'invest-only.csv',
    text: 'Ticker,Time (UTC),Action,Total,Currency (Total),No. of shares\n'
      + 'TEST,2026-10-01 10:00:00,Stop limit buy,10.00,USD,2\n'
      + 'TEST,2026-10-02 10:00:00,Limit sell,-4.00,USD,1\n'
      + 'TEST,2026-10-03 10:00:00,Dividend,-1.00,USD,1\n',
  });
  assert.equal((await runDetection(loaded, input)).metadata.headerMatched, true);
  const { transactions } = await runParse(loaded, input);
  assert.deepEqual(transactions.map(tx => [tx.amount, tx.sourceId]), [
    ['-10.00', 'trade:stop limit buy:2026-10-01 10:00:00|TEST|10.00|2'],
    ['4.00', 'trade:limit sell:2026-10-02 10:00:00|TEST|-4.00|1'],
    ['1.00', 'div:2026-10-03 10:00:00|TEST|-1.00|1'],
  ]);
});

test('legacy CLI mode accepts an investment-only export for the side store', async () => {
  const input = await prepareImportInput({
    fileName: 'invest-only.csv',
    text: 'Action,Time (UTC),Ticker,Total,Currency (Total)\nMarket buy,2026-10-01 10:00:00,TEST,10.00,USD\n',
    options: { statementOnly: true },
  });
  assert.equal((await runDetection(loaded, input)).matched, true);
  const result = await runParse(loaded, input);
  assert.deepEqual(result.transactions, []);
  assert.equal(result.sideInvestments.length, 1);
  assert.equal(toLegacyTransactions(result).sideInvestments[0].time, '01/10/2026 10:00:00');
  assert.equal(toLegacyNormalizedCsv(result, 'Trading212'), '');
});

test('Trading 212 and Revolut detection reject each other’s exports', async () => {
  const revolut = await loadPlugin(fileURLToPath(new URL('../../eu-revolut/', import.meta.url)));
  const fileName = 'revolut-en-multicurrency.csv';
  const bytes = await readFile(new URL(`../../eu-revolut/fixtures/${fileName}`, import.meta.url));
  const input = await prepareImportInput({ fileName, bytes });
  assert.equal((await runDetection(loaded, input)).matched, false);
  await assert.rejects(() => runParse(loaded, input), { code: ERROR_CODES.NO_TRANSACTIONS });
  assert.equal((await runDetection(revolut, await fixture('trading212-invest.csv'))).matched, false);
});

test('legacy parsers agree on transactions, evidence, side investments, and CSV in both modes', {
  skip: !legacyDist && 'Set PERSONAL_LEDGER_DIST to the built Personal Ledger dist directory',
}, async () => {
  const legacyImport = relative => import(pathToFileURL(resolve(legacyDist, relative)).href);
  const [
    { Trading212CsvParserService },
    { Trading212InvestmentsParserService },
    { statementEvidence, statementDiagnostics },
    { CsvDataService },
  ] = await Promise.all([
    legacyImport('services/csv-parser/trading212-csv-parser.service.js'),
    legacyImport('services/csv-parser/trading212-investments-parser.service.js'),
    legacyImport('model/statement-evidence.js'),
    legacyImport('services/pdf-parser/csv-data.service.js'),
  ]);
  const stripUndefined = obj => Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined));
  const bytes = await readFile(new URL('../fixtures/trading212-invest.csv', import.meta.url));
  for (const includeAllActivity of [false, true]) {
    const input = await prepareImportInput({ fileName: 'invest.csv', bytes, options: { includeAllActivity } });
    const result = await runParse(loaded, input);
    const compat = toLegacyTransactions(result);
    const text = bytes.toString('utf8');
    const legacy = new Trading212CsvParserService().parse(text, { quiet: true, includeAllActivity });
    assert.deepEqual(compat.transactions, legacy);
    assert.deepEqual(compat.evidenceByIndex, legacy.map(tx => {
      const ev = statementEvidence.get(tx);
      return stripUndefined({ ...ev, sourceId: ev.sourceId || undefined, locator: `Record ${ev.row}` });
    }));
    assert.deepEqual(compat.diagnostics, statementDiagnostics.get(legacy).map(stripUndefined));
    assert.deepEqual(compat.sideInvestments, new Trading212InvestmentsParserService().parse(text));
    assert.equal(toLegacyNormalizedCsv(result, 'Trading212'),
      new CsvDataService(legacy.map(tx => ({ ...tx, bank: 'Trading212' }))).exportToCsv());
  }
});
