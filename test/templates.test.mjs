import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildTemplateProject, loadTypeScript } from '../scripts/build-templates.mjs';
import { toLegacyNormalizedCsv, toLegacyTransactions } from '../sdk/compat.mjs';
import { assertPluginIsolation, loadPlugin, prepareImportInput, runParse, validatePluginContract } from '../sdk/harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('all reference templates pass contract validation, isolation checks, and compat conversions', async () => {
  for (const templateName of ['javascript-importer', 'typescript-importer']) {
    const dir = path.join(ROOT, 'templates', templateName);
    const loaded = await loadPlugin(dir);
    assertPluginIsolation(loaded.entrypointPath, dir);

    const { fixtureResults } = await validatePluginContract(dir);
    assert.ok(fixtureResults.length >= 3);

    const firstPositive = fixtureResults.find(item => item.kind === 'positive');
    assert.ok(firstPositive);

    const legacy = toLegacyTransactions(firstPositive.result);
    assert.equal(legacy.transactions.length, firstPositive.result.transactions.length);
    const csvOut = toLegacyNormalizedCsv(firstPositive.result, loaded.manifest.institution.name);
    assert.ok(csvOut.startsWith('date;description;cleanDescription;category;value;bank\n'));
  }
});

test('buildTemplateProject fails on TypeScript type errors and host globals like Buffer', async () => {
  const ts = await loadTypeScript();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-template-err-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ES2022',
          moduleResolution: 'bundler',
          lib: ['ES2022'],
          types: [],
          strict: true,
          outDir: 'dist',
          rootDir: 'src',
        },
        include: ['src/**/*.ts'],
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src/importer.ts'),
      'export default function bad() { return Buffer.from("forbidden"); }\n',
    );
    await assert.rejects(() => buildTemplateProject(tmpDir, ts), /Cannot find name 'Buffer'/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('typescript-importer dist/importer.mjs parses rawPdfValues compat cleanly', async () => {
  const dir = path.join(ROOT, 'templates/typescript-importer');
  const loaded = await loadPlugin(dir);
  const bytes = fs.readFileSync(path.join(dir, 'fixtures/valid.pdf'));
  const input = await prepareImportInput({ fileName: 'valid.pdf', bytes });
  const result = await runParse(loaded, input);

  const rawCompat = toLegacyTransactions(result, { rawPdfValues: true });
  assert.equal(rawCompat.transactions[0].date, '31/12/2025');
  assert.equal(rawCompat.transactions[0].value, '-12,50');
  assert.equal(rawCompat.transactions[2].balance, '0.00');
});
