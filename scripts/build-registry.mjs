import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { comparePosixPaths } from './lib/deterministic-zip.mjs';
import {
  compareSemVer,
  validateManifestSemantics,
  validateRegistrySemantics,
} from './lib/schema-validator.mjs';
import { packagePlugin } from './package-plugin.mjs';

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MANIFEST_SCHEMA = JSON.parse(
  fs.readFileSync(path.join(ROOT_DIR, 'schemas/plugin-manifest.v1.schema.json'), 'utf8'),
);
const REGISTRY_SCHEMA = JSON.parse(
  fs.readFileSync(path.join(ROOT_DIR, 'schemas/registry.v1.schema.json'), 'utf8'),
);

export const DEFAULT_REPOSITORY = 'tailoralm/personal-ledger-plugins';
export const DEFAULT_RAW_REGISTRY_URL =
  'https://raw.githubusercontent.com/tailoralm/personal-ledger-plugins/main/registry.json';

const IMMUTABLE_VERSION_FIELDS = [
  'sha256',
  'sizeBytes',
  'packageFile',
  'tag',
  'downloadUrl',
  'pluginApiVersion',
  'sourcePath',
];

function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractChangelogSection(changelogText, version) {
  const lines = String(changelogText ?? '').split(/\r?\n/);
  const escaped = escapeRegExp(version);
  const targetHeadingRe = new RegExp(`^##\\s+(?:\\[${escaped}\\]|${escaped})(?:\\s+(?:[-–—(].*)?)?$`);
  const nextHeadingRe = /^#{1,2}\s+/;

  let capturing = false;
  const captured = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!capturing) {
      if (targetHeadingRe.test(trimmed)) {
        capturing = true;
      }
      continue;
    }
    if (nextHeadingRe.test(trimmed)) {
      break;
    }
    captured.push(line);
  }

  if (!capturing) {
    throw new Error(`CHANGELOG.md is missing a "## [${version}]" or "## ${version}" section.`);
  }

  const notes = captured.join('\n').trim();
  if (!notes) {
    throw new Error(`CHANGELOG.md section for version "${version}" must not be empty.`);
  }
  return notes;
}

function assertRequiredPluginDocsAndTests(pluginDir, manifest) {
  const readmePath = path.join(pluginDir, 'README.md');
  if (!fs.existsSync(readmePath) || fs.lstatSync(readmePath).isSymbolicLink() || !fs.lstatSync(readmePath).isFile()) {
    throw new Error(`Plugin "${manifest.id}" is missing required README.md.`);
  }
  if (!fs.readFileSync(readmePath, 'utf8').trim()) {
    throw new Error(`Plugin "${manifest.id}" README.md must not be empty.`);
  }

  const changelogPath = path.join(pluginDir, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath) || fs.lstatSync(changelogPath).isSymbolicLink() || !fs.lstatSync(changelogPath).isFile()) {
    throw new Error(`Plugin "${manifest.id}" is missing required CHANGELOG.md.`);
  }
  const changelog = extractChangelogSection(fs.readFileSync(changelogPath, 'utf8'), manifest.version);

  const fixturesDir = path.join(pluginDir, 'fixtures');
  if (!fs.existsSync(fixturesDir) || fs.lstatSync(fixturesDir).isSymbolicLink() || !fs.lstatSync(fixturesDir).isDirectory()) {
    throw new Error(`Plugin "${manifest.id}" is missing required fixtures/ directory.`);
  }
  const fixtureFiles = fs.readdirSync(fixturesDir).filter(name => {
    if (name.startsWith('.')) return false;
    const stat = fs.lstatSync(path.join(fixturesDir, name));
    return !stat.isSymbolicLink() && stat.isFile();
  });
  if (fixtureFiles.length === 0) {
    throw new Error(`Plugin "${manifest.id}" fixtures/ directory must contain at least one fixture file.`);
  }

  const testDir = path.join(pluginDir, 'test');
  if (!fs.existsSync(testDir) || fs.lstatSync(testDir).isSymbolicLink() || !fs.lstatSync(testDir).isDirectory()) {
    throw new Error(`Plugin "${manifest.id}" is missing required test/ directory.`);
  }
  const testFiles = fs.readdirSync(testDir).filter(name => {
    if (!name.endsWith('.test.mjs')) return false;
    const stat = fs.lstatSync(path.join(testDir, name));
    return !stat.isSymbolicLink() && stat.isFile();
  });
  if (testFiles.length === 0) {
    throw new Error(`Plugin "${manifest.id}" test/ directory must contain at least one *.test.mjs file.`);
  }

  return changelog;
}

function discoverPluginDirs(rootDir) {
  const pluginsRoot = path.join(rootDir, 'plugins');
  if (!fs.existsSync(pluginsRoot)) {
    return [];
  }
  const rootStat = fs.lstatSync(pluginsRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`"${pluginsRoot}" must be a regular directory.`);
  }

  const names = fs.readdirSync(pluginsRoot).sort(comparePosixPaths);
  const dirs = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const fullPath = path.join(pluginsRoot, name);
    const stat = fs.lstatSync(fullPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Plugin directory "plugins/${name}" must not be a symlink.`);
    }
    if (stat.isDirectory()) {
      dirs.push(fullPath);
    }
  }
  return dirs;
}

function loadExistingRegistry(rootDir, existingRegistryOption) {
  if (existingRegistryOption !== undefined) {
    return existingRegistryOption;
  }
  const registryPath = path.join(rootDir, 'registry.json');
  if (!fs.existsSync(registryPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
}

export function buildRegistry(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? ROOT_DIR);
  const check = options.check === true;
  const write = options.write !== undefined ? options.write === true : !check;
  const repository = options.repository ?? DEFAULT_REPOSITORY;
  const rawRegistryUrl = options.rawRegistryUrl ?? DEFAULT_RAW_REGISTRY_URL;

  const existingRegistry = loadExistingRegistry(rootDir, options.existingRegistry);
  const existingPluginsById = new Map();
  for (const entry of existingRegistry?.plugins ?? []) {
    existingPluginsById.set(entry.id, entry);
  }

  const pluginDirs = discoverPluginDirs(rootDir);
  const plugins = [];

  for (const pluginDir of pluginDirs) {
    const dirName = path.basename(pluginDir);
    const manifestPath = path.join(pluginDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Missing manifest.json in "plugins/${dirName}".`);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    validateManifestSemantics(manifest, MANIFEST_SCHEMA);

    if (manifest.id !== dirName) {
      throw new Error(
        `Plugin directory name "${dirName}" does not match manifest.id "${manifest.id}".`,
      );
    }

    const changelog = assertRequiredPluginDocsAndTests(pluginDir, manifest);
    const pkg = packagePlugin(pluginDir);

    const currentVersionRecord = {
      version: manifest.version,
      pluginApiVersion: manifest.pluginApiVersion,
      tag: `${manifest.id}@${manifest.version}`,
      packageFile: pkg.fileName,
      downloadUrl: `https://github.com/${repository}/releases/download/${encodeURIComponent(manifest.id)}%40${encodeURIComponent(manifest.version)}/${pkg.fileName}`,
      sourcePath: `plugins/${manifest.id}`,
      sha256: pkg.sha256,
      sizeBytes: pkg.sizeBytes,
      changelog,
    };

    const existingPlugin = existingPluginsById.get(manifest.id);
    const mergedVersions = new Map();

    for (const prevVer of existingPlugin?.versions ?? []) {
      if (prevVer.version === manifest.version) {
        for (const field of IMMUTABLE_VERSION_FIELDS) {
          if (prevVer[field] !== currentVersionRecord[field]) {
            throw new Error(
              `Immutable version conflict for "${manifest.id}@${manifest.version}": field "${field}" changed (${JSON.stringify(prevVer[field])} !== ${JSON.stringify(currentVersionRecord[field])}). Published plugin versions are immutable; bump manifest.version instead.`,
            );
          }
        }
        mergedVersions.set(prevVer.version, currentVersionRecord);
      } else {
        mergedVersions.set(prevVer.version, prevVer);
      }
    }

    if (!mergedVersions.has(manifest.version)) {
      mergedVersions.set(manifest.version, currentVersionRecord);
    }

    const versions = Array.from(mergedVersions.values())
      .sort((a, b) => compareSemVer(b.version, a.version));

    const entry = {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      tier: manifest.tier ?? 'community',
      author: manifest.author,
      license: manifest.license,
      ...(manifest.homepage !== undefined ? { homepage: manifest.homepage } : {}),
      institution: manifest.institution,
      formats: manifest.formats,
      mimeTypes: manifest.mimeTypes,
      extensions: manifest.extensions,
      accountTypes: manifest.accountTypes,
      ...(manifest.languages !== undefined ? { languages: manifest.languages } : {}),
      ...(manifest.keywords !== undefined ? { keywords: manifest.keywords } : {}),
      capabilities: manifest.capabilities,
      latestVersion: versions[0].version,
      versions,
    };

    plugins.push(entry);
  }

  plugins.sort((a, b) => comparePosixPaths(a.id, b.id));

  const registry = {
    $schema: './schemas/registry.v1.schema.json',
    schemaVersion: '1',
    repository,
    rawRegistryUrl,
    plugins,
  };

  validateRegistrySemantics(registry, REGISTRY_SCHEMA);

  const json = `${JSON.stringify(registry, null, 2)}\n`;
  const registryPath = path.join(rootDir, 'registry.json');
  const existingDiskJson = fs.existsSync(registryPath) ? fs.readFileSync(registryPath, 'utf8') : null;
  const inSync = existingDiskJson === json;

  if (check && !inSync) {
    throw new Error(
      `registry.json at "${registryPath}" is out of sync; run "npm run registry:build" to regenerate it.`,
    );
  }

  if (write) {
    fs.writeFileSync(registryPath, json, 'utf8');
  }

  return {
    registry,
    json,
    registryPath,
    inSync,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const check = args.includes('--check');
    const unknown = args.filter(a => a !== '--check');
    if (unknown.length > 0) {
      throw new Error(`Unknown option(s): ${unknown.join(', ')}. Usage: node scripts/build-registry.mjs [--check]`);
    }
    const result = buildRegistry({ check });
    if (check) {
      console.log(`Registry is up to date (${result.registry.plugins.length} plugin(s)).`);
    } else {
      console.log(`Built ${path.relative(process.cwd(), result.registryPath)} (${result.registry.plugins.length} plugin(s)).`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
