import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createImporterSdk, ImporterError } from '../../../sdk/index.mjs';
import { loadPlugin, prepareImportInput, runDetection, runParse, validatePluginContract } from '../../../sdk/harness.mjs';

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('javascript-importer passes full SDK v1 contract validation', async () => {
  const { manifest, fixtureResults } = await validatePluginContract(PLUGIN_DIR);
  assert.equal(manifest.id, 'example-csv-bank');
  assert.equal(fixtureResults.length, 3);
});

test('javascript-importer parses valid.csv, preserves real zero balance, and reports diagnostics', async () => {
  const loaded = await loadPlugin(PLUGIN_DIR);
  const bytes = fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures/valid.csv'));
  const input = await prepareImportInput({ fileName: 'valid.csv', bytes, limits: loaded.manifest.limits });
  const result = await runParse(loaded, input);

  assert.equal(result.transactions.length, 4);
  assert.deepEqual(result.transactions.map(t => [t.date, t.amount, t.currency, t.balance]), [
    ['2026-08-01', '1850.00', 'EUR', '1850.00'],
    ['2026-08-02', '-12.50', 'EUR', '1837.50'],
    ['2026-08-03', '-25.00', 'USD', '100.00'],
    ['2026-08-06', '-1837.50', 'EUR', '0.00'],
  ]);
  assert.equal(result.transactions[1].description, 'Café Central, Lisboa');
  assert.equal(result.diagnostics.length, 3);
  assert.equal(result.diagnostics[2].rawDate, '2026-02-30 11:00:00');
});

test('javascript-importer preserves duplicate identical purchases and supports includePending option', async () => {
  const loaded = await loadPlugin(PLUGIN_DIR);
  const dupBytes = fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures/duplicates-and-zero.csv'));
  const dupInput = await prepareImportInput({ fileName: 'duplicates-and-zero.csv', bytes: dupBytes });
  const dupResult = await runParse(loaded, dupInput);

  assert.equal(dupResult.transactions.length, 3);
  assert.equal(dupResult.transactions[0].description, 'Corner Coffee');
  assert.equal(dupResult.transactions[1].description, 'Corner Coffee');
  assert.equal(dupResult.transactions[1].balance, '0.00');
  assert.equal(dupResult.transactions[2].amount, '0.00');

  const validBytes = fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures/valid.csv'));
  const withPendingInput = await prepareImportInput({
    fileName: 'valid.csv',
    bytes: validBytes,
    options: { includePending: true },
  });
  const withPending = await runParse(loaded, withPendingInput);
  assert.equal(withPending.transactions.length, 5);
});

test('javascript-importer rejects unrelated CSV and fixes double-encoded UTF-8 mojibake', async () => {
  const loaded = await loadPlugin(PLUGIN_DIR);
  const negBytes = fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures/negative-unrelated.csv'));
  const negInput = await prepareImportInput({ fileName: 'negative-unrelated.csv', bytes: negBytes });
  const detection = await runDetection(loaded, negInput);
  assert.equal(detection.matched, false);
  assert.equal(detection.confidence, 0);
  await assert.rejects(() => runParse(loaded, negInput), err => err instanceof ImporterError);

  // Double-encoded UTF-8 ("Descrição", "Café")
  const original = 'Conta,Estado,Data,Descrição,Montante,Moeda\nCorrente,Concluido,2026-08-02,Café Pão,-3.20,EUR\n';
  const utf8Once = Buffer.from(original, 'utf8');
  const mojibakeBytes = Buffer.from(utf8Once.toString('latin1'), 'utf8');
  const mojiInput = await prepareImportInput({ fileName: 'mojibake.csv', bytes: mojibakeBytes });
  const mojiResult = await runParse(loaded, mojiInput, createImporterSdk());
  assert.equal(mojiResult.transactions[0].description, 'Café Pão');
});
