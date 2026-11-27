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
import { buildPositionedPdf, statementPdf } from '../../../sdk/pdf-fixture.mjs';
import { parseDeterministicZip, unpackDeterministicZip } from '../../../scripts/lib/deterministic-zip.mjs';
import { validateManifestSemantics } from '../../../scripts/lib/schema-validator.mjs';
import { scanPluginDirectory } from '../../../scripts/lib/security-scan.mjs';
import { packagePlugin } from '../../../scripts/package-plugin.mjs';

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_DIR = path.resolve(PLUGIN_DIR, '../..');
const ACTIVOBANK_DIR = path.join(ROOT_DIR, 'plugins/pt-activobank');


test('pt-bankinter passes manifest schema, isolation, security scan, and full contract validation', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'manifest.json'), 'utf8'));
  validateManifestSemantics(manifest, SCHEMAS.manifest);
  assert.equal(manifest.id, 'pt-bankinter');
  assert.equal(manifest.tier, 'official');
  assert.deepEqual(manifest.permissions, []);
  assert.equal(manifest.capabilities.supportsMultiCurrency, true);
  assert.equal(manifest.capabilities.supportsYearInference, false);
  assert.equal(manifest.capabilities.supportsRunningBalance, true);

  const loaded = await loadPlugin(PLUGIN_DIR);
  assertPluginIsolation(loaded.entrypointPath, PLUGIN_DIR);

  const scan = await scanPluginDirectory(PLUGIN_DIR);
  assert.equal(scan.ok, true, JSON.stringify(scan.errors));

  const { fixtureResults } = await validatePluginContract(PLUGIN_DIR);
  assert.equal(fixtureResults.length, 4);
  assert.deepEqual(
    fixtureResults.map(item => [item.fileName, item.kind, item.detection.matched]),
    [
      ['bankinter-multipage-currency.pdf', 'positive', true],
      ['bankinter-standard.pdf', 'positive', true],
      ['negative-empty-table.pdf', 'negative', false],
      ['negative-unrelated.pdf', 'negative', false],
    ],
  );
});

test('pt-bankinter parses standard debits, thousands credits, Taxa Cambio fallback, repeated rows, and 0,00 balance', async () => {
  const loaded = await loadPlugin(PLUGIN_DIR);
  const bytes = fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures/bankinter-standard.pdf'));
  const input = await prepareImportInput({ fileName: 'bankinter-standard.pdf', bytes, limits: loaded.manifest.limits });

  const detection = await runDetection(loaded, input);
  assert.equal(detection.matched, true);
  assert.equal(detection.confidence, 0.98);
  assert.equal(detection.institutionId, 'bankinter');
  assert.deepEqual(detection.metadata, { transactionCount: 5, hasFooter: true });

  const result = await runParse(loaded, input);
  assert.equal(result.pluginId, 'pt-bankinter');
  assert.equal(result.institutionId, 'bankinter');
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.transactions.length, 5);

  assert.deepEqual(
    result.transactions.map(t => [t.date, t.description, t.amount, t.currency, t.balance, t.evidence]),
    [
      [
        '2026-02-02',
        'Vencimento Mensal',
        '1250.00',
        '',
        '1250.00',
        {
          row: 3,
          page: 1,
          locator: 'Page 1, row 3',
          rawDate: '02-02-2026',
          rawAmount: '1250,00',
          runningBalance: '1250,00',
        },
      ],
      [
        '2026-02-03',
        'Cafe Central',
        '-12.50',
        '',
        '1237.50',
        {
          row: 4,
          page: 1,
          locator: 'Page 1, row 4',
          rawDate: '03-02-2026',
          rawAmount: '-12,50',
          runningBalance: '1237,50',
        },
      ],
      [
        '2026-02-03',
        'Cafe Central',
        '-12.50',
        '',
        '1225.00',
        {
          row: 5,
          page: 1,
          locator: 'Page 1, row 5',
          rawDate: '03-02-2026',
          rawAmount: '-12,50',
          runningBalance: '1225,00',
        },
      ],
      [
        '2026-02-04',
        'Comissao Conversao',
        '-2.50',
        '',
        '1222.50',
        {
          row: 6,
          page: 1,
          locator: 'Page 1, row 6',
          rawDate: '04-02-2026',
          rawAmount: '-2,50',
          runningBalance: '1222,50',
        },
      ],
      [
        '2026-02-05',
        'Transferencia Final',
        '-1222.50',
        '',
        '0.00',
        {
          row: 7,
          page: 1,
          locator: 'Page 1, row 7',
          rawDate: '05-02-2026',
          rawAmount: '-1222,50',
          runningBalance: '0,00',
        },
      ],
    ],
  );

  const rawCompat = toLegacyTransactions(result, { rawPdfValues: true });
  assert.deepEqual(
    rawCompat.transactions.map(({ date, description, value, balance }) => ({ date, description, value, balance })),
    [
      { date: '02/02/2026', description: 'Vencimento Mensal', value: '1250,00', balance: '1250,00' },
      { date: '03/02/2026', description: 'Cafe Central', value: '-12,50', balance: '1237,50' },
      { date: '03/02/2026', description: 'Cafe Central', value: '-12,50', balance: '1225,00' },
      { date: '04/02/2026', description: 'Comissao Conversao', value: '-2,50', balance: '1222,50' },
      { date: '05/02/2026', description: 'Transferencia Final', value: '-1222,50', balance: '0,00' },
    ],
  );
  assert.equal(rawCompat.evidenceByIndex[4].runningBalance, '0,00');

  const normCompat = toLegacyTransactions(result, { rawPdfValues: false });
  assert.equal(normCompat.transactions[4].balance, '0.00');

  const csvOut = toLegacyNormalizedCsv(result, 'BankInter');
  assert.equal(
    csvOut,
    [
      'date;description;cleanDescription;category;value;bank',
      '02/02/2026;Vencimento Mensal;;;1250,00;BankInter',
      '03/02/2026;Cafe Central;;;-12,50;BankInter',
      '03/02/2026;Cafe Central;;;-12,50;BankInter',
      '04/02/2026;Comissao Conversao;;;-2,50;BankInter',
      '05/02/2026;Transferencia Final;;;-1222,50;BankInter',
    ].join('\n'),
  );
});

test('pt-bankinter handles multipage A TRANSPORTAR, Moeda currency, 30-02-2026 diagnostic, and Conforme stop', async () => {
  const loaded = await loadPlugin(PLUGIN_DIR);
  const bytes = fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures/bankinter-multipage-currency.pdf'));
  const input = await prepareImportInput({
    fileName: 'bankinter-multipage-currency.pdf',
    bytes,
    limits: loaded.manifest.limits,
  });

  const result = await runParse(loaded, input);
  assert.equal(result.transactions.length, 3);
  assert.deepEqual(
    result.transactions.map(t => [t.date, t.description, t.amount, t.currency, t.balance, t.evidence.page, t.evidence.locator]),
    [
      ['2026-02-10', 'Supermercado Norte', '-45.80', 'EUR', '954.20', 1, 'Page 1, row 2'],
      ['2026-02-12', 'Compra Online Cloud', '-19.99', 'USD', '934.21', 2, 'Page 2, row 8'],
      ['2026-02-15', 'Reembolso Servico', '1000.00', 'EUR', '1934.21', 2, 'Page 2, row 9'],
    ],
  );
  assert.equal(result.transactions.some(t => t.description.includes('Pagina Tres')), false);
  assert.equal(result.transactions.some(t => t.description.includes('A TRANSPORTAR')), false);

  assert.deepEqual(result.diagnostics, [
    {
      locator: 'Page 1, row 3',
      reason: 'Invalid date, description, or running balance',
      date: '30/02/2026',
      rawDate: '30-02-2026',
      description: 'Data Invalida',
      value: '-10,00',
    },
  ]);

  const rawCompat = toLegacyTransactions(result, { rawPdfValues: true });
  assert.deepEqual(rawCompat.transactions.map(t => [t.value, t.balance]), [
    ['-45,80', '954,20'],
    ['-19,99', '934,21'],
    ['1000,00', '1934,21'],
  ]);
  assert.deepEqual(rawCompat.evidenceByIndex.map(e => e.currency), ['EUR', 'USD', 'EUR']);
});

test('pt-bankinter handles shifted dynamic columns, Montante precedence, footerless statements, and row diagnostics', async () => {
  const loaded = await loadPlugin(PLUGIN_DIR);

  // 1. Minimal statementPdf('BankInter') without Conforme footer -> confidence 0.92
  const minimalBytes = statementPdf('BankInter');
  const minimalInput = await prepareImportInput({ fileName: 'minimal.pdf', bytes: minimalBytes });
  const minimalDet = await runDetection(loaded, minimalInput);
  assert.equal(minimalDet.matched, true);
  assert.equal(minimalDet.confidence, 0.92);
  assert.deepEqual(minimalDet.metadata, { transactionCount: 1, hasFooter: false });
  const minimalRes = await runParse(loaded, minimalInput);
  assert.equal(minimalRes.transactions.length, 1);
  assert.equal(minimalRes.transactions[0].date, '2026-02-03');
  assert.equal(minimalRes.transactions[0].amount, '-12.50');
  assert.equal(minimalRes.transactions[0].currency, '');
  assert.equal(minimalRes.transactions[0].balance, '100.00');

  // 2. Shifted dynamic header columns + precedence + non-ISO currency token + diagnostics
  const edgeBytes = buildPositionedPdf([[
    [0, 700, 'Data'], [22, 700, 'Movimento'],
    [70, 700, 'Data'], [86, 700, 'Valor'],
    [115, 700, 'Descrição'], [290, 700, 'Transação'],
    [338, 700, 'Montante'], [386, 700, 'Moeda'],
    [418, 700, 'Saldo'], [462, 700, 'Taxa'], [482, 700, 'Câmbio'],
    // Montante takes precedence over Taxa Cambio when both are populated; '-' in Moeda stays ''
    [0, 680, '06-02-2026'], [70, 680, '06-02-2026'], [115, 680, 'Compra'], [150, 680, 'Cartao'],
    [338, 680, '-20,00'], [386, 680, '-'], [418, 680, '80,00'], [462, 680, '1,50'],
    // Empty Montante (no '-') falls back to Taxa Cambio
    [0, 660, '07-02-2026'], [70, 660, '07-02-2026'], [115, 660, 'Taxa'], [138, 660, 'Cambio'],
    [386, 660, 'EUR'], [418, 660, '78,50'], [462, 660, '1,50'],
    // Empty amount with valid balance -> diagnostic
    [0, 640, '08-02-2026'], [70, 640, '08-02-2026'], [115, 640, 'Sem'], [136, 640, 'Valor'],
    [418, 640, '78,50'],
    // Missing description -> diagnostic
    [0, 620, '09-02-2026'], [70, 620, '09-02-2026'], [338, 620, '-5,00'], [418, 620, '73,50'],
    // Malformed balance -> diagnostic
    [0, 600, '10-02-2026'], [70, 600, '10-02-2026'], [115, 600, 'Saldo'], [140, 600, 'Invalido'],
    [338, 600, '-5,00'], [418, 600, '12,34,56'],
    // Malformed amount -> diagnostic
    [0, 580, '11-02-2026'], [70, 580, '11-02-2026'], [115, 580, 'Montante'], [155, 580, 'Invalido'],
    [338, 580, '12,34,56'], [418, 580, '70,00'],
  ]]);

  const edgeInput = await prepareImportInput({ fileName: 'edges.pdf', bytes: edgeBytes });
  const edgeRes = await runParse(loaded, edgeInput);
  assert.equal(edgeRes.transactions.length, 2);
  assert.deepEqual(
    edgeRes.transactions.map(t => [t.date, t.description, t.amount, t.currency, t.balance]),
    [
      ['2026-02-06', 'Compra Cartao', '-20.00', '', '80.00'],
      ['2026-02-07', 'Taxa Cambio', '-1.50', 'EUR', '78.50'],
    ],
  );
  assert.equal(edgeRes.diagnostics.length, 4);
  assert.deepEqual(
    edgeRes.diagnostics.map(d => [d.reason, d.description ?? null, d.value ?? null]),
    [
      ['Invalid or missing amount', 'Sem Valor', null],
      ['Invalid date, description, or running balance', null, '-5,00'],
      ['Invalid date, description, or running balance', 'Saldo Invalido', '-5,00'],
      ['Invalid or missing amount', 'Montante Invalido', '12,34,56'],
    ],
  );
});

test('pt-bankinter rejects negative, empty-table, ActivoBank, and non-PDF inputs cleanly and enforces mutual exclusion', async () => {
  const loaded = await loadPlugin(PLUGIN_DIR);

  const negativeCases = [
    ['negative-empty-table.pdf', fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures/negative-empty-table.pdf')), ERROR_CODES.NO_TRANSACTIONS],
    ['negative-unrelated.pdf', fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures/negative-unrelated.pdf')), ERROR_CODES.HEADER_NOT_FOUND],
    ['compat-negative.pdf', fs.readFileSync(path.join(ROOT_DIR, 'fixtures/compatibility/inputs/negative-unrelated.pdf')), ERROR_CODES.HEADER_NOT_FOUND],
    ['compat-activobank.pdf', fs.readFileSync(path.join(ROOT_DIR, 'fixtures/compatibility/inputs/inferred-year-activobank.pdf')), ERROR_CODES.HEADER_NOT_FOUND],
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

  // Cross-plugin mutual exclusion with pt-activobank when present in repo
  if (fs.existsSync(ACTIVOBANK_DIR)) {
    const activobank = await loadPlugin(ACTIVOBANK_DIR);

    for (const activoFixture of ['activobank-rollover.pdf', 'activobank-multipage.pdf']) {
      const bytes = fs.readFileSync(path.join(ACTIVOBANK_DIR, 'fixtures', activoFixture));
      const input = await prepareImportInput({ fileName: activoFixture, bytes });
      const detBankinter = await runDetection(loaded, input);
      assert.equal(detBankinter.matched, false, `pt-bankinter must reject ${activoFixture}`);
      assert.equal(detBankinter.confidence, 0);
      await assert.rejects(() => runParse(loaded, input), err => err instanceof ImporterError);
    }

    for (const bankinterFixture of ['bankinter-standard.pdf', 'bankinter-multipage-currency.pdf']) {
      const bytes = fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures', bankinterFixture));
      const input = await prepareImportInput({ fileName: bankinterFixture, bytes });
      const detActivo = await runDetection(activobank, input);
      assert.equal(detActivo.matched, false, `pt-activobank must reject ${bankinterFixture}`);
      assert.equal(detActivo.confidence, 0);
      await assert.rejects(() => runParse(activobank, input), err => err instanceof ImporterError);
    }
  }
});

test('pt-bankinter deterministic ZIP package unpacks and validates independently without pt-activobank', async () => {
  const pkg1 = packagePlugin(PLUGIN_DIR);
  const pkg2 = packagePlugin(PLUGIN_DIR);
  assert.equal(pkg1.fileName, 'pt-bankinter-1.0.1.zip');
  assert.equal(pkg1.sha256, pkg2.sha256);
  assert.equal(Buffer.compare(pkg1.bytes, pkg2.bytes), 0);

  parseDeterministicZip(pkg1.bytes, { fileName: pkg1.fileName, strictDeterministic: true });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-bankinter-unpack-'));
  try {
    unpackDeterministicZip(pkg1.bytes, tmpDir, { fileName: pkg1.fileName, strictDeterministic: true });
    const scan = await scanPluginDirectory(tmpDir);
    assert.equal(scan.ok, true, JSON.stringify(scan.errors));

    const { manifest, fixtureResults } = await validatePluginContract(tmpDir);
    assert.equal(manifest.id, 'pt-bankinter');
    assert.equal(fixtureResults.length, 4);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
