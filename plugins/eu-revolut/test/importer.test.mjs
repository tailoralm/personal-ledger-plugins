import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ERROR_CODES, ImporterError, createImporterSdk } from '../../../sdk/index.mjs';
import { toLegacyNormalizedCsv, toLegacyTransactions } from '../../../sdk/compat.mjs';
import {
  SCHEMAS,
  assertPluginIsolation,
  loadPlugin,
  prepareImportInput,
  runDetection,
  runParse,
  validatePluginContract,
} from '../../../sdk/harness.mjs';
import { parseDeterministicZip, unpackDeterministicZip } from '../../../scripts/lib/deterministic-zip.mjs';
import { validateManifestSemantics } from '../../../scripts/lib/schema-validator.mjs';
import { scanPluginDirectory } from '../../../scripts/lib/security-scan.mjs';
import { packagePlugin } from '../../../scripts/package-plugin.mjs';

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_DIR = path.resolve(PLUGIN_DIR, '../..');
const ACTIVOBANK_DIR = path.join(ROOT_DIR, 'plugins/pt-activobank');
const BANKINTER_DIR = path.join(ROOT_DIR, 'plugins/pt-bankinter');
const STATEMENT_PROCESSOR_DIST = process.env.PERSONAL_LEDGER_DIST;

function doubleEncodeUtf8(cleanText) {
  return Buffer.from(Buffer.from(cleanText, 'utf8').toString('latin1'), 'utf8');
}

test('eu-revolut passes manifest schema, isolation, security scan, and full contract validation', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'manifest.json'), 'utf8'));
  validateManifestSemantics(manifest, SCHEMAS.manifest);
  assert.equal(manifest.id, 'eu-revolut');
  assert.equal(manifest.name, 'Revolut');
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.tier, 'official');
  assert.equal(manifest.institution.id, 'revolut');
  assert.equal(manifest.institution.country, 'EU');
  assert.deepEqual(manifest.institution.legacyNames, ['Revolut']);
  assert.deepEqual(manifest.formats, ['csv']);
  assert.deepEqual(manifest.extensions, ['.csv']);
  assert.deepEqual(manifest.permissions, []);
  assert.equal(manifest.capabilities.supportsRunningBalance, true);
  assert.equal(manifest.capabilities.supportsSourceIds, true);
  assert.equal(manifest.capabilities.supportsMultiCurrency, true);
  assert.equal(manifest.capabilities.supportsYearInference, false);
  assert.equal(manifest.capabilities.supportsInvestments, false);

  const loaded = await loadPlugin(PLUGIN_DIR);
  assertPluginIsolation(loaded.entrypointPath, PLUGIN_DIR);

  const scan = await scanPluginDirectory(PLUGIN_DIR);
  assert.equal(scan.ok, true, JSON.stringify(scan.errors));

  const { fixtureResults } = await validatePluginContract(PLUGIN_DIR);
  assert.equal(fixtureResults.length, 4);
  assert.deepEqual(
    fixtureResults.map(item => [item.fileName, item.kind, item.detection.matched]),
    [
      ['negative-savings-only.csv', 'negative', false],
      ['negative-unrelated.csv', 'negative', false],
      ['revolut-en-multicurrency.csv', 'positive', true],
      ['revolut-pt-mojibake.csv', 'positive', true],
    ],
  );
});

test('eu-revolut repairs double-encoded UTF-8 mojibake, parses quoted fields, CRLF, Poupanca diagnostics, and 0.00 balance', async () => {
  const loaded = await loadPlugin(PLUGIN_DIR);
  const bytes = fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures/revolut-pt-mojibake.csv'));
  const input = await prepareImportInput({
    fileName: 'revolut-pt-mojibake.csv',
    bytes,
    limits: loaded.manifest.limits,
  });

  const detection = await runDetection(loaded, input);
  assert.equal(detection.matched, true);
  assert.equal(detection.confidence, 0.98);
  assert.equal(detection.format, 'csv');
  assert.equal(detection.institutionId, 'revolut');
  assert.deepEqual(detection.metadata, { transactionCount: 3, headerMatched: true });

  const result = await runParse(loaded, input);
  assert.equal(result.pluginId, 'eu-revolut');
  assert.equal(result.institutionId, 'revolut');
  assert.equal(result.transactions.length, 3);
  assert.deepEqual(
    result.transactions.map(t => [t.date, t.description, t.amount, t.currency, t.balance, t.sourceId, t.evidence]),
    [
      [
        '2026-09-01',
        'Depósito, Salário',
        '100.00',
        'EUR',
        '100.00',
        'rev-pt-1',
        {
          row: 2,
          locator: 'Record 2',
          rawDate: '2026-09-01 08:01:00',
          rawAmount: '100.00',
          runningBalance: '100.00',
        },
      ],
      [
        '2026-09-02',
        'Café Central',
        '-15.50',
        'EUR',
        '84.50',
        'rev-pt-2',
        {
          row: 3,
          locator: 'Record 3',
          rawDate: '2026-09-02 09:16:00',
          rawAmount: '-15.50',
          runningBalance: '84.50',
        },
      ],
      [
        '2026-09-03',
        'Padaria São João',
        '-84.50',
        'EUR',
        '0.00',
        'rev-pt-3',
        {
          row: 4,
          locator: 'Record 4',
          rawDate: '2026-09-03 11:31:00',
          rawAmount: '-84.50',
          runningBalance: '0.00',
        },
      ],
    ],
  );

  assert.deepEqual(result.diagnostics, [
    {
      locator: 'Record 5',
      code: 'FILTERED_PRODUCT',
      severity: 'info',
      reason: 'Product outside Atual/Current',
      date: '2026-09-04',
      rawDate: '2026-09-04 10:00:00',
      description: 'Cofre Férias',
      value: '-50.00 EUR',
    },
  ]);

  // Pre-populated mojibake input.text is still repaired via input.bytes
  const preTextMojibake = bytes.toString('utf8');
  const preTextInput = await prepareImportInput({
    fileName: 'pre-text.csv',
    bytes,
    text: preTextMojibake,
  });
  const preTextResult = await runParse(loaded, preTextInput);
  assert.deepEqual(preTextResult.transactions.map(t => t.description), [
    'Depósito, Salário',
    'Café Central',
    'Padaria São João',
  ]);
});

test('eu-revolut parses reordered English headers, multi-currency, duplicate identical rows, 0.00 balance, and row diagnostics', async () => {
  const loaded = await loadPlugin(PLUGIN_DIR);
  const bytes = fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures/revolut-en-multicurrency.csv'));
  const input = await prepareImportInput({
    fileName: 'revolut-en-multicurrency.csv',
    bytes,
    limits: loaded.manifest.limits,
  });

  const detection = await runDetection(loaded, input);
  assert.equal(detection.matched, true);
  assert.equal(detection.confidence, 0.98);
  assert.deepEqual(detection.metadata, { transactionCount: 5, headerMatched: true });

  const result = await runParse(loaded, input);
  assert.equal(result.transactions.length, 5);
  assert.deepEqual(
    result.transactions.map(t => [t.date, t.description, t.amount, t.currency, t.balance, t.sourceId, t.evidence.row]),
    [
      ['2026-08-05', 'Top Up', '10.00', 'EUR', '10.00', 'rev-en-1', 2],
      ['2026-08-06', 'Cafe', '-5.00', 'EUR', '5.00', 'rev-en-2', 3],
      ['2026-08-06', 'Cafe', '-5.00', 'EUR', '0.00', 'rev-en-3', 4],
      ['2026-08-07', 'Cloud Service', '-12.34', 'USD', '87.66', 'rev-en-4', 5],
      ['2026-08-08', 'Refund London Shop', '25.50', 'GBP', '25.50', 'rev-en-5', 6],
    ],
  );

  assert.deepEqual(result.diagnostics, [
    {
      locator: 'Record 7',
      code: 'FILTERED_PRODUCT',
      severity: 'info',
      reason: 'Product outside Atual/Current',
      date: '2026-08-09',
      rawDate: '2026-08-09 10:00:00',
      description: 'Vault Deposit',
      value: '-20.00 EUR',
    },
    {
      locator: 'Record 8',
      code: 'INVALID_ROW',
      severity: 'warning',
      reason: 'Missing or invalid date, description, or amount',
      date: '2026-02-30',
      rawDate: '2026-02-30 12:00:00',
      description: 'Bad Calendar Date',
      value: '1.00 EUR',
    },
    {
      locator: 'Record 9',
      code: 'INVALID_ROW',
      severity: 'warning',
      reason: 'Missing or invalid date, description, or amount',
      date: '2026-08-10',
      rawDate: '2026-08-10 11:00:00',
      value: '-3.00 EUR',
    },
    {
      locator: 'Record 10',
      code: 'INVALID_ROW',
      severity: 'warning',
      reason: 'Missing or invalid date, description, or amount',
      date: '2026-08-11',
      rawDate: '2026-08-11 12:00:00',
      description: 'Broken Amount',
      value: 'invalid EUR',
    },
  ]);

  const legacy = toLegacyTransactions(result);
  assert.equal(legacy.transactions[2].balance, '0.00');
  assert.equal(legacy.evidenceByIndex[2].runningBalance, '0.00');
  assert.equal(legacy.diagnostics[1].date, '2026-02-30');
});

test('eu-revolut handles semicolon/tab delimiters, BOM, Latin-1 bytes, escaped quotes/newlines, headerless fallback, omitted currency/balance/ID, and edge cases', async () => {
  const loaded = await loadPlugin(PLUGIN_DIR);

  // 1. Semicolon delimiter + UTF-8 BOM + escaped quotes + multiline description + leap-year Feb 29 + preamble rows + Transaction ID + Moeda + Saldo + "0" balance
  const semiCsv = '\uFEFFStatement Export\r\nGenerated Synthetic\r\n'
    + 'Produto;Data de conclusão (UTC);Descrição;Montante;Moeda;Saldo;Transaction ID\r\n'
    + 'Atual;2024-02-29T09:30:00Z;"Café ""Central""\nLisboa";"-12,50";eur;"0";tx-leap-1\r\n'
    + 'Atual;2025-02-29 10:00:00;Invalid Non-Leap;-5.00;EUR;10.00;tx-bad-leap\r\n'
    + 'Atual;2026-08-12 10:00:00;Bad Currency Row;-1.00;EURO;9.00;tx-bad-cur\r\n'
    + 'Atual;2026-08-13 10:00:00;Unparseable Balance Row;20.00;EUR;N/A;tx-bad-bal\r\n';

  const semiInput = await prepareImportInput({ fileName: 'semi.csv', text: semiCsv });
  const semiDet = await runDetection(loaded, semiInput);
  assert.equal(semiDet.matched, true);
  assert.equal(semiDet.confidence, 0.98);
  const semiRes = await runParse(loaded, semiInput);
  assert.equal(semiRes.transactions.length, 2);
  assert.deepEqual(semiRes.transactions[0], {
    date: '2024-02-29',
    description: 'Café "Central"\nLisboa',
    amount: '-12.50',
    currency: 'EUR',
    balance: '0',
    sourceId: 'tx-leap-1',
    evidence: {
      row: 4,
      locator: 'Record 4',
      rawDate: '2024-02-29T09:30:00Z',
      rawAmount: '-12,50',
      runningBalance: '0',
    },
  });
  // Unparseable non-empty balance preserves evidence.runningBalance without emitting invalid tx.balance
  assert.equal('balance' in semiRes.transactions[1], false);
  assert.equal(semiRes.transactions[1].evidence.runningBalance, 'N/A');
  assert.deepEqual(
    semiRes.diagnostics.map(d => [d.code, d.date]),
    [
      ['INVALID_ROW', '2025-02-29'],
      ['INVALID_CURRENCY', '2026-08-12'],
    ],
  );

  // 2. Tab delimiter + Currency (Total) alias + omitted balance/ID + Latin-1 bytes
  const latin1Str = 'Product\tCompleted Date\tDescription\tAmount\tCurrency (Total)\n'
    + 'Current\t2026-08-14 08:00:00\tPadaria São João\t-30\t\n'
    + 'Current\t2026-08-15 09:00:00\tTokyo Metro\t-1500\tJPY\n';
  const latin1Bytes = Buffer.from(latin1Str, 'latin1');
  const tabInput = await prepareImportInput({ fileName: 'tab-latin1.csv', bytes: latin1Bytes });
  const tabRes = await runParse(loaded, tabInput);
  assert.equal(tabRes.transactions.length, 2);
  assert.equal(tabRes.transactions[0].description, 'Padaria São João');
  assert.equal(tabRes.transactions[0].amount, '-30');
  assert.equal(tabRes.transactions[0].currency, '');
  assert.equal('balance' in tabRes.transactions[0], false);
  assert.equal('runningBalance' in tabRes.transactions[0].evidence, false);
  assert.equal('sourceId' in tabRes.transactions[0], false);
  assert.equal(tabRes.transactions[1].currency, 'JPY');

  // 3. Headerless / unrecognized header legacy column-order fallback (confidence 0.85)
  const fallbackCsv = [
    'Col0,Col1,Col2,Col3,Col4,Col5,Balance,ID',
    'Card,Atual,2026-08-16 09:00:00,2026-08-16 09:01:00,Mercado Bairro,-14.20,85.80,fb-1',
  ].join('\n');
  const fbInput = await prepareImportInput({ fileName: 'fallback.csv', text: fallbackCsv });
  const fbDet = await runDetection(loaded, fbInput);
  assert.equal(fbDet.matched, true);
  assert.equal(fbDet.confidence, 0.85);
  assert.deepEqual(fbDet.metadata, { transactionCount: 1, headerMatched: false });
  const fbRes = await runParse(loaded, fbInput);
  assert.equal(fbRes.transactions.length, 1);
  assert.equal(fbRes.transactions[0].description, 'Mercado Bairro');
  assert.equal(fbRes.transactions[0].amount, '-14.20');
  assert.equal(fbRes.transactions[0].currency, '');
  assert.equal(fbRes.transactions[0].balance, '85.80');
  assert.equal(fbRes.transactions[0].sourceId, 'fb-1');
});

test('eu-revolut passes cross-repository compatibility fixture cases 01, 03, 04, and 06', async () => {
  const loaded = await loadPlugin(PLUGIN_DIR);
  const sdk = createImporterSdk();
  const compatDir = path.join(ROOT_DIR, 'fixtures/compatibility');
  const casesDir = path.join(compatDir, 'cases');

  // Case 01: valid parse + mojibake + diagnostics + legacy normalized CSV
  const case01 = JSON.parse(fs.readFileSync(path.join(casesDir, '01-valid-parse-and-mojibake.json'), 'utf8'));
  const case01Bytes = fs.readFileSync(path.join(compatDir, case01.inputFile));
  const case01Input = await prepareImportInput({ fileName: path.basename(case01.inputFile), bytes: case01Bytes });
  const case01Det = await runDetection(loaded, case01Input, sdk);
  assert.equal(case01Det.matched, true);
  assert.equal(case01Det.confidence, 0.98);
  const case01Res = await runParse(loaded, case01Input, sdk);
  assert.deepEqual(case01Res.transactions, case01.expectedImportResult.transactions);
  assert.deepEqual(case01Res.diagnostics, case01.expectedImportResult.diagnostics);
  assert.equal(toLegacyNormalizedCsv(case01Res, 'Revolut'), case01.expectedLegacyNormalizedCsv);

  // Case 03 & 04: duplicate identical rows + real 0.00 balance in Revolut format
  const case03 = JSON.parse(fs.readFileSync(path.join(casesDir, '03-duplicate-identical-rows.json'), 'utf8'));
  const case04 = JSON.parse(fs.readFileSync(path.join(casesDir, '04-real-zero-balance.json'), 'utf8'));
  const dupRevolutCsv = [
    'Product,Completed Date,Description,Amount,Currency,Balance,ID',
    ...case03.expectedRows.map(r =>
      `Current,${r.date} 09:15:00,${r.description},${r.amount},${r.currency},${r.balance},${r.sourceId}`,
    ),
  ].join('\n');
  const dupInput = await prepareImportInput({ fileName: 'dup-revolut.csv', text: dupRevolutCsv });
  const dupRes = await runParse(loaded, dupInput, sdk);
  assert.equal(dupRes.transactions.length, case03.expectedTransactionCount);
  assert.deepEqual(
    dupRes.transactions.map(({ date, description, amount, currency, balance, sourceId, evidence }) => ({
      date, description, amount, currency, balance, sourceId, row: evidence.row, runningBalance: evidence.runningBalance,
    })),
    case04.expectedImportResult.transactions.map(({ date, description, amount, currency, balance, sourceId, evidence }) => ({
      date, description, amount, currency, balance, sourceId, row: evidence.row, runningBalance: evidence.runningBalance,
    })),
  );
  const dupLegacy = toLegacyTransactions(dupRes);
  assert.equal(dupLegacy.transactions[1].balance, case04.expectedLegacyZeroBalance);
  assert.equal(dupLegacy.evidenceByIndex[1].runningBalance, case04.expectedLegacyZeroBalance);

  // Case 06: multi-currency (JPY, USD) and empty currency when omitted
  const case06 = JSON.parse(fs.readFileSync(path.join(casesDir, '06-multi-and-empty-currency.json'), 'utf8'));
  const multiRevolutCsv = [
    'Product,Completed Date,Description,Amount,Currency',
    ...case06.expectedImportResult.transactions.map(t =>
      `Current,${t.date},${t.description},${t.amount},${t.currency}`,
    ),
  ].join('\n');
  const multiInput = await prepareImportInput({ fileName: 'multi-cur.csv', text: multiRevolutCsv });
  const multiRes = await runParse(loaded, multiInput, sdk);
  assert.deepEqual(
    multiRes.transactions.map(({ date, description, amount, currency, evidence }) => ({
      date, description, amount, currency, row: evidence.row, rawAmount: evidence.rawAmount,
    })),
    case06.expectedImportResult.transactions.map(({ date, description, amount, currency, evidence }) => ({
      date, description, amount, currency, row: evidence.row, rawAmount: evidence.rawAmount,
    })),
  );
  const multiLegacy = toLegacyTransactions(multiRes);
  assert.deepEqual(multiLegacy.evidenceByIndex.map(e => e.currency), case06.expectedLegacyCurrencies);
  assert.equal(multiLegacy.transactions[0].balance, '');
});

test('eu-revolut rejects negative, empty, malformed, Trading212, and PDF inputs cleanly and enforces cross-plugin mutual exclusion', async () => {
  const loaded = await loadPlugin(PLUGIN_DIR);

  const negativeCases = [
    ['negative-savings-only.csv', fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures/negative-savings-only.csv')), ERROR_CODES.NO_TRANSACTIONS],
    ['negative-unrelated.csv', fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures/negative-unrelated.csv')), ERROR_CODES.NO_TRANSACTIONS],
    ['compat-negative.csv', fs.readFileSync(path.join(ROOT_DIR, 'fixtures/compatibility/inputs/negative-unrelated.csv')), ERROR_CODES.NO_TRANSACTIONS],
    ['compat-trading212.csv', fs.readFileSync(path.join(ROOT_DIR, 'fixtures/compatibility/inputs/trading212-full-activity.csv')), ERROR_CODES.NO_TRANSACTIONS],
    ['compat-duplicates.csv', fs.readFileSync(path.join(ROOT_DIR, 'fixtures/compatibility/inputs/duplicates-and-zero.csv')), ERROR_CODES.NO_TRANSACTIONS],
    ['compat-negative.pdf', fs.readFileSync(path.join(ROOT_DIR, 'fixtures/compatibility/inputs/negative-unrelated.pdf')), ERROR_CODES.UNSUPPORTED_FORMAT],
    ['bom-only.csv', Buffer.from('\uFEFF   \r\n  ', 'utf8'), ERROR_CODES.EMPTY_INPUT],
    ['bad-quotes.csv', Buffer.from('Product,Completed Date,Description,Amount\nCurrent,2026-08-01,"unclosed,10\n', 'utf8'), ERROR_CODES.INVALID_STATEMENT],
  ];

  for (const [fileName, bytes, expectedCode] of negativeCases) {
    const input = await prepareImportInput({ fileName, bytes, limits: loaded.manifest.limits });
    const detection = await runDetection(loaded, input);
    assert.equal(detection.matched, false, `Expected non-match for ${fileName}`);
    assert.equal(detection.confidence, 0);
    await assert.rejects(
      () => runParse(loaded, input),
      err => err instanceof ImporterError && err.code === expectedCode
        && (fileName !== 'negative-savings-only.csv' || err.details.diagnostics.every(
          diagnostic => diagnostic.code === 'FILTERED_PRODUCT',
        )),
    );
  }

  // Direct parse call with 0-byte buffer rejects with EMPTY_INPUT
  assert.throws(
    () => loaded.plugin.parse({ fileName: 'empty.csv', format: 'csv', bytes: new Uint8Array(0) }, createImporterSdk()),
    err => err instanceof ImporterError && err.code === ERROR_CODES.EMPTY_INPUT,
  );

  // Cross-plugin mutual exclusion with pt-activobank and pt-bankinter PDF fixtures
  for (const [otherName, otherDir, fixtures] of [
    ['pt-activobank', ACTIVOBANK_DIR, ['activobank-rollover.pdf', 'activobank-multipage.pdf']],
    ['pt-bankinter', BANKINTER_DIR, ['bankinter-standard.pdf', 'bankinter-multipage-currency.pdf']],
  ]) {
    if (!fs.existsSync(otherDir)) continue;
    const otherPlugin = await loadPlugin(otherDir);

    for (const pdfFixture of fixtures) {
      const pdfBytes = fs.readFileSync(path.join(otherDir, 'fixtures', pdfFixture));
      const pdfInput = await prepareImportInput({ fileName: pdfFixture, bytes: pdfBytes });
      const revDet = await runDetection(loaded, pdfInput);
      assert.equal(revDet.matched, false, `eu-revolut must reject ${otherName} fixture ${pdfFixture}`);
      assert.equal(revDet.confidence, 0);
      await assert.rejects(
        () => runParse(loaded, pdfInput),
        err => err instanceof ImporterError && err.code === ERROR_CODES.UNSUPPORTED_FORMAT,
      );
    }

    for (const csvFixture of ['revolut-pt-mojibake.csv', 'revolut-en-multicurrency.csv']) {
      const csvBytes = fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures', csvFixture));
      const csvInput = await prepareImportInput({ fileName: csvFixture, bytes: csvBytes });
      const otherDet = await runDetection(otherPlugin, csvInput);
      assert.equal(otherDet.matched, false, `${otherName} must reject ${csvFixture}`);
      assert.equal(otherDet.confidence, 0);
      await assert.rejects(
        () => runParse(otherPlugin, csvInput),
        err => err instanceof ImporterError && err.code === ERROR_CODES.UNSUPPORTED_FORMAT,
      );
    }
  }
});

test('eu-revolut deterministic ZIP package unpacks and validates independently', async () => {
  const pkg1 = packagePlugin(PLUGIN_DIR);
  const pkg2 = packagePlugin(PLUGIN_DIR);
  assert.equal(pkg1.fileName, 'eu-revolut-1.0.0.zip');
  assert.equal(pkg1.sha256, pkg2.sha256);
  assert.equal(Buffer.compare(pkg1.bytes, pkg2.bytes), 0);

  parseDeterministicZip(pkg1.bytes, { fileName: pkg1.fileName, strictDeterministic: true });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eu-revolut-unpack-'));
  try {
    unpackDeterministicZip(pkg1.bytes, tmpDir, { fileName: pkg1.fileName, strictDeterministic: true });
    const scan = await scanPluginDirectory(tmpDir);
    assert.equal(scan.ok, true, JSON.stringify(scan.errors));

    const { manifest, fixtureResults } = await validatePluginContract(tmpDir);
    assert.equal(manifest.id, 'eu-revolut');
    assert.equal(fixtureResults.length, 4);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Revolut matches the legacy parser and preserves ledger staging behavior', {
  skip: !STATEMENT_PROCESSOR_DIST && 'Set PERSONAL_LEDGER_DIST to the built Personal Ledger dist directory',
}, async t => {

  const { CsvReaderService } = await import(
    pathToFileURL(path.join(STATEMENT_PROCESSOR_DIST, 'services/csv-parser/csv-reader.service.js')).href
  );
  const { RevolutCsvParserService } = await import(
    pathToFileURL(path.join(STATEMENT_PROCESSOR_DIST, 'services/csv-parser/revolut-csv-parser.service.js')).href
  );
  const { CsvDataService } = await import(
    pathToFileURL(path.join(STATEMENT_PROCESSOR_DIST, 'services/pdf-parser/csv-data.service.js')).href
  );
  const { statementEvidence, statementDiagnostics } = await import(
    pathToFileURL(path.join(STATEMENT_PROCESSOR_DIST, 'model/statement-evidence.js')).href
  );
  const { LedgerRepository } = await import(
    pathToFileURL(path.join(STATEMENT_PROCESSOR_DIST, 'application/ledger/repository.js')).href
  );
  const { Ledger } = await import(
    pathToFileURL(path.join(STATEMENT_PROCESSOR_DIST, 'application/ledger/service.js')).href
  );

  const loaded = await loadPlugin(PLUGIN_DIR);
  const sdk = createImporterSdk();
  const reader = new CsvReaderService();
  const parser = new RevolutCsvParserService();

  const englishExport = Buffer.from(
    'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance,ID\r\n'
    + 'Transfer,Current,2026-10-11 14:50:00,2026-10-12 14:50:01,Joint account,57.46,0,EUR,COMPLETED,257.59,eng-1\r\n'
    + 'Transfer,Current,2026-10-25 17:11:48,2026-10-25 17:11:49,Recipient,-30,0,EUR,COMPLETED,227.59,eng-2\r\n'
    + 'Transfer,Savings,2026-10-26 10:00:00,2026-10-26 10:00:00,Vault,-10,0,EUR,COMPLETED,10,eng-3\r\n'
    + 'Transfer,Current,2026-10-27 17:13:26,2026-10-27 17:13:27,Recipient,-10,0,EUR,COMPLETED,0.00,eng-4\r\n',
    'utf8',
  );

  const fallbackBytes = Buffer.from(
    'Col0,Col1,Col2,Col3,Col4,Col5\n'
    + 'Card,Atual,2026-10-01 09:00:00,2026-10-01 09:05:00,Mercado Local,-12.40\n',
    'utf8',
  );

  const missingValidDateMojibake = doubleEncodeUtf8(
    'Tipo,Produto,Data de início,Data de conclusão,Descrição,Montante,Taxa,Moeda,Estado,Saldo,ID\r\n'
    + 'Pagamento com cartão,Atual,2026-08-06 10:00:00,2026-08-06 10:01:00,Café Central,-5.00,0.00,EUR,CONCLUÍDO,100.00,rev-1\r\n'
    + 'Transferência,Poupança,2026-08-08 09:00:00,2026-08-08 09:00:00,Cofre Férias,-50.00,0.00,EUR,CONCLUÍDO,50.00,rev-3\r\n'
    + 'Transferência,Atual,, ,Sem Data,10.00,0.00,EUR,CONCLUÍDO,0.00,rev-4\r\n',
  );

  for (const [label, bytes] of [
    ['revolut-pt-mojibake.csv', fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures/revolut-pt-mojibake.csv'))],
    ['english-export.csv', englishExport],
    ['headerless-fallback.csv', fallbackBytes],
    ['mojibake-diags.csv', missingValidDateMojibake],
  ]) {
    const input = await prepareImportInput({ fileName: label, bytes });
    const pluginResult = await runParse(loaded, input, sdk);
    const compat = toLegacyTransactions(pluginResult);

    const decodedLegacy = reader.decode(Buffer.from(bytes));
    const legacyTxs = parser.parse(decodedLegacy, { quiet: true });

    assert.deepEqual(
      compat.transactions.map(({ date, description, cleanDescription, category, value }) => ({
        date, description, cleanDescription, category, value,
      })),
      legacyTxs.map(({ date, description, cleanDescription, category, value }) => ({
        date, description, cleanDescription, category, value,
      })),
      `Transaction mismatch for ${label}`,
    );

    const legacyEvidence = legacyTxs.map(tx => statementEvidence.get(tx));
    assert.deepEqual(
      compat.evidenceByIndex.map(ev => ({
        row: ev.row,
        sourceId: ev.sourceId ?? '',
        currency: ev.currency,
        rawDate: ev.rawDate,
        rawAmount: ev.rawAmount,
        runningBalance: ev.runningBalance ?? '',
      })),
      legacyEvidence,
      `Evidence mismatch for ${label}`,
    );

    const legacyDiags = statementDiagnostics.get(legacyTxs) ?? [];
    assert.deepEqual(
      compat.diagnostics.map(d => ({
        locator: d.locator,
        reason: d.reason,
        ...(d.date !== undefined ? { date: d.date } : {}),
        ...(d.description !== undefined ? { description: d.description } : {}),
        ...(d.value !== undefined ? { value: d.value } : {}),
      })),
      legacyDiags.map(d => Object.fromEntries(Object.entries(d).filter(([, value]) => value !== undefined))),
      `Diagnostics mismatch for ${label}`,
    );

    const legacyCsvLines = new CsvDataService(legacyTxs).exportToCsv().split('\n');
    const expectedCsv = [
      'date;description;cleanDescription;category;value;bank',
      ...legacyCsvLines.slice(1).map(line => `${line};Revolut`),
    ].join('\n');
    assert.equal(toLegacyNormalizedCsv(pluginResult, 'Revolut'), expectedCsv, `Normalized CSV mismatch for ${label}`);
  }

  for (const negFile of ['negative-savings-only.csv', 'negative-unrelated.csv']) {
    const bytes = fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures', negFile));
    assert.throws(() => parser.parse(reader.decode(bytes), { quiet: true }));
  }

  // Ledger staging, multi-currency, 2026-02-30 diagnostics, overlap matching, sourceId deduplication, and reconciliation
  const tmpLedgerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eu-revolut-ledger-'));
  fs.writeFileSync(path.join(tmpLedgerRoot, 'categories.json'), JSON.stringify([
    { name: 'Compras', description: '', color: '#000000', search: ['Cafe', 'Padaria'] },
    { name: 'Income', description: '', color: '#222222', search: ['Salário', 'Top Up', 'Refund'] },
    { name: 'Subscriptions', description: '', color: '#333333', search: ['Cloud'] },
  ]));
  fs.writeFileSync(path.join(tmpLedgerRoot, 'descriptions.json'), '[]');

  const repository = new LedgerRepository(path.join(tmpLedgerRoot, '.ledger'));
  const ledger = new Ledger(repository, tmpLedgerRoot);
  try {
    const eurAccount = ledger.saveAccount({
      name: 'Revolut EUR',
      institution: 'Revolut',
      kind: 'bank',
      currency: 'EUR',
      openingBalance: 0,
      openingDate: '01/08/2026',
    });
    const usdAccount = ledger.saveAccount({
      name: 'Revolut USD',
      institution: 'Revolut',
      kind: 'bank',
      currency: 'USD',
      openingBalance: 10000,
      openingDate: '01/08/2026',
    });
    const gbpAccount = ledger.saveAccount({
      name: 'Revolut GBP',
      institution: 'Revolut',
      kind: 'bank',
      currency: 'GBP',
      openingBalance: 0,
      openingDate: '01/08/2026',
    });

    const multiBytes = fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures/revolut-en-multicurrency.csv'));
    const legacyStage = await ledger.imports.stage('revolut-en-multicurrency.csv', 'Automatic', multiBytes);
    // Exercise the real staging path while the production plugin runtime is still pending.
    t.mock.method(RevolutCsvParserService.prototype, 'parse', function parseForLedger(text) {
      const result = loaded.plugin.parse({ format: 'csv', text }, sdk);
      const { transactions, evidenceByIndex, diagnostics } = toLegacyTransactions(result);
      transactions.forEach((transaction, index) => statementEvidence.set(transaction, evidenceByIndex[index]));
      statementDiagnostics.set(transactions, diagnostics);
      return transactions;
    });
    const stagedMulti = await ledger.imports.stage('revolut-en-multicurrency.csv', 'Revolut', multiBytes, {
      refreshId: legacyStage.id,
    });
    assert.deepEqual(stagedMulti.rows, legacyStage.rows);
    assert.equal(stagedMulti.source, 'Revolut');
    assert.equal(stagedMulti.rows.length, 5);
    assert.deepEqual(
      stagedMulti.rows.map(r => [r.date, r.rawDescription, r.amount, r.runningBalance, r.currency, r.sourceId]),
      [
        ['05/08/2026', 'Top Up', 1000, 1000, 'EUR', 'rev-en-1'],
        ['06/08/2026', 'Cafe', -500, 500, 'EUR', 'rev-en-2'],
        ['06/08/2026', 'Cafe', -500, 0, 'EUR', 'rev-en-3'],
        ['07/08/2026', 'Cloud Service', -1234, 8766, 'USD', 'rev-en-4'],
        ['08/08/2026', 'Refund London Shop', 2550, 2550, 'GBP', 'rev-en-5'],
      ],
    );
    // Notice audited difference: legacy stages 2026-02-30 into diagnostics via dateKey('30/02/2026'),
    // whereas eu-revolut flags 2026-02-30 directly during parse() as '2026-02-30'.
    assert.equal(stagedMulti.diagnostics.length, 4);
    assert.equal(legacyStage.diagnostics.find(row => row.description === 'Bad Calendar Date').date, '30/02/2026');
    assert.equal(stagedMulti.diagnostics[1].date, '2026-02-30');

    const accountByCurrency = { EUR: eurAccount.id, USD: usdAccount.id, GBP: gbpAccount.id };
    const committedMulti = ledger.imports.commit(
      stagedMulti.id,
      stagedMulti.rulesRevision,
      stagedMulti.rows.map(r => ({
        row: r.row,
        accountId: accountByCurrency[r.currency],
        disposition: 'add',
        date: '',
      })),
    );
    assert.equal(committedMulti.status, 'committed');
    assert.equal(committedMulti.inserted, 5);

    // Verify source_records retained 0 runningBalance and sourceIds
    const sourceRecords = repository.all(
      'SELECT row, sourceId, runningBalance, movementId FROM source_records WHERE batchId=? ORDER BY row',
      committedMulti.id,
    );
    assert.deepEqual(
      sourceRecords.map(s => [s.sourceId, s.runningBalance]),
      [
        ['rev-en-1', 1000],
        ['rev-en-2', 500],
        ['rev-en-3', 0],
        ['rev-en-4', 8766],
        ['rev-en-5', 2550],
      ],
    );

    // Reconcile EUR zero closing balance on 06/08/2026 and USD/GBP balances
    const closingRecord = sourceRecords.find(record => record.sourceId === 'rev-en-3');
    assert.ok(closingRecord.movementId);
    ledger.saveObservation({
      accountId: eurAccount.id,
      date: '06/08/2026',
      kind: 'actual',
      amount: 0,
      sourceMovementId: closingRecord.movementId,
      sourceClosingConfirmed: true,
    });
    const eurRecon = ledger.reconcile(eurAccount.id, '06/08/2026');
    assert.equal(eurRecon.status, 'matched');
    assert.equal(eurRecon.calculated, 0);
    assert.equal(eurRecon.actual.amount, 0);
    assert.equal(eurRecon.difference, 0);

    ledger.saveObservation({
      accountId: usdAccount.id,
      date: '07/08/2026',
      kind: 'actual',
      amount: 8766,
    });
    assert.equal(ledger.reconcile(usdAccount.id, '07/08/2026').status, 'matched');

    ledger.saveObservation({
      accountId: gbpAccount.id,
      date: '08/08/2026',
      kind: 'actual',
      amount: 2550,
    });
    assert.equal(ledger.reconcile(gbpAccount.id, '08/08/2026').status, 'matched');

    // Overlap matching on repeated identical Cafe rows (without sourceId -> 2 candidates)
    const overlapNoId = Buffer.from(
      'Product,Completed Date,Description,Amount,Currency\n'
      + 'Current,2026-08-06 08:30:00,Cafe,-5.00,EUR\n',
      'utf8',
    );
    const overlapStaged = await ledger.imports.stage('overlap.csv', 'Revolut', overlapNoId);
    assert.equal(overlapStaged.rows[0].candidates.length, 2);
    const overlapCommitted = ledger.imports.commit(
      overlapStaged.id,
      overlapStaged.rulesRevision,
      [{ row: overlapStaged.rows[0].row, accountId: eurAccount.id, disposition: 'associate', candidate: overlapStaged.rows[0].candidates[0].id }],
    );
    assert.equal(overlapCommitted.associated, 1);

    // sourceId deduplication: re-importing an existing sourceId cannot be added again, must associate or exclude
    const dupSourceId = Buffer.from(
      'Product,Completed Date,Description,Amount,Currency,ID\n'
      + 'Current,2026-08-06 08:30:00,Cafe,-5.00,EUR,rev-en-2\n',
      'utf8',
    );
    const dupIdStaged = await ledger.imports.stage('dup-id.csv', 'Revolut', dupSourceId);
    assert.equal(dupIdStaged.rows[0].candidates.some(c => c.strong === 1), true);
    assert.throws(
      () => ledger.imports.commit(dupIdStaged.id, dupIdStaged.rulesRevision, [{
        row: dupIdStaged.rows[0].row, accountId: eurAccount.id, disposition: 'add',
      }]),
      /already imported/,
    );

  } finally {
    repository.close();
    fs.rmSync(tmpLedgerRoot, { recursive: true, force: true });
  }
});
