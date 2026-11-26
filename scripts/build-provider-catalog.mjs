import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { assertValidSchema, deepEqual } from './lib/schema-validator.mjs';
import { comparePosixPaths } from './lib/deterministic-zip.mjs';
import { packageProvider } from './package-provider.mjs';

const rootDir = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(rootDir, 'schemas/provider-catalog.v1.schema.json'), 'utf8'));
const releaseKey = entry => `${entry.id}@${entry.version}`;

export function verifyProviderHistory(previous, current) {
  for (const entry of previous.releases) {
    const currentEntry = current.releases.find(candidate => releaseKey(candidate) === releaseKey(entry));
    if (!deepEqual(entry, currentEntry)) throw new Error(`Changed or removed immutable provider release "${releaseKey(entry)}".`);
  }
}

export function buildProviderCatalog({ check = false, baseline } = {}) {
  const catalogPath = path.join(rootDir, 'provider-catalog.json');
  const previous = fs.existsSync(catalogPath)
    ? JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
    : { catalogVersion: 1, releases: [] };
  assertValidSchema(schema, previous, 'Provider catalog');
  const releases = new Map(previous.releases.map(entry => [releaseKey(entry), entry]));
  if (releases.size !== previous.releases.length) throw new Error('Duplicate provider release keys.');
  const ids = new Set();
  for (const folder of fs.readdirSync(path.join(rootDir, 'providers'))) {
    const sourcePath = `providers/${folder}`;
    const pkg = packageProvider(path.join(rootDir, sourcePath));
    const { id, name, type, pluginApiVersion, version } = pkg.manifest;
    if (ids.has(id)) throw new Error(`Duplicate provider id "${id}".`);
    ids.add(id);
    const tag = `provider/${id}@${version}`;
    const entry = {
      id, name, type, pluginApiVersion, version, sourcePath, tag,
      packageFile: pkg.fileName, sha256: pkg.sha256, digest: pkg.digest, sizeBytes: pkg.sizeBytes,
    };
    const key = releaseKey(entry);
    const old = releases.get(key);
    if (old && !deepEqual(old, entry)) throw new Error(`Changed immutable provider release "${key}". Bump the manifest version.`);
    releases.set(key, entry);
  }
  const catalog = { catalogVersion: 1, releases: [...releases.values()].sort((a, b) => comparePosixPaths(releaseKey(a), releaseKey(b))) };
  assertValidSchema(schema, catalog, 'Provider catalog');
  if (baseline) verifyProviderHistory(JSON.parse(fs.readFileSync(baseline, 'utf8')), catalog);
  const json = `${JSON.stringify(catalog, null, 2)}\n`;
  if (check) {
    if (json !== fs.readFileSync(catalogPath, 'utf8')) throw new Error('Provider catalog is stale. Run npm run provider:catalog:build.');
  } else {
    fs.writeFileSync(catalogPath, json);
  }
  return catalog;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { check: { type: 'boolean' }, baseline: { type: 'string' } } });
  const catalog = buildProviderCatalog(values);
  console.log(`Provider catalog contains ${catalog.releases.length} immutable release record(s).`);
}
