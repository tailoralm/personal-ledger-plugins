import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ImporterError } from '../../../sdk/index.mjs';
import { loadPlugin, prepareImportInput, runDetection, runParse, validatePluginContract } from '../../../sdk/harness.mjs';

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('typescript-importer passes full SDK v1 contract validation', async () => {
  const { manifest, fixtureResults } = await validatePluginContract(PLUGIN_DIR);
  assert.equal(manifest.id, 'example-pdf-bank');
  assert.equal(fixtureResults.length, 3);
});

test('typescript-importer dist/importer.mjs is self-contained with zero imports', () => {
  const built = fs.readFileSync(path.join(PLUGIN_DIR, 'dist/importer.mjs'), 'utf8');
  assert.equal(/\bimport\b|\brequire\s*\(/.test(built), false);
});

test('typescript-importer parses multi-page valid.pdf with year inference, real zero balance, and diagnostics', async () => {
  const loaded = await loadPlugin(PLUGIN_DIR);
  const bytes = fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures/valid.pdf'));
  const input = await prepareImportInput({ fileName: 'valid.pdf', bytes, limits: loaded.manifest.limits });
  const result = await runParse(loaded, input);

  assert.equal(result.transactions.length, 3);
  assert.deepEqual(result.transactions.map(t => [t.date, t.description, t.amount, t.balance]), [
    ['2025-12-31', 'Compra Café', '-12.50', '1000.00'],
    ['2026-01-05', 'Salário Mensal', '1500.00', '2500.00'],
    ['2026-01-10', 'Transferência Poupança', '-2500.00', '0.00'],
  ]);
  assert.equal(result.transactions[0].evidence.yearInferred, true);
  assert.equal(result.transactions[0].evidence.rawDate, '12.31');
  assert.equal(result.transactions[0].evidence.page, 1);
  assert.equal(result.transactions[2].evidence.page, 2);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].rawDate, '02.30');
});

test('typescript-importer preserves duplicate rows and supports CSV secondary format', async () => {
  const loaded = await loadPlugin(PLUGIN_DIR);
  const dupBytes = fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures/duplicates.pdf'));
  const dupInput = await prepareImportInput({ fileName: 'duplicates.pdf', bytes: dupBytes });
  const dupResult = await runParse(loaded, dupInput);

  assert.equal(dupResult.transactions.length, 2);
  assert.equal(dupResult.transactions[0].description, 'Cafe Esquina');
  assert.equal(dupResult.transactions[1].description, 'Cafe Esquina');
  assert.notEqual(dupResult.transactions[0].evidence.row, dupResult.transactions[1].evidence.row);

  const csvContent = 'Data,Descritivo,Debito,Credito,Saldo\n05/08/2026,Compra Café,"12,50",,"100,00"\n';
  const csvInput = await prepareImportInput({ fileName: 'statement.csv', text: csvContent });
  const csvDetect = await runDetection(loaded, csvInput);
  assert.equal(csvDetect.matched, true);
  const csvResult = await runParse(loaded, csvInput);
  assert.equal(csvResult.transactions.length, 1);
  assert.equal(csvResult.transactions[0].date, '2026-08-05');
  assert.equal(csvResult.transactions[0].amount, '-12.50');
  assert.equal(csvResult.transactions[0].balance, '100.00');
});

test('typescript-importer rejects negative-unrelated.pdf cleanly', async () => {
  const loaded = await loadPlugin(PLUGIN_DIR);
  const negBytes = fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures/negative-unrelated.pdf'));
  const negInput = await prepareImportInput({ fileName: 'negative-unrelated.pdf', bytes: negBytes });
  const detection = await runDetection(loaded, negInput);
  assert.equal(detection.matched, false);
  assert.equal(detection.confidence, 0);
  await assert.rejects(() => runParse(loaded, negInput), err => err instanceof ImporterError);
});
