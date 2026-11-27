import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
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
import { buildPositionedPdf } from '../../../sdk/pdf-fixture.mjs';
import { parseDeterministicZip, unpackDeterministicZip } from '../../../scripts/lib/deterministic-zip.mjs';
import { validateManifestSemantics } from '../../../scripts/lib/schema-validator.mjs';
import { scanPluginDirectory } from '../../../scripts/lib/security-scan.mjs';
import { packagePlugin } from '../../../scripts/package-plugin.mjs';

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_DIR = path.resolve(PLUGIN_DIR, '../..');

const HEADER_ROW = [
  [50, 700, 'Data'], [70, 700, 'Lanc.'], [105, 700, 'Data'], [125, 700, 'Valor'],
  [170, 700, 'Descritivo'], [380, 700, 'Debito'], [450, 700, 'Credito'], [535, 700, 'Saldo'],
];

test('pt-activobank passes manifest schema, isolation, security scan, and full contract validation', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'manifest.json'), 'utf8'));
  validateManifestSemantics(manifest, SCHEMAS.manifest);
  assert.equal(manifest.id, 'pt-activobank');
  assert.equal(manifest.tier, 'official');
  assert.deepEqual(manifest.permissions, []);

  const loaded = await loadPlugin(PLUGIN_DIR);
  assertPluginIsolation(loaded.entrypointPath, PLUGIN_DIR);

  const scan = await scanPluginDirectory(PLUGIN_DIR);
  assert.equal(scan.ok, true, JSON.stringify(scan.errors));

  const { fixtureResults } = await validatePluginContract(PLUGIN_DIR);
  assert.equal(fixtureResults.length, 4);
  assert.deepEqual(
    fixtureResults.map(item => [item.fileName, item.kind, item.detection.matched]),
    [
      ['activobank-multipage.pdf', 'positive', true],
      ['activobank-rollover.pdf', 'positive', true],
      ['negative-header-only.pdf', 'negative', false],
      ['negative-unrelated.pdf', 'negative', false],
    ],
  );
});

test('pt-activobank handles December-on-January rollover, duplicate rows, and real 0,00 running balance', async () => {
  const loaded = await loadPlugin(PLUGIN_DIR);
  const bytes = fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures/activobank-rollover.pdf'));
  const input = await prepareImportInput({ fileName: 'activobank-rollover.pdf', bytes, limits: loaded.manifest.limits });

  const detection = await runDetection(loaded, input);
  assert.equal(detection.matched, true);
  assert.equal(detection.confidence, 0.98);
  assert.equal(detection.institutionId, 'activobank');

  const result = await runParse(loaded, input);
  assert.equal(result.pluginId, 'pt-activobank');
  assert.equal(result.institutionId, 'activobank');
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.transactions.length, 4);

  assert.deepEqual(
    result.transactions.map(t => [t.date, t.description, t.amount, t.currency, t.balance, t.evidence]),
    [
      [
        '2025-12-31',
        'Deposito Inicial',
        '500.00',
        '',
        '500.00',
        {
          row: 3,
          page: 1,
          locator: 'Page 1, row 3',
          rawDate: '12.31',
          rawAmount: '500,00',
          runningBalance: '500,00',
          yearInferred: true,
        },
      ],
      [
        '2026-01-05',
        'Cafe',
        '-12.50',
        '',
        '487.50',
        {
          row: 4,
          page: 1,
          locator: 'Page 1, row 4',
          rawDate: '01.05',
          rawAmount: '-12,50',
          runningBalance: '487,50',
          yearInferred: true,
        },
      ],
      [
        '2026-01-05',
        'Cafe',
        '-12.50',
        '',
        '475.00',
        {
          row: 5,
          page: 1,
          locator: 'Page 1, row 5',
          rawDate: '01.05',
          rawAmount: '-12,50',
          runningBalance: '475,00',
          yearInferred: true,
        },
      ],
      [
        '2026-01-06',
        'Transferencia',
        '-475.00',
        '',
        '0.00',
        {
          row: 6,
          page: 1,
          locator: 'Page 1, row 6',
          rawDate: '01.06',
          rawAmount: '-475,00',
          runningBalance: '0,00',
          yearInferred: true,
        },
      ],
    ],
  );

  const rawCompat = toLegacyTransactions(result, { rawPdfValues: true });
  assert.deepEqual(
    rawCompat.transactions.map(({ date, description, value, balance }) => ({ date, description, value, balance })),
    [
      { date: '31/12/2025', description: 'Deposito Inicial', value: '500,00', balance: '500,00' },
      { date: '05/01/2026', description: 'Cafe', value: '-12,50', balance: '487,50' },
      { date: '05/01/2026', description: 'Cafe', value: '-12,50', balance: '475,00' },
      { date: '06/01/2026', description: 'Transferencia', value: '-475,00', balance: '0,00' },
    ],
  );
  assert.equal(rawCompat.evidenceByIndex[3].runningBalance, '0,00');

  const normCompat = toLegacyTransactions(result, { rawPdfValues: false });
  assert.equal(normCompat.transactions[3].balance, '0.00');

  const csvOut = toLegacyNormalizedCsv(result, 'ActivoBank');
  assert.equal(
    csvOut,
    [
      'date;description;cleanDescription;category;value;bank',
      '31/12/2025;Deposito Inicial;;;500,00;ActivoBank',
      '05/01/2026;Cafe;;;-12,50;ActivoBank',
      '05/01/2026;Cafe;;;-12,50;ActivoBank',
      '06/01/2026;Transferencia;;;-475,00;ActivoBank',
    ].join('\n'),
  );
});

test('pt-activobank handles multi-page A TRANSPORTAR, thousands formatting, 02.30 diagnostics, and SALDO FINAL stop', async () => {
  const loaded = await loadPlugin(PLUGIN_DIR);
  const bytes = fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures/activobank-multipage.pdf'));
  const input = await prepareImportInput({ fileName: 'activobank-multipage.pdf', bytes, limits: loaded.manifest.limits });
  const result = await runParse(loaded, input);

  assert.equal(result.transactions.length, 3);
  assert.deepEqual(
    result.transactions.map(t => [t.date, t.description, t.amount, t.balance, t.evidence.page, t.evidence.locator]),
    [
      ['2026-03-02', 'Vencimento Mensal', '1250.50', '1250.50', 1, 'Page 1, row 3'],
      ['2026-03-10', 'Renda Habitacao', '-1250.50', '0.00', 2, 'Page 2, row 9'],
      ['2026-03-15', 'Reembolso', '75.25', '75.25', 2, 'Page 2, row 10'],
    ],
  );
  assert.equal(result.transactions.some(t => t.description.includes('Pagina Tres')), false);
  assert.equal(result.transactions.some(t => t.description.includes('A TRANSPORTAR')), false);

  assert.deepEqual(result.diagnostics, [
    {
      locator: 'Page 1, row 4',
      reason: 'Invalid date, description, or running balance',
      date: '30/02/2026',
      rawDate: '02.30',
      description: 'Data Invalida',
      value: '-10,00',
    },
  ]);

  const rawCompat = toLegacyTransactions(result, { rawPdfValues: true });
  assert.deepEqual(rawCompat.transactions.map(t => [t.value, t.balance]), [
    ['1.250,50', '1.250,50'],
    ['-1.250,50', '0,00'],
    ['75,25', '75,25'],
  ]);
  assert.equal(
    toLegacyNormalizedCsv(result, 'ActivoBank'),
    [
      'date;description;cleanDescription;category;value;bank',
      '02/03/2026;Vencimento Mensal;;;1250,50;ActivoBank',
      '10/03/2026;Renda Habitacao;;;-1250,50;ActivoBank',
      '15/03/2026;Reembolso;;;75,25;ActivoBank',
    ].join('\n'),
  );
});

test('pt-activobank supports options.referenceYear, full dates, description punctuation cleanup, and row diagnostics', async () => {
  const loaded = await loadPlugin(PLUGIN_DIR);

  // Missing closing header + leap-day MM.DD resolved via options.referenceYear
  const noClosingBytes = buildPositionedPdf([[
    ...HEADER_ROW,
    [70, 680, '02.29'], [125, 680, '02.29'], [170, 680, 'Cafe;'], [200, 680, '"Central"'], [380, 680, '4,50'], [535, 680, '95,50'],
    [70, 660, '03/03/2024'], [125, 660, '03/03/2024'], [170, 660, 'Full'], [195, 660, 'Date'], [450, 660, '20,00'], [535, 660, '115,50'],
    // Empty amount with valid balance -> diagnostic
    [70, 640, '03.04'], [125, 640, '03.04'], [170, 640, 'Missing'], [210, 640, 'Amount'], [535, 640, '115,50'],
    // Missing description with valid date & balance -> diagnostic
    [70, 620, '03.05'], [125, 620, '03.05'], [380, 620, '5,00'], [535, 620, '110,50'],
    // Malformed amount -> diagnostic
    [70, 600, '03.06'], [125, 600, '03.06'], [170, 600, 'Bad'], [195, 600, 'Amount'], [380, 600, '12,50,00'], [535, 600, '98,00'],
  ]]);

  const input = await prepareImportInput({
    fileName: 'no-closing.pdf',
    bytes: noClosingBytes,
    options: { referenceYear: 2024 },
  });
  const detection = await runDetection(loaded, input);
  assert.equal(detection.matched, true);
  assert.equal(detection.confidence, 0.92);
  assert.equal(detection.metadata.hasClosingHeader, false);

  const result = await runParse(loaded, input);
  assert.equal(result.transactions.length, 2);
  assert.equal(result.transactions[0].date, '2024-02-29');
  assert.equal(result.transactions[0].description, 'Cafe Central');
  assert.equal(result.transactions[0].evidence.yearInferred, true);
  assert.equal(result.transactions[1].date, '2024-03-03');
  assert.equal(result.transactions[1].evidence.yearInferred, undefined);

  assert.equal(result.diagnostics.length, 3);
  assert.equal(result.diagnostics[0].reason, 'Invalid or missing amount');
  assert.equal(result.diagnostics[0].description, 'Missing Amount');
  assert.equal(result.diagnostics[1].reason, 'Invalid date, description, or running balance');
  assert.equal(result.diagnostics[1].rawDate, '03.05');
  assert.equal(result.diagnostics[2].reason, 'Invalid or missing amount');
  assert.equal(result.diagnostics[2].value, '-12,50,00');

  // Invalid closing header (mismatched YY or invalid calendar date) falls back to referenceYear
  const badClosingBytes = buildPositionedPdf([[
    [50, 760, '25/02/30 EXT. N. 2026/002'],
    ...HEADER_ROW,
    [70, 680, '02.29'], [125, 680, '02.29'], [170, 680, 'Leap'], [380, 680, '10,00'], [535, 680, '90,00'],
  ]]);
  const badClosingInput = await prepareImportInput({
    fileName: 'bad-closing.pdf',
    bytes: badClosingBytes,
    options: { referenceYear: 2024 },
  });
  const badClosingResult = await runParse(loaded, badClosingInput);
  assert.equal(badClosingResult.transactions[0].date, '2024-02-29');
});

test('pt-activobank rejects negative, header-only, BankInter, and non-PDF inputs cleanly', async () => {
  const loaded = await loadPlugin(PLUGIN_DIR);

  const negativeCases = [
    ['negative-header-only.pdf', fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures/negative-header-only.pdf')), ERROR_CODES.NO_TRANSACTIONS],
    ['negative-unrelated.pdf', fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures/negative-unrelated.pdf')), ERROR_CODES.HEADER_NOT_FOUND],
    ['compat-negative.pdf', fs.readFileSync(path.join(ROOT_DIR, 'fixtures/compatibility/inputs/negative-unrelated.pdf')), ERROR_CODES.HEADER_NOT_FOUND],
    ['compat-negative.csv', fs.readFileSync(path.join(ROOT_DIR, 'fixtures/compatibility/inputs/negative-unrelated.csv')), ERROR_CODES.UNSUPPORTED_FORMAT],
  ];

  for (const [fileName, bytes, expectedCode] of negativeCases) {
    const input = await prepareImportInput({ fileName, bytes, limits: loaded.manifest.limits });
    const detection = await runDetection(loaded, input);
    assert.equal(detection.matched, false, `Expected non-match for ${fileName}`);
    assert.equal(detection.confidence, 0);
    await assert.rejects(
      () => runParse(loaded, input),
      err => err instanceof ImporterError && err.code === expectedCode,
    );
  }
});

test('pt-activobank matches cross-repo compatibility fixture 05-inferred-year-pdf', async () => {
  const loaded = await loadPlugin(PLUGIN_DIR);
  const compatDir = path.join(ROOT_DIR, 'fixtures/compatibility');
  const case05 = JSON.parse(fs.readFileSync(path.join(compatDir, 'cases/05-inferred-year-pdf.json'), 'utf8'));
  const bytes = fs.readFileSync(path.join(compatDir, case05.inputFile));
  const input = await prepareImportInput({ fileName: path.basename(case05.inputFile), bytes });

  const detection = await runDetection(loaded, input);
  assert.equal(detection.matched, true);
  assert.equal(detection.confidence, 0.98);

  const result = await runParse(loaded, input);
  assert.deepEqual(
    result.transactions.map(t => ({
      date: t.date,
      description: t.description,
      amount: t.amount,
      currency: t.currency,
      balance: t.balance,
      rawDate: t.evidence.rawDate,
      rawAmount: t.evidence.rawAmount,
      runningBalance: t.evidence.runningBalance,
      yearInferred: t.evidence.yearInferred,
    })),
    case05.expectedImportResult.transactions.map(t => ({
      date: t.date,
      description: t.description,
      amount: t.amount,
      currency: t.currency,
      balance: t.balance,
      rawDate: t.evidence.rawDate,
      rawAmount: t.evidence.rawAmount,
      runningBalance: t.evidence.runningBalance,
      yearInferred: t.evidence.yearInferred,
    })),
  );

  const rawCompat = toLegacyTransactions(result, { rawPdfValues: true });
  assert.deepEqual(
    rawCompat.transactions.map(({ date, value, balance }) => ({ date, value, balance })),
    case05.expectedLegacyRawPdfValues,
  );
  const normCompat = toLegacyTransactions(result, { rawPdfValues: false });
  assert.deepEqual(
    normCompat.transactions.map(({ date, value, balance }) => ({ date, value, balance })),
    case05.expectedLegacyNormalizedValues,
  );
});

test('pt-activobank deterministic ZIP package unpacks and validates independently', async () => {
  const pkg1 = packagePlugin(PLUGIN_DIR);
  const pkg2 = packagePlugin(PLUGIN_DIR);
  assert.equal(pkg1.fileName, 'pt-activobank-1.0.1.zip');
  assert.equal(pkg1.sha256, pkg2.sha256);
  assert.equal(Buffer.compare(pkg1.bytes, pkg2.bytes), 0);

  parseDeterministicZip(pkg1.bytes, { fileName: pkg1.fileName, strictDeterministic: true });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-activobank-unpack-'));
  try {
    unpackDeterministicZip(pkg1.bytes, tmpDir, { fileName: pkg1.fileName, strictDeterministic: true });
    const scan = await scanPluginDirectory(tmpDir);
    assert.equal(scan.ok, true, JSON.stringify(scan.errors));

    const { manifest, fixtureResults } = await validatePluginContract(tmpDir);
    assert.equal(manifest.id, 'pt-activobank');
    assert.equal(fixtureResults.length, 4);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
