import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createImporterSdk } from '../sdk/index.mjs';
import { toLegacyNormalizedCsv, toLegacyTransactions } from '../sdk/compat.mjs';
import { loadPlugin, prepareImportInput, runParse } from '../sdk/harness.mjs';
import { buildPositionedPdf, statementPdf } from '../sdk/pdf-fixture.mjs';
import { configureCoreImporter, coreImporterTestOptions, importCore, importLegacyOracle } from './helpers/core-importer.mjs';

const ROOT_DIR = fileURLToPath(new URL('../', import.meta.url));

const ACTIVOBANK_HEADER = [
  [50, 700, 'Data'], [70, 700, 'Lanc.'], [105, 700, 'Data'], [125, 700, 'Valor'],
  [170, 700, 'Descritivo'], [380, 700, 'Debito'], [450, 700, 'Credito'], [535, 700, 'Saldo'],
];

test('ActivoBank PDF differential and Ledger parity against pinned core', coreImporterTestOptions, async () => {
  const PLUGIN_DIR = path.join(ROOT_DIR, 'plugins/pt-activobank');
  const { default: PdfParserActivobankService } = await importLegacyOracle('services/pdf-parser/pdf-parser-activobank.service.js');
  const { CsvDataService } = await importLegacyOracle('services/pdf-parser/csv-data.service.js');
  const { TransformService } = await importCore('services/csv-transformer/transform.service.js');
  const { statementEvidence, statementDiagnostics } = await importLegacyOracle('model/statement-evidence.js');
  const { LedgerRepository } = await importCore('application/ledger/repository.js');

  const loaded = await loadPlugin(PLUGIN_DIR);
  const sdk = createImporterSdk();
  const parser = new PdfParserActivobankService();

  // 1. Differential parity on rollover, multipage, compat-05, and full-year-date PDFs
  const fullYearPdf = buildPositionedPdf([[
    ...ACTIVOBANK_HEADER,
    [70, 680, '03/02/2026'], [125, 680, '03/02/2026'], [170, 680, 'Cafe;'], [200, 680, '"Central"'], [380, 680, '12,50'], [535, 680, '87,50'],
  ]]);

  for (const [label, bytes] of [
    ['activobank-rollover.pdf', fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures/activobank-rollover.pdf'))],
    ['activobank-multipage.pdf', fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures/activobank-multipage.pdf'))],
    ['inferred-year-activobank.pdf', fs.readFileSync(path.join(ROOT_DIR, 'fixtures/compatibility/inputs/inferred-year-activobank.pdf'))],
    ['full-year-date.pdf', fullYearPdf],
  ]) {
    const input = await prepareImportInput({ fileName: label, bytes });
    const pluginResult = await runParse(loaded, input, sdk);
    const compat = toLegacyTransactions(pluginResult, { rawPdfValues: true });
    const legacyTxs = await parser.parsePdf(Buffer.from(bytes));

    assert.deepEqual(compat.transactions, legacyTxs, `Transaction mismatch for ${label}`);

    const legacyEvidence = legacyTxs.map(tx => statementEvidence.get(tx));
    assert.deepEqual(
      compat.evidenceByIndex.map(ev => ({
        row: ev.row,
        page: ev.page,
        rawAmount: ev.rawAmount,
        rawDate: ev.rawDate,
        yearInferred: ev.yearInferred === true,
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
      legacyDiags,
      `Diagnostics mismatch for ${label}`,
    );

    // For inputs without thousands dots in value, legacy CsvDataService + bank matches toLegacyNormalizedCsv
    if (label !== 'activobank-multipage.pdf') {
      const legacyCsvLines = new CsvDataService(legacyTxs).exportToCsv().split('\n');
      const expectedCsv = [
        'date;description;cleanDescription;category;value;bank',
        ...legacyCsvLines.slice(1).map(line => `${line};ActivoBank`),
      ].join('\n');
      assert.equal(toLegacyNormalizedCsv(pluginResult, 'ActivoBank'), expectedCsv, `Normalized CSV mismatch for ${label}`);
    }
  }

  for (const negFile of ['negative-header-only.pdf', 'negative-unrelated.pdf']) {
    const bytes = fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures', negFile));
    await assert.rejects(() => parser.parsePdf(bytes));
  }

  // 2. Ledger staging, yearInferred confirmation, overlap detection, zero running balance, and reconciliation
  const tmpLedgerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-activobank-ledger-'));
  fs.writeFileSync(path.join(tmpLedgerRoot, 'categories.json'), JSON.stringify([
    { name: 'Compras', description: '', color: '#000000', search: ['Cafe'] },
    { name: 'Self Transfer', description: '', color: '#111111', search: ['Transferencia'] },
    { name: 'Income', description: '', color: '#222222', search: ['Deposito'] },
  ]));
  fs.writeFileSync(path.join(tmpLedgerRoot, 'descriptions.json'), '[]');

  const repository = new LedgerRepository(path.join(tmpLedgerRoot, '.ledger'));
  try {
    const { ledger, importerId, expectedDigest } = await configureCoreImporter(repository, tmpLedgerRoot, PLUGIN_DIR);
    const account = ledger.saveAccount({
      name: 'ActivoBank Main',
      institution: 'ActivoBank',
      kind: 'bank',
      currency: 'EUR',
      openingBalance: 0,
      openingDate: '30/12/2025',
    });

    const rolloverBytes = fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures/activobank-rollover.pdf'));
    const pluginInput = await prepareImportInput({ fileName: 'activobank-rollover.pdf', bytes: rolloverBytes });
    const pluginResult = await runParse(loaded, pluginInput, sdk);
    const pluginLegacy = toLegacyTransactions(pluginResult, { rawPdfValues: true });

    const staged = await ledger.imports.stage('activobank-rollover.pdf', importerId, rolloverBytes, { expectedDigest });
    assert.equal(staged.source, 'ActivoBank');
    assert.equal(staged.pluginProvenance.id, importerId);
    assert.equal(staged.pluginProvenance.digest, expectedDigest);
    assert.equal(staged.rows.length, 4);
    assert.deepEqual(
      staged.rows.map(r => [r.date, r.rawDescription, r.amount, r.runningBalance, r.yearInferred]),
      [
        ['31/12/2025', 'Deposito Inicial', 50000, 50000, true],
        ['05/01/2026', 'Cafe', -1250, 48750, true],
        ['05/01/2026', 'Cafe', -1250, 47500, true],
        ['06/01/2026', 'Transferencia', -47500, 0, true],
      ],
    );

    // yearInferred requires explicit date confirmation on commit
    assert.throws(
      () => ledger.imports.commit(staged.id, staged.rulesRevision, staged.rows.map(r => ({
        row: r.row,
        accountId: account.id,
        disposition: 'add',
        date: '',
      }))),
      /confirm the date because the PDF omitted the year/,
    );

    // Commit using dates converted from plugin result via sdk/compat.mjs
    const committed = ledger.imports.commit(
      staged.id,
      staged.rulesRevision,
      staged.rows.map((r, idx) => ({
        row: r.row,
        accountId: account.id,
        disposition: 'add',
        date: pluginLegacy.transactions[idx].date,
      })),
    );
    assert.equal(committed.status, 'committed');
    assert.equal(committed.inserted, 4);

    // Verify source_records retained zero runningBalance and all 4 movements committed
    const sourceBalances = repository.all(
      'SELECT row, runningBalance FROM source_records WHERE batchId=? ORDER BY row',
      committed.id,
    );
    assert.deepEqual(sourceBalances.map(s => s.runningBalance), [50000, 48750, 47500, 0]);

    // Confirm closing statement zero balance observation and reconcile
    const lastMovement = ledger.movements({ account: account.id }).rows.find(m => m.description === 'Transferencia');
    assert.ok(lastMovement);
    ledger.saveObservation({
      accountId: account.id,
      date: '06/01/2026',
      kind: 'actual',
      amount: 0,
      sourceMovementId: lastMovement.id,
      sourceClosingConfirmed: true,
    });
    const recon = ledger.reconcile(account.id, '06/01/2026');
    assert.equal(recon.status, 'matched');
    assert.equal(recon.calculated, 0);
    assert.equal(recon.actual.amount, 0);
    assert.equal(recon.difference, 0);

    // Overlap detection: staging a second statement containing an identical 01.05 Cafe row finds candidates
    const overlapPdf = Buffer.from(buildPositionedPdf([[
      [50, 760, '26/01/30 EXT. N. 2026/001'],
      ...ACTIVOBANK_HEADER,
      [70, 680, '01.05'], [125, 680, '01.05'], [170, 680, 'Cafe'], [380, 680, '12,50'], [535, 680, '475,00'],
    ]]));
    const overlapStaged = await ledger.imports.stage('overlap.pdf', importerId, overlapPdf, { expectedDigest });
    assert.equal(overlapStaged.rows[0].candidates.length, 2);

    // Normalized CSV from plugin (categorized downstream via TransformService) stages cleanly into Ledger
    const transformer = new TransformService({
      categories: JSON.parse(fs.readFileSync(path.join(tmpLedgerRoot, 'categories.json'), 'utf8')),
      descriptions: [],
    });
    const normCsvLines = toLegacyNormalizedCsv(pluginResult, 'ActivoBank').split('\n');
    const categorizedCsv = [
      normCsvLines[0],
      ...normCsvLines.slice(1).map(line => {
        const cols = line.split(';');
        cols[2] = transformer.cleanDescription(cols[1]);
        cols[3] = transformer.setCategory(cols[1]);
        return cols.join(';');
      }),
    ].join('\n');
    const normStaged = await ledger.imports.stage('plugin-normalized.csv', 'Normalized CSV', Buffer.from(categorizedCsv, 'utf8'));
    assert.equal(normStaged.rows.length, 4);
    assert.deepEqual(
      normStaged.rows.map(r => [r.date, r.rawDescription, r.category, r.amount]),
      [
        ['31/12/2025', 'Deposito Inicial', 'Income', 50000],
        ['05/01/2026', 'Cafe', 'Compras', -1250],
        ['05/01/2026', 'Cafe', 'Compras', -1250],
        ['06/01/2026', 'Transferencia', 'Self Transfer', -47500],
      ],
    );
  } finally {
    repository.close();
    fs.rmSync(tmpLedgerRoot, { recursive: true, force: true });
  }
});

const BANKINTER_HEADER = [
  [0, 700, 'Data'], [18, 700, 'Movimento'],
  [68, 700, 'Data'], [84, 700, 'Valor'],
  [110, 700, 'Descrição'], [305, 700, 'Transação'],
  [350, 700, 'Montante'], [394, 700, 'Moeda'],
  [422, 700, 'Saldo'], [470, 700, 'Taxa'], [490, 700, 'Câmbio'],
];

test('BankInter PDF differential and Ledger parity against pinned core', coreImporterTestOptions, async () => {
  const PLUGIN_DIR = path.join(ROOT_DIR, 'plugins/pt-bankinter');
  const { default: PdfParserBankinterService } = await importLegacyOracle('services/pdf-parser/pdf-parser-bankinter.service.js');
  const { CsvDataService } = await importLegacyOracle('services/pdf-parser/csv-data.service.js');
  const { TransformService } = await importCore('services/csv-transformer/transform.service.js');
  const { statementEvidence, statementDiagnostics } = await importLegacyOracle('model/statement-evidence.js');
  const { LedgerRepository } = await importCore('application/ledger/repository.js');

  const loaded = await loadPlugin(PLUGIN_DIR);
  const sdk = createImporterSdk();
  const parser = new PdfParserBankinterService();

  const shiftedTaxaPdf = buildPositionedPdf([[
    [0, 700, 'Data'], [22, 700, 'Movimento'],
    [70, 700, 'Data'], [86, 700, 'Valor'],
    [115, 700, 'Descrição'], [290, 700, 'Transação'],
    [338, 700, 'Montante'], [386, 700, 'Moeda'],
    [418, 700, 'Saldo'], [462, 700, 'Taxa'], [482, 700, 'Câmbio'],
    [0, 680, '06-02-2026'], [70, 680, '06-02-2026'], [115, 680, 'Taxa'], [138, 680, 'Cambio'],
    [418, 680, '97,50'], [462, 680, '2,50'],
    [115, 640, 'Conforme'],
  ]]);

  for (const [label, bytes] of [
    ['bankinter-standard.pdf', fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures/bankinter-standard.pdf'))],
    ['bankinter-multipage-currency.pdf', fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures/bankinter-multipage-currency.pdf'))],
    ['statementPdf-BankInter.pdf', statementPdf('BankInter')],
    ['shifted-taxa.pdf', shiftedTaxaPdf],
  ]) {
    const input = await prepareImportInput({ fileName: label, bytes });
    const pluginResult = await runParse(loaded, input, sdk);
    const compat = toLegacyTransactions(pluginResult, { rawPdfValues: true });
    const legacyTxs = await parser.parsePdf(Buffer.from(bytes));

    assert.deepEqual(compat.transactions, legacyTxs, `Transaction mismatch for ${label}`);

    const legacyEvidence = legacyTxs.map(tx => statementEvidence.get(tx));
    assert.deepEqual(
      compat.evidenceByIndex.map(ev => ({
        row: ev.row,
        page: ev.page,
        rawAmount: ev.rawAmount,
        rawDate: ev.rawDate,
        yearInferred: ev.yearInferred === true,
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
      legacyDiags,
      `Diagnostics mismatch for ${label}`,
    );

    const legacyCsvLines = new CsvDataService(legacyTxs).exportToCsv().split('\n');
    const expectedCsv = [
      'date;description;cleanDescription;category;value;bank',
      ...legacyCsvLines.slice(1).map(line => `${line};BankInter`),
    ].join('\n');
    assert.equal(toLegacyNormalizedCsv(pluginResult, 'BankInter'), expectedCsv, `Normalized CSV mismatch for ${label}`);
  }

  for (const negFile of ['negative-empty-table.pdf', 'negative-unrelated.pdf']) {
    const bytes = fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures', negFile));
    await assert.rejects(() => parser.parsePdf(bytes));
  }

  // Ledger staging, commit, repeated rows, zero running balance, overlap detection, and reconciliation
  const tmpLedgerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-bankinter-ledger-'));
  fs.writeFileSync(path.join(tmpLedgerRoot, 'categories.json'), JSON.stringify([
    { name: 'Income', description: '', color: '#222222', search: ['Vencimento'] },
    { name: 'Compras', description: '', color: '#000000', search: ['Cafe'] },
    { name: 'Bank Fees', description: '', color: '#333333', search: ['Comissao'] },
    { name: 'Self Transfer', description: '', color: '#111111', search: ['Transferencia'] },
  ]));
  fs.writeFileSync(path.join(tmpLedgerRoot, 'descriptions.json'), '[]');

  const repository = new LedgerRepository(path.join(tmpLedgerRoot, '.ledger'));
  try {
    const { ledger, importerId, expectedDigest } = await configureCoreImporter(repository, tmpLedgerRoot, PLUGIN_DIR);
    const account = ledger.saveAccount({
      name: 'BankInter Main',
      institution: 'BankInter',
      kind: 'bank',
      currency: 'EUR',
      openingBalance: 0,
      openingDate: '01/02/2026',
    });

    const standardBytes = fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures/bankinter-standard.pdf'));
    const pluginInput = await prepareImportInput({ fileName: 'bankinter-standard.pdf', bytes: standardBytes });
    const pluginResult = await runParse(loaded, pluginInput, sdk);

    const staged = await ledger.imports.stage('bankinter-standard.pdf', importerId, standardBytes, { expectedDigest });
    assert.equal(staged.source, 'BankInter');
    assert.equal(staged.pluginProvenance.id, importerId);
    assert.equal(staged.pluginProvenance.digest, expectedDigest);
    assert.equal(staged.rows.length, 5);
    assert.deepEqual(
      staged.rows.map(r => [r.date, r.rawDescription, r.amount, r.runningBalance, r.yearInferred]),
      [
        ['02/02/2026', 'Vencimento Mensal', 125000, 125000, false],
        ['03/02/2026', 'Cafe Central', -1250, 123750, false],
        ['03/02/2026', 'Cafe Central', -1250, 122500, false],
        ['04/02/2026', 'Comissao Conversao', -250, 122250, false],
        ['05/02/2026', 'Transferencia Final', -122250, 0, false],
      ],
    );

    const committed = ledger.imports.commit(
      staged.id,
      staged.rulesRevision,
      staged.rows.map(r => ({
        row: r.row,
        accountId: account.id,
        disposition: 'add',
        date: '',
      })),
    );
    assert.equal(committed.status, 'committed');
    assert.equal(committed.inserted, 5);

    const sourceBalances = repository.all(
      'SELECT row, runningBalance FROM source_records WHERE batchId=? ORDER BY row',
      committed.id,
    );
    assert.deepEqual(sourceBalances.map(s => s.runningBalance), [125000, 123750, 122500, 122250, 0]);

    const lastMovement = ledger.movements({ account: account.id }).rows.find(m => m.description === 'Transferencia Final');
    assert.ok(lastMovement);
    ledger.saveObservation({
      accountId: account.id,
      date: '05/02/2026',
      kind: 'actual',
      amount: 0,
      sourceMovementId: lastMovement.id,
      sourceClosingConfirmed: true,
    });
    const recon = ledger.reconcile(account.id, '05/02/2026');
    assert.equal(recon.status, 'matched');
    assert.equal(recon.calculated, 0);
    assert.equal(recon.actual.amount, 0);
    assert.equal(recon.difference, 0);

    // Overlap detection: staging a second statement containing an identical 03-02-2026 Cafe Central row finds both candidates
    const overlapPdf = Buffer.from(buildPositionedPdf([[
      ...BANKINTER_HEADER,
      [0, 680, '03-02-2026'], [68, 680, '03-02-2026'], [110, 680, 'Cafe'], [130, 680, 'Central'], [350, 680, '-12,50'], [422, 680, '1.225,00'],
      [110, 640, 'Conforme'],
    ]]));
    const overlapStaged = await ledger.imports.stage('overlap.pdf', importerId, overlapPdf, { expectedDigest });
    assert.equal(overlapStaged.rows[0].candidates.length, 2);

    // Normalized CSV from plugin (categorized downstream via TransformService) stages cleanly into Ledger
    const transformer = new TransformService({
      categories: JSON.parse(fs.readFileSync(path.join(tmpLedgerRoot, 'categories.json'), 'utf8')),
      descriptions: [],
    });
    const normCsvLines = toLegacyNormalizedCsv(pluginResult, 'BankInter').split('\n');
    const categorizedCsv = [
      normCsvLines[0],
      ...normCsvLines.slice(1).map(line => {
        const cols = line.split(';');
        cols[2] = transformer.cleanDescription(cols[1]);
        cols[3] = transformer.setCategory(cols[1]);
        return cols.join(';');
      }),
    ].join('\n');
    const normStaged = await ledger.imports.stage('plugin-normalized.csv', 'Normalized CSV', Buffer.from(categorizedCsv, 'utf8'));
    assert.equal(normStaged.rows.length, 5);
    assert.deepEqual(
      normStaged.rows.map(r => [r.date, r.rawDescription, r.category, r.amount]),
      [
        ['02/02/2026', 'Vencimento Mensal', 'Income', 125000],
        ['03/02/2026', 'Cafe Central', 'Compras', -1250],
        ['03/02/2026', 'Cafe Central', 'Compras', -1250],
        ['04/02/2026', 'Comissao Conversao', 'Bank Fees', -250],
        ['05/02/2026', 'Transferencia Final', 'Self Transfer', -122250],
      ],
    );
  } finally {
    repository.close();
    fs.rmSync(tmpLedgerRoot, { recursive: true, force: true });
  }
});
