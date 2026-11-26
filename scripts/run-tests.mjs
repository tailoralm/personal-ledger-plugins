import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SEARCH_ROOTS = ['test', 'templates', 'plugins'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist-packages']);

function findTestFiles(dir, collected = []) {
  if (!fs.existsSync(dir)) {
    return collected;
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        findTestFiles(path.join(dir, entry.name), collected);
      }
    } else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
      collected.push(path.join(dir, entry.name));
    }
  }
  return collected;
}

const testFiles = [];
for (const root of SEARCH_ROOTS) {
  findTestFiles(path.join(ROOT_DIR, root), testFiles);
}

if (testFiles.length === 0) {
  console.error('No *.test.mjs files found.');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  cwd: ROOT_DIR,
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
