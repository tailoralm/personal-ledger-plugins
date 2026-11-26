import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildDeterministicZip,
  comparePosixPaths,
  validateArchiveEntryPath,
  validateArchiveFileName,
} from './lib/deterministic-zip.mjs';
import { validateManifestSemantics } from './lib/schema-validator.mjs';
import { stripJsTsCommentsAndLiterals } from './lib/security-scan.mjs';

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MANIFEST_SCHEMA = JSON.parse(
  fs.readFileSync(path.join(ROOT_DIR, 'schemas/plugin-manifest.v1.schema.json'), 'utf8'),
);

const ALLOWED_ROOT_DIRS = new Set(['dist', 'src', 'fixtures', 'test']);
const ALLOWED_ROOT_FILES = new Set([
  'manifest.json',
  'README.md',
  'CHANGELOG.md',
  'importer.mjs',
  'tsconfig.json',
]);
const IGNORED_NAMES = new Set(['node_modules', 'dist-packages', '.git']);
const TEMP_ARTIFACT_RE = /\.(?:tmp|bak|log|swp|swo|zip|tgz|sha256)$/i;

function isAllowedRootFile(name, entrypoint) {
  if (ALLOWED_ROOT_FILES.has(name)) return true;
  if (/^LICENSE(?:\..+)?$/i.test(name)) return true;
  if (entrypoint === name) return true;
  return false;
}

function isIgnoredEntryName(name) {
  return name.startsWith('.') || IGNORED_NAMES.has(name) || TEMP_ARTIFACT_RE.test(name);
}

function assertNotSymlink(fullPath, displayPath) {
  const stat = fs.lstatSync(fullPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to package symlink "${displayPath}".`);
  }
  return stat;
}

function collectSubtree(baseDir, relDir, outEntries) {
  const fullDir = path.join(baseDir, relDir);
  const items = fs.readdirSync(fullDir).sort(comparePosixPaths);

  for (const name of items) {
    const relPosix = `${relDir}/${name}`;
    const fullPath = path.join(fullDir, name);
    const stat = assertNotSymlink(fullPath, relPosix);

    if (isIgnoredEntryName(name)) {
      continue;
    }

    if (stat.isDirectory()) {
      collectSubtree(baseDir, relPosix, outEntries);
    } else if (stat.isFile()) {
      outEntries.push({
        path: relPosix,
        data: fs.readFileSync(fullPath),
      });
    }
  }
}

export function collectPluginPackageEntries(pluginDir) {
  const resolvedDir = path.resolve(pluginDir);
  if (!fs.existsSync(resolvedDir)) {
    throw new Error(`Plugin directory "${pluginDir}" does not exist.`);
  }
  const rootStat = assertNotSymlink(resolvedDir, pluginDir);
  if (!rootStat.isDirectory()) {
    throw new Error(`Plugin path "${pluginDir}" is not a directory.`);
  }

  const manifestPath = path.join(resolvedDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing manifest.json in "${pluginDir}".`);
  }
  assertNotSymlink(manifestPath, 'manifest.json');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  validateManifestSemantics(manifest, MANIFEST_SCHEMA);

  const fileName = validateArchiveFileName(`${manifest.id}-${manifest.version}.zip`);

  const entrypointRel = manifest.entrypoint.replace(/^\.\//, '');
  const entrypointAbs = path.resolve(resolvedDir, entrypointRel);
  if (!entrypointAbs.startsWith(resolvedDir + path.sep)) {
    throw new Error(`Entrypoint "${manifest.entrypoint}" escapes plugin directory.`);
  }
  if (!fs.existsSync(entrypointAbs)) {
    throw new Error(`Plugin entrypoint "${manifest.entrypoint}" not found in "${pluginDir}".`);
  }
  const entryStat = assertNotSymlink(entrypointAbs, entrypointRel);
  if (!entryStat.isFile()) {
    throw new Error(`Plugin entrypoint "${manifest.entrypoint}" must be a regular file.`);
  }

  const collected = [];
  const includedPaths = new Set();
  const rootNames = fs.readdirSync(resolvedDir).sort(comparePosixPaths);

  for (const name of rootNames) {
    const fullPath = path.join(resolvedDir, name);
    const stat = assertNotSymlink(fullPath, name);

    if (isIgnoredEntryName(name)) {
      continue;
    }

    if (stat.isDirectory()) {
      if (ALLOWED_ROOT_DIRS.has(name)) {
        collectSubtree(resolvedDir, name, collected);
      }
    } else if (stat.isFile()) {
      if (isAllowedRootFile(name, entrypointRel)) {
        collected.push({
          path: name,
          data: fs.readFileSync(fullPath),
        });
      }
    }
  }

  for (const item of collected) {
    includedPaths.add(item.path);
  }

  const visitedImports = new Set();
  const traceLocalImports = (relPosix) => {
    if (visitedImports.has(relPosix)) return;
    visitedImports.add(relPosix);
    const absFile = path.resolve(resolvedDir, relPosix);
    if (!absFile.startsWith(resolvedDir + path.sep) || !fs.existsSync(absFile)) return;
    assertNotSymlink(absFile, relPosix);
    if (!includedPaths.has(relPosix)) {
      validateArchiveEntryPath(relPosix);
      collected.push({
        path: relPosix,
        data: fs.readFileSync(absFile),
      });
      includedPaths.add(relPosix);
    }

    const { codeOnly, strings } = stripJsTsCommentsAndLiterals(fs.readFileSync(absFile, 'utf8'));
    const re = /\bimport\s*"(__STR_\d+__)"|\b(?:import|export)\s+(?:type\s+)?[^;=()'"`]+?\s+from\s+"(__STR_\d+__)"/g;
    for (const match of codeOnly.matchAll(re)) {
      const specifier = strings.get(match[1] ?? match[2]) ?? '';
      if (!specifier.startsWith('./') || specifier.includes('..')) continue;
      const nextAbs = path.resolve(path.dirname(absFile), specifier);
      if (!nextAbs.startsWith(resolvedDir + path.sep)) continue;
      const nextRel = path.relative(resolvedDir, nextAbs).split(path.sep).join('/');
      traceLocalImports(nextRel);
    }
  };

  traceLocalImports(entrypointRel);

  collected.sort((a, b) => comparePosixPaths(a.path, b.path));

  return {
    manifest,
    fileName,
    entries: collected,
  };
}

export function packagePlugin(pluginDir, outDirOrOptions) {
  const options = typeof outDirOrOptions === 'string'
    ? { outDir: outDirOrOptions }
    : (outDirOrOptions ?? {});

  const { manifest, fileName, entries } = collectPluginPackageEntries(pluginDir);
  const bytes = buildDeterministicZip(entries, { fileName });
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

  const result = {
    id: manifest.id,
    version: manifest.version,
    fileName,
    bytes,
    sha256,
    sizeBytes: bytes.byteLength,
    entries: entries.map(entry => entry.path),
  };

  if (options.outDir) {
    const resolvedOutDir = path.resolve(options.outDir);
    fs.mkdirSync(resolvedOutDir, { recursive: true });
    const outPath = path.join(resolvedOutDir, fileName);
    fs.writeFileSync(outPath, bytes);
    result.outPath = outPath;

    if (options.writeSha256) {
      const sha256Path = `${outPath}.sha256`;
      fs.writeFileSync(sha256Path, `${sha256}  ${fileName}\n`, 'utf8');
      result.sha256Path = sha256Path;
    }
  }

  return result;
}

function parseCliArgs(argv) {
  let pluginDir = null;
  let outDir = path.join(ROOT_DIR, 'dist-packages');
  let writeSha256 = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out-dir') {
      const next = argv[++i];
      if (!next) throw new Error('--out-dir requires a directory argument.');
      outDir = next;
    } else if (arg === '--write-sha256') {
      writeSha256 = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option "${arg}".`);
    } else if (!pluginDir) {
      pluginDir = arg;
    } else {
      throw new Error(`Unexpected extra positional argument "${arg}".`);
    }
  }

  if (!pluginDir) {
    throw new Error('Usage: node scripts/package-plugin.mjs <pluginDir> [--out-dir <dir>] [--write-sha256]');
  }

  return { pluginDir, outDir, writeSha256 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { pluginDir, outDir, writeSha256 } = parseCliArgs(process.argv.slice(2));
    const pkg = packagePlugin(pluginDir, { outDir, writeSha256 });
    console.log(`Packaged ${pkg.fileName} (${pkg.sizeBytes} bytes, sha256=${pkg.sha256})`);
    if (pkg.sha256Path) {
      console.log(`Wrote checksum ${path.relative(process.cwd(), pkg.sha256Path)}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
