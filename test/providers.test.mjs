import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildProviderCatalog, verifyProviderHistory } from '../scripts/build-provider-catalog.mjs';
import { packageProvider } from '../scripts/package-provider.mjs';
import { parseDeterministicZip } from '../scripts/lib/deterministic-zip.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('provider catalog records exact deterministic artifacts separately from importers', t => {
  const catalog = buildProviderCatalog({ check: true });
  const importers = JSON.parse(fs.readFileSync(path.join(root, 'registry.json'), 'utf8'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-provider-zip-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  for (const { id, sourcePath, digest, sha256, sizeBytes, packageFile } of catalog.releases.filter(release => {
    const manifestPath = path.join(root, release.sourcePath, 'plugin.json');
    return fs.existsSync(manifestPath) && JSON.parse(fs.readFileSync(manifestPath)).version === release.version;
  })) {
    assert.ok(!importers.plugins.some(importer => importer.id === id));
    const folder = path.join(root, sourcePath);
    const pkg = packageProvider(folder, out);
    assert.deepEqual([pkg.digest, pkg.sha256, pkg.sizeBytes, pkg.fileName], [digest, sha256, sizeBytes, packageFile]);
    const bytes = fs.readFileSync(path.join(out, packageFile));
    assert.deepEqual(packageProvider(folder).bytes, bytes);
    assert.equal(fs.readFileSync(path.join(out, `${packageFile}.sha256`), 'utf8'), `${sha256}  ${packageFile}\n`);
    assert.ok(parseDeterministicZip(bytes, { strictDeterministic: true }).entries.some(entry => entry.path === 'plugin.json'));
  }
  const modified = structuredClone(catalog);
  modified.releases[0].sha256 = '0'.repeat(64);
  assert.throws(() => verifyProviderHistory(catalog, modified), /immutable provider release/);
  assert.throws(() => verifyProviderHistory(catalog, { releases: [] }), /immutable provider release/);
});

test('provider packager rejects invalid manifests and linked files', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-provider-invalid-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(root, 'providers/synthetic-fx');
  fs.cpSync(source, directory, { recursive: true });
  const manifestFile = path.join(directory, 'plugin.json');
  const valid = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  for (const invalid of [
    { ...valid, capabilities: {} },
    { ...valid, routes: [] },
    { ...valid, permissions: [] },
    { ...valid, capabilities: { fx: valid.capabilities.fx, quote: valid.capabilities.fx } },
  ]) {
    fs.writeFileSync(manifestFile, JSON.stringify(invalid));
    assert.throws(() => packageProvider(directory), /Provider manifest/);
  }
  fs.writeFileSync(manifestFile, JSON.stringify(valid));
  fs.symlinkSync('index.mjs', path.join(directory, 'alias.mjs'));
  assert.throws(() => packageProvider(directory), /regular package file/);
});
