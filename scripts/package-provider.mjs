import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { buildDeterministicZip, comparePosixPaths, parseDeterministicZip, ZIP_LIMITS } from './lib/deterministic-zip.mjs';
import { assertValidSchema } from './lib/schema-validator.mjs';
import { scanPrivacyAndSecrets } from './lib/security-scan.mjs';

const manifestSchema = JSON.parse(fs.readFileSync(new URL(
  '../schemas/market-data/v1/provider-manifest.v1.schema.json', import.meta.url,
), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function readPackage(folder) {
  const entries = [];
  let totalBytes = 0;
  const names = new Set();
  function visit(relative) {
    const file = path.join(folder, relative);
    const stat = fs.lstatSync(file);
    if (relative) {
      const folded = relative.toLowerCase();
      const segment = path.basename(relative);
      if (relative.length > 240 || names.size >= 512 || names.has(folded) ||
          !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(segment) || segment.endsWith('.') ||
          /^(?:node_modules$|(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$))/i.test(segment)) {
        throw new Error(`Unsafe provider package path "${relative}".`);
      }
      names.add(folded);
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file)) visit(relative ? `${relative}/${name}` : name);
    } else {
      if (!relative || !stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) {
        throw new Error(`Expected a bounded regular package file at "${file}".`);
      }
      totalBytes += stat.size;
      if (totalBytes > ZIP_LIMITS.maxCompressedZipBytes || entries.length >= ZIP_LIMITS.maxEntries) {
        throw new Error('Provider package exceeds repository ZIP limits.');
      }
      const data = fs.readFileSync(file);
      if (/\.(?:m?js|json|md|txt)$/i.test(relative)) {
        const contents = new TextDecoder('utf-8', { fatal: true }).decode(data);
        const scan = scanPrivacyAndSecrets(contents, relative);
        if (!scan.ok) throw new Error(`Privacy scan failed for "${relative}": ${scan.errors.map(entry => entry.rule).join(', ')}.`);
      }
      entries.push({ path: relative, data });
    }
  }
  visit('');
  return entries.sort((a, b) => comparePosixPaths(a.path, b.path));
}

export function packageProvider(folder, outDir) {
  const entries = readPackage(folder);
  const files = new Map(entries.map(entry => [entry.path, entry.data]));
  if (!files.has('plugin.json')) throw new Error('Provider needs a root plugin.json.');
  const manifest = JSON.parse(files.get('plugin.json').toString('utf8'));
  assertValidSchema(manifestSchema, manifest, 'Provider manifest');
  if (!files.has(manifest.entrypoint)) throw new Error('Provider entrypoint is missing.');

  // Approval identity hashes the sorted paths and file contents, as in core packageDigest.
  const hash = createHash('sha256');
  for (const entry of entries) hash.update(JSON.stringify([entry.path, sha256(entry.data)]));
  const digest = hash.digest('hex');
  const fileName = `${manifest.id}-${manifest.version}.zip`;
  // Stored entries keep provider release bytes stable across zlib versions.
  const bytes = buildDeterministicZip(entries, { store: true });
  parseDeterministicZip(bytes, { strictDeterministic: true });
  const checksum = sha256(bytes);
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, fileName), bytes);
    fs.writeFileSync(path.join(outDir, `${fileName}.sha256`), `${checksum}  ${fileName}\n`);
  }
  return { manifest, fileName, bytes, sha256: checksum, digest, sizeBytes: bytes.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'out-dir': { type: 'string' } } });
  if (positionals.length !== 1) throw new Error('Usage: npm run provider:package -- <folder> [--out-dir <directory>]');
  const pkg = packageProvider(positionals[0], values['out-dir'] ?? fileURLToPath(new URL('../dist-packages', import.meta.url)));
  console.log(`Packaged ${pkg.fileName} (ZIP SHA-256 ${pkg.sha256}, package digest ${pkg.digest})`);
}
