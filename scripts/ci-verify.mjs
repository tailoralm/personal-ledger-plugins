import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createImporterSdk } from '../sdk/index.mjs';
import {
  loadPlugin,
  prepareImportInput,
  runDetection,
  validatePluginContract,
} from '../sdk/harness.mjs';
import { buildRegistry } from './build-registry.mjs';
import { compileTemplateProjectInMemory, loadTypeScript } from './build-templates.mjs';
import {
  comparePosixPaths,
  parseDeterministicZip,
  unpackDeterministicZip,
} from './lib/deterministic-zip.mjs';
import {
  validateManifestSemantics,
  validateRegistrySemantics,
} from './lib/schema-validator.mjs';
import { scanPluginDirectory } from './lib/security-scan.mjs';
import { packagePlugin } from './package-plugin.mjs';

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DRAFT_2020_12_URI = 'https://json-schema.org/draft/2020-12/schema';
const SUPPORTED_FIXTURE_EXTS = new Set(['.csv', '.pdf', '.xlsx']);

function listChildDirs(parentDir) {
  if (!fs.existsSync(parentDir)) return [];
  const stat = fs.lstatSync(parentDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Expected regular directory at "${parentDir}".`);
  }
  return fs.readdirSync(parentDir)
    .sort(comparePosixPaths)
    .filter(name => !name.startsWith('.'))
    .map(name => {
      const fullPath = path.join(parentDir, name);
      const entryStat = fs.lstatSync(fullPath);
      if (entryStat.isSymbolicLink()) {
        throw new Error(`Symlink "${fullPath}" is not allowed.`);
      }
      return entryStat.isDirectory() ? fullPath : null;
    })
    .filter(Boolean);
}

function collectFixtureFiles(fixturesDir) {
  if (!fs.existsSync(fixturesDir)) return [];
  return fs.readdirSync(fixturesDir)
    .sort(comparePosixPaths)
    .filter(name => {
      if (name.startsWith('.')) return false;
      const ext = path.extname(name).toLowerCase();
      if (!SUPPORTED_FIXTURE_EXTS.has(ext)) return false;
      const stat = fs.lstatSync(path.join(fixturesDir, name));
      return !stat.isSymbolicLink() && stat.isFile();
    })
    .map(name => ({
      fileName: name,
      filePath: path.join(fixturesDir, name),
      isNegative: name.toLowerCase().startsWith('negative'),
    }));
}

export function discoverSharedNegativeFixtures(rootDir) {
  const compatInputsDir = path.join(rootDir, 'fixtures/compatibility/inputs');
  if (!fs.existsSync(compatInputsDir)) return [];
  return fs.readdirSync(compatInputsDir)
    .sort(comparePosixPaths)
    .filter(name => {
      if (!name.toLowerCase().startsWith('negative-')) return false;
      if (!SUPPORTED_FIXTURE_EXTS.has(path.extname(name).toLowerCase())) return false;
      const stat = fs.lstatSync(path.join(compatInputsDir, name));
      return !stat.isSymbolicLink() && stat.isFile();
    })
    .map(name => path.join(compatInputsDir, name));
}

export async function verifyTypeScriptArtifactsUpToDate(projectDirs, ts) {
  const checked = [];
  const resolvedTs = ts ?? await loadTypeScript();

  for (const projectDir of projectDirs) {
    const tsconfigPath = path.join(projectDir, 'tsconfig.json');
    if (!fs.existsSync(tsconfigPath)) continue;

    const emitted = await compileTemplateProjectInMemory(projectDir, resolvedTs);
    for (const file of emitted) {
      if (!fs.existsSync(file.outPath)) {
        throw new Error(
          `Compiled TypeScript artifact "${path.relative(process.cwd(), file.outPath)}" is missing on disk. Run "npm run build:templates" or compile the plugin.`,
        );
      }
      const diskText = fs.readFileSync(file.outPath, 'utf8');
      if (diskText !== file.text) {
        throw new Error(
          `Compiled TypeScript artifact "${path.relative(process.cwd(), file.outPath)}" is stale and does not match TypeScript sources. Re-compile and commit the updated output.`,
        );
      }
      checked.push(file.outPath);
    }
  }
  return checked;
}

export function verifySchemas(schemasDir) {
  if (!fs.existsSync(schemasDir)) {
    throw new Error(`Schemas directory "${schemasDir}" does not exist.`);
  }
  const files = fs.readdirSync(schemasDir)
    .sort(comparePosixPaths)
    .filter(name => name.endsWith('.json'));
  if (files.length === 0) {
    throw new Error(`No schema files found in "${schemasDir}".`);
  }

  const schemas = new Map();
  for (const name of files) {
    const fullPath = path.join(schemasDir, name);
    const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Schema "${name}" must be a JSON object.`);
    }
    if (parsed.$schema !== DRAFT_2020_12_URI) {
      throw new Error(`Schema "${name}" must declare $schema "${DRAFT_2020_12_URI}".`);
    }
    if (typeof parsed.$id !== 'string' || !parsed.$id.trim()) {
      throw new Error(`Schema "${name}" must declare a non-empty $id.`);
    }
    if (parsed.type !== 'object') {
      throw new Error(`Schema "${name}" must declare top-level type "object".`);
    }
    schemas.set(name, parsed);
  }
  return schemas;
}

export async function runCrossPluginDetectionMatrix(pluginDirs, options = {}) {
  const sdk = options.sdk ?? createImporterSdk();
  const sharedNegativePaths = options.sharedNegativeFiles
    ?? (options.rootDir ? discoverSharedNegativeFixtures(options.rootDir) : []);

  if (pluginDirs.length === 0) {
    return {
      ok: true,
      pluginCount: 0,
      checksRun: 0,
      failures: [],
    };
  }

  const loadedPlugins = [];
  for (const dir of pluginDirs) {
    const loaded = await loadPlugin(dir);
    const fixtures = collectFixtureFiles(path.join(dir, 'fixtures'));
    const positiveFixtures = fixtures.filter(f => !f.isNegative);
    const negativeFixtures = fixtures.filter(f => f.isNegative);
    if (positiveFixtures.length === 0) {
      throw new Error(`Plugin "${loaded.manifest.id}" must provide at least one positive fixture in fixtures/.`);
    }
    loadedPlugins.push({ loaded, positiveFixtures, negativeFixtures });
  }

  const inputCache = new Map();
  const getPreparedInput = async (filePath) => {
    if (!inputCache.has(filePath)) {
      const bytes = fs.readFileSync(filePath);
      inputCache.set(
        filePath,
        await prepareImportInput({ fileName: path.basename(filePath), bytes }),
      );
    }
    return inputCache.get(filePath);
  };

  const sharedNegatives = [];
  for (const negPath of sharedNegativePaths) {
    sharedNegatives.push({
      fileName: path.basename(negPath),
      filePath: negPath,
      input: await getPreparedInput(negPath),
    });
  }

  for (const entry of loadedPlugins) {
    for (const fixture of [...entry.positiveFixtures, ...entry.negativeFixtures]) {
      fixture.input = await getPreparedInput(fixture.filePath);
    }
  }

  const failures = [];
  let checksRun = 0;

  for (const target of loadedPlugins) {
    const targetId = target.loaded.manifest.id;

    // 1. Must match all of its own positive fixtures
    for (const pos of target.positiveFixtures) {
      checksRun++;
      try {
        const detection = await runDetection(target.loaded, pos.input, sdk);
        if (detection.matched !== true || detection.confidence <= 0) {
          failures.push({
            pluginId: targetId,
            kind: 'self-positive',
            fixture: pos.fileName,
            ownerPluginId: targetId,
            detection,
            message: `Plugin "${targetId}" failed to match its own positive fixture "${pos.fileName}".`,
          });
        }
      } catch (err) {
        failures.push({
          pluginId: targetId,
          kind: 'self-positive',
          fixture: pos.fileName,
          ownerPluginId: targetId,
          message: `Plugin "${targetId}" threw on its own positive fixture "${pos.fileName}": ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // 2. Must reject all of its own negative fixtures
    for (const neg of target.negativeFixtures) {
      checksRun++;
      try {
        const detection = await runDetection(target.loaded, neg.input, sdk);
        if (detection.matched !== false || detection.confidence !== 0) {
          failures.push({
            pluginId: targetId,
            kind: 'self-negative',
            fixture: neg.fileName,
            ownerPluginId: targetId,
            detection,
            message: `Plugin "${targetId}" falsely matched its own negative fixture "${neg.fileName}".`,
          });
        }
      } catch (err) {
        failures.push({
          pluginId: targetId,
          kind: 'self-negative',
          fixture: neg.fileName,
          ownerPluginId: targetId,
          message: `Plugin "${targetId}" threw on its own negative fixture "${neg.fileName}": ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // 3. Must reject all shared negative fixtures
    for (const sharedNeg of sharedNegatives) {
      checksRun++;
      try {
        const detection = await runDetection(target.loaded, sharedNeg.input, sdk);
        if (detection.matched !== false || detection.confidence !== 0) {
          failures.push({
            pluginId: targetId,
            kind: 'shared-negative',
            fixture: sharedNeg.fileName,
            ownerPluginId: 'shared',
            detection,
            message: `Plugin "${targetId}" falsely matched shared negative fixture "${sharedNeg.fileName}".`,
          });
        }
      } catch (err) {
        failures.push({
          pluginId: targetId,
          kind: 'shared-negative',
          fixture: sharedNeg.fileName,
          ownerPluginId: 'shared',
          message: `Plugin "${targetId}" threw on shared negative fixture "${sharedNeg.fileName}": ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // 4. Must reject every other plugin's positive fixtures
    for (const other of loadedPlugins) {
      if (other === target) continue;
      const otherId = other.loaded.manifest.id;
      for (const foreignPos of other.positiveFixtures) {
        checksRun++;
        try {
          const detection = await runDetection(target.loaded, foreignPos.input, sdk);
          if (detection.matched !== false || detection.confidence !== 0) {
            failures.push({
              pluginId: targetId,
              kind: 'cross-plugin-false-positive',
              fixture: foreignPos.fileName,
              ownerPluginId: otherId,
              detection,
              message: `Plugin "${targetId}" falsely matched "${otherId}" positive fixture "${foreignPos.fileName}" (confidence=${detection.confidence}).`,
            });
          }
        } catch (err) {
          failures.push({
            pluginId: targetId,
            kind: 'cross-plugin-false-positive',
            fixture: foreignPos.fileName,
            ownerPluginId: otherId,
            message: `Plugin "${targetId}" threw on "${otherId}" fixture "${foreignPos.fileName}": ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }
  }

  return {
    ok: failures.length === 0,
    pluginCount: loadedPlugins.length,
    checksRun,
    failures,
  };
}

export async function runCiVerification(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? ROOT_DIR);
  const outDir = options.outDir ? path.resolve(options.outDir) : null;
  const log = typeof options.log === 'function' ? options.log : () => {};

  const templateDirs = listChildDirs(path.join(rootDir, 'templates'));
  const pluginDirs = listChildDirs(path.join(rootDir, 'plugins'));
  const allPackageDirs = [...templateDirs, ...pluginDirs];

  // Step 1: Compile TypeScript templates & TS plugins and verify on-disk compiled outputs are not stale
  const tsChecked = await verifyTypeScriptArtifactsUpToDate(allPackageDirs);
  log(`[1/8] Verified ${tsChecked.length} compiled TypeScript artifact(s) match source.`);

  // Step 2: Validate all JSON schemas under schemas/
  const schemas = verifySchemas(path.join(rootDir, 'schemas'));
  const manifestSchema = schemas.get('plugin-manifest.v1.schema.json');
  const registrySchema = schemas.get('registry.v1.schema.json');
  if (!manifestSchema || !registrySchema) {
    throw new Error('Missing required plugin-manifest.v1.schema.json or registry.v1.schema.json in schemas/.');
  }
  log(`[2/8] Validated ${schemas.size} JSON Schema Draft 2020-12 file(s).`);

  // Step 3: Validate manifests across templates/* and plugins/*
  for (const dir of templateDirs) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    validateManifestSemantics(manifest, manifestSchema);
  }
  for (const dir of pluginDirs) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    validateManifestSemantics(manifest, manifestSchema);
    const dirName = path.basename(dir);
    if (manifest.id !== dirName) {
      throw new Error(`Plugin directory "${dirName}" does not match manifest.id "${manifest.id}".`);
    }
  }
  log(`[3/8] Validated ${templateDirs.length} template manifest(s) and ${pluginDirs.length} plugin manifest(s).`);

  // Step 4: Security + privacy + archive filename/limit scan
  for (const dir of allPackageDirs) {
    const scanResult = await scanPluginDirectory(dir);
    if (!scanResult.ok) {
      const formatted = scanResult.errors
        .map(err => `  - [${err.rule}] ${err.file}:${err.line} ${err.message}`)
        .join('\n');
      throw new Error(`Security/privacy scan failed for "${path.relative(rootDir, dir)}":\n${formatted}`);
    }
  }
  log(`[4/8] Security & privacy scan passed for ${allPackageDirs.length} package(s).`);

  // Step 5: Contract validation across templates/* and plugins/*
  for (const dir of allPackageDirs) {
    await validatePluginContract(dir);
  }
  log(`[5/8] Plugin contract & fixture validation passed for ${allPackageDirs.length} package(s).`);

  // Step 6: Cross-plugin mutual-exclusion & false-positive matrix across plugins/*
  const matrix = await runCrossPluginDetectionMatrix(pluginDirs, { rootDir });
  if (!matrix.ok) {
    const formatted = matrix.failures.map(f => `  - ${f.message}`).join('\n');
    throw new Error(`Cross-plugin mutual-exclusion matrix failed:\n${formatted}`);
  }
  log(`[6/8] Cross-plugin detection matrix passed (${matrix.pluginCount} plugin(s), ${matrix.checksRun} check(s)).`);

  // Step 7: Package plugins twice for deterministic reproducibility & verify unpacked ZIP contract
  const packaged = [];
  if (pluginDirs.length > 0) {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-ci-unpack-'));
    try {
      for (const dir of pluginDirs) {
        const pkg1 = packagePlugin(dir, outDir ? { outDir, writeSha256: true } : undefined);
        const pkg2 = packagePlugin(dir);
        if (pkg1.sha256 !== pkg2.sha256 || Buffer.compare(pkg1.bytes, pkg2.bytes) !== 0) {
          throw new Error(`Non-deterministic ZIP packaging detected for "${pkg1.id}".`);
        }

        parseDeterministicZip(pkg1.bytes, { fileName: pkg1.fileName, strictDeterministic: true });

        const unpackDir = path.join(tmpRoot, pkg1.id);
        unpackDeterministicZip(pkg1.bytes, unpackDir, { fileName: pkg1.fileName, strictDeterministic: true });

        const unpackedScan = await scanPluginDirectory(unpackDir);
        if (!unpackedScan.ok) {
          throw new Error(
            `Unpacked ZIP security scan failed for "${pkg1.fileName}": ${unpackedScan.errors.map(e => e.message).join('; ')}`,
          );
        }
        await loadPlugin(unpackDir);
        await validatePluginContract(unpackDir);

        packaged.push({
          id: pkg1.id,
          version: pkg1.version,
          fileName: pkg1.fileName,
          sha256: pkg1.sha256,
          sizeBytes: pkg1.sizeBytes,
          entryCount: pkg1.entries.length,
        });
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
  log(`[7/8] Reproducible ZIP packaging & unpacked contract verification passed for ${packaged.length} plugin(s).`);

  // Step 8: Validate registry.json against schema and buildRegistry --check
  const registryPath = path.join(rootDir, 'registry.json');
  if (!fs.existsSync(registryPath)) {
    throw new Error(`Missing registry.json at "${registryPath}".`);
  }
  const diskRegistry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  validateRegistrySemantics(diskRegistry, registrySchema);
  const registryResult = buildRegistry({ rootDir, check: true });
  log(`[8/8] Verified registry.json (${registryResult.registry.plugins.length} plugin(s), up-to-date and immutable).`);

  return {
    ok: true,
    tsCheckedCount: tsChecked.length,
    schemaCount: schemas.size,
    templateCount: templateDirs.length,
    pluginCount: pluginDirs.length,
    matrix,
    packaged,
    registry: registryResult.registry,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runCiVerification({
      log: msg => console.log(msg),
    });
    console.log('CI verification succeeded.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
