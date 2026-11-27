import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const corePin = 'f145429702c100bdeeb5b4311b92f53db6bb0f13';
// Last core revision before #61 retired the in-tree PDF parsers.
const oraclePin = '7f39fe5bf4493c8b629680a68cdd0bc9083be298';
const repo = fileURLToPath(new URL('../', import.meta.url));
const core = path.resolve(process.env.PERSONAL_LEDGER_CORE_SOURCE ??
  '/media/second/workspace/projects/statement-processor');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-provider-core-'));
const snapshot = path.join(scratch, 'source');
const oracle = path.join(scratch, 'oracle');

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', ...options });
}

function snapshotAt(pin, destination) {
  const archive = `${destination}.tar`;
  fs.mkdirSync(destination);
  run('git', ['-C', core, 'archive', '--output', archive, pin]);
  run('tar', ['-xf', archive, '-C', destination]);
  fs.unlinkSync(archive);
}

try {
  snapshotAt(corePin, snapshot);
  snapshotAt(oraclePin, oracle);

  const contract = 'src/application/market-data/v1';
  const parity = new Map([
    ...fs.readdirSync(path.join(snapshot, contract)).map(name => [
      `${contract}/${name}`,
      `${name.endsWith('.json') ? 'schemas' : 'sdk'}/market-data/v1/${name}`,
    ]),
    ['test/fixtures/providers/pages.json', 'fixtures/providers/pages.json'],
  ]);
  for (const provider of ['synthetic-market', 'synthetic-fx']) {
    for (const file of ['index.mjs', 'plugin.json']) {
      parity.set(`test/fixtures/providers/${provider}/${file}`, `providers/${provider}/${file}`);
    }
  }
  for (const [upstream, local] of parity) {
    assert.ok(fs.readFileSync(path.join(repo, local)).equals(fs.readFileSync(path.join(snapshot, upstream))),
      `${local} differs from Personal Ledger ${corePin}:${upstream}`);
  }
  console.log(`Provider contract and examples match Personal Ledger ${corePin}.`);

  const dependencies = path.join(core, 'node_modules');
  if (fs.existsSync(dependencies)) fs.symlinkSync(dependencies, path.join(snapshot, 'node_modules'), 'dir');
  else run('npm', ['ci'], { cwd: snapshot });
  run('npm', ['run', 'build'], { cwd: snapshot });

  const lock = directory => fs.readFileSync(path.join(directory, 'package-lock.json'));
  if (lock(oracle).equals(lock(snapshot))) {
    fs.symlinkSync(path.join(snapshot, 'node_modules'), path.join(oracle, 'node_modules'), 'dir');
  } else {
    run('npm', ['ci'], { cwd: oracle });
  }
  run('npm', ['run', 'build'], { cwd: oracle });
  console.log(`PDF differential oracle built at Personal Ledger ${oraclePin}.`);

  run(process.execPath, ['--test', 'test/market-data.test.mjs', 'test/plugin-manager.test.mjs'], { cwd: snapshot });
  run(process.execPath, ['--test', 'test/provider-core.test.mjs', 'test/importer-core.test.mjs'], {
    cwd: repo,
    env: { ...process.env, PERSONAL_LEDGER_CORE_SNAPSHOT: snapshot, PERSONAL_LEDGER_ORACLE_SNAPSHOT: oracle },
  });
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
