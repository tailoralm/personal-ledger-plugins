import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ERROR_CODES,
  ImporterError,
  createImporterSdk,
  decodeBytes,
} from './index.mjs';
import { extractPdfDocument } from './pdf-host.mjs';
import {
  assertValidSchema,
  validateImportResultSemantics,
  validateManifestSemantics,
} from '../scripts/lib/schema-validator.mjs';

const SCHEMAS_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../schemas');

function readSchema(fileName) {
  return JSON.parse(fs.readFileSync(path.join(SCHEMAS_DIR, fileName), 'utf8'));
}

export const SCHEMAS = Object.freeze({
  manifest: readSchema('plugin-manifest.v1.schema.json'),
  detectionResult: readSchema('detection-result.v1.schema.json'),
  importResult: readSchema('import-result.v1.schema.json'),
});

export function deepFreeze(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  for (const key of Object.keys(value)) {
    deepFreeze(value[key]);
  }
  return Object.freeze(value);
}

function inferFormat(fileName, mimeType) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.pdf' || mimeType === 'application/pdf') return 'pdf';
  if (ext === '.csv' || mimeType === 'text/csv' || mimeType === 'application/csv') return 'csv';
  if (ext === '.xlsx' || mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx';
  return 'unknown';
}

function defaultMimeType(format) {
  switch (format) {
    case 'pdf': return 'application/pdf';
    case 'csv': return 'text/csv';
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    default: return 'application/octet-stream';
  }
}

export async function prepareImportInput({ fileName, bytes, text, mimeType, options, limits } = {}) {
  if (typeof fileName !== 'string' || !fileName.trim()) {
    throw new ImporterError(ERROR_CODES.INVALID_STATEMENT, 'fileName is required for ImportInput.');
  }

  let normalizedBytes;
  if (bytes instanceof Uint8Array) {
    normalizedBytes = new Uint8Array(bytes);
  } else if (bytes instanceof ArrayBuffer) {
    normalizedBytes = new Uint8Array(bytes.slice(0));
  } else if (ArrayBuffer.isView(bytes)) {
    normalizedBytes = new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  } else if (typeof text === 'string') {
    normalizedBytes = new TextEncoder().encode(text);
  } else {
    throw new ImporterError(ERROR_CODES.EMPTY_INPUT, 'Input requires bytes or text.');
  }

  if (normalizedBytes.byteLength === 0) {
    throw new ImporterError(ERROR_CODES.EMPTY_INPUT, `Input file "${fileName}" is empty.`);
  }

  if (limits?.maxFileBytes !== undefined && normalizedBytes.byteLength > limits.maxFileBytes) {
    throw new ImporterError(
      ERROR_CODES.FILE_TOO_LARGE,
      `Input file "${fileName}" exceeds maxFileBytes (${normalizedBytes.byteLength} > ${limits.maxFileBytes}).`,
      { byteLength: normalizedBytes.byteLength, maxFileBytes: limits.maxFileBytes },
    );
  }

  const format = inferFormat(fileName, mimeType);
  const resolvedMime = mimeType || defaultMimeType(format);
  const resolvedText = typeof text === 'string'
    ? text
    : format === 'csv'
      ? decodeBytes(normalizedBytes)
      : undefined;

  const pdf = format === 'pdf'
    ? await extractPdfDocument(normalizedBytes, limits)
    : undefined;

  return deepFreeze({
    fileName,
    format,
    mimeType: resolvedMime,
    bytes: normalizedBytes,
    ...(resolvedText !== undefined ? { text: resolvedText } : {}),
    ...(pdf !== undefined ? { pdf } : {}),
    options: { ...(options ?? {}) },
  });
}

function stripCommentsAndStrings(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n\r]*/g, ' ')
    .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
}

export function assertPluginIsolation(entrypointPath, pluginDir) {
  const visited = new Set();
  const realRoot = fs.realpathSync(pluginDir);

  const inspectFile = (filePath) => {
    const realFile = fs.realpathSync(filePath);
    if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) {
      throw new Error(`Plugin file "${filePath}" resolves outside plugin directory "${pluginDir}".`);
    }
    if (visited.has(realFile)) return;
    visited.add(realFile);

    const source = fs.readFileSync(realFile, 'utf8');
    const noComments = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n\r]*/g, '');

    const importExportRe = /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?(['"])([^'"]+)\1|\bimport\s*\(\s*(['"])([^'"]+)\3\s*\)/g;
    let match;
    while ((match = importExportRe.exec(noComments)) !== null) {
      const specifier = match[2] ?? match[4];
      if (!specifier.startsWith('./') || specifier.includes('..')) {
        throw new Error(`Plugin file "${realFile}" has forbidden import specifier "${specifier}". Plugins must be self-contained.`);
      }
      const nextPath = path.resolve(path.dirname(realFile), specifier);
      inspectFile(nextPath);
    }

    const stripped = stripCommentsAndStrings(source);
    if (/\bimport\s*\(/.test(stripped)) {
      throw new Error(`Plugin file "${realFile}" must not use dynamic import().`);
    }
    for (const forbidden of ['Buffer', 'process', 'require', '__dirname', '__filename']) {
      if (new RegExp(`\\b${forbidden}\\b`).test(stripped)) {
        throw new Error(`Plugin file "${realFile}" references forbidden host global "${forbidden}".`);
      }
    }
  };

  inspectFile(entrypointPath);
}

function resolvePluginEntrypoint(pluginDir, entrypoint) {
  if (path.isAbsolute(entrypoint) || entrypoint.includes('..')) {
    throw new Error(`Unsafe plugin entrypoint "${entrypoint}".`);
  }
  const resolved = path.resolve(pluginDir, entrypoint);
  const realDir = fs.realpathSync(pluginDir);
  const realEntry = fs.realpathSync(resolved);
  if (!realEntry.startsWith(realDir + path.sep)) {
    throw new Error(`Entrypoint "${entrypoint}" escapes plugin directory.`);
  }
  return realEntry;
}

export async function loadPlugin(pluginDir) {
  const dir = path.resolve(pluginDir);
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  validateManifestSemantics(manifest, SCHEMAS.manifest);

  const entrypointPath = resolvePluginEntrypoint(dir, manifest.entrypoint);
  assertPluginIsolation(entrypointPath, dir);

  const mod = await import(pathToFileURL(entrypointPath).href);
  const candidate = mod.default ?? mod.plugin ?? mod;
  if (!candidate || typeof candidate.detect !== 'function' || typeof candidate.parse !== 'function') {
    throw new Error(`Plugin entrypoint "${manifest.entrypoint}" must export detect(input, sdk) and parse(input, sdk).`);
  }

  return {
    dir,
    manifest,
    entrypointPath,
    plugin: {
      detect: candidate.detect,
      parse: candidate.parse,
    },
  };
}

function resolvePluginTarget(loadedOrPlugin) {
  if (loadedOrPlugin && 'plugin' in loadedOrPlugin && 'manifest' in loadedOrPlugin) {
    return { plugin: loadedOrPlugin.plugin, manifest: loadedOrPlugin.manifest };
  }
  return { plugin: loadedOrPlugin, manifest: undefined };
}

function enforceInputLimits(input, manifest) {
  if (!input?.bytes || input.bytes.byteLength === 0) {
    throw new ImporterError(ERROR_CODES.EMPTY_INPUT, 'Input bytes cannot be empty.');
  }
  const maxBytes = manifest?.limits?.maxFileBytes;
  if (maxBytes !== undefined && input.bytes.byteLength > maxBytes) {
    throw new ImporterError(
      ERROR_CODES.FILE_TOO_LARGE,
      `Input exceeds plugin maxFileBytes (${input.bytes.byteLength} > ${maxBytes}).`,
    );
  }
}

export async function runDetection(loadedOrPlugin, input, sdk = createImporterSdk()) {
  const { plugin, manifest } = resolvePluginTarget(loadedOrPlugin);
  enforceInputLimits(input, manifest);
  const result = await plugin.detect(input, sdk);
  assertValidSchema(SCHEMAS.detectionResult, result, 'DetectionResult');
  return result;
}

export async function runParse(loadedOrPlugin, input, sdk = createImporterSdk()) {
  const { plugin, manifest } = resolvePluginTarget(loadedOrPlugin);
  enforceInputLimits(input, manifest);
  const result = await plugin.parse(input, sdk);
  validateImportResultSemantics(result, SCHEMAS.importResult, manifest);
  return result;
}

export async function validatePluginContract(pluginDir) {
  const loaded = await loadPlugin(pluginDir);
  const { manifest } = loaded;
  const sdk = createImporterSdk();
  const fixturesDir = path.join(loaded.dir, 'fixtures');
  const fixtureResults = [];

  if (fs.existsSync(fixturesDir)) {
    const entries = fs.readdirSync(fixturesDir, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
      .sort();

    for (const fileName of entries) {
      const ext = path.extname(fileName).toLowerCase();
      if (!['.csv', '.pdf', '.xlsx'].includes(ext)) continue;

      const bytes = fs.readFileSync(path.join(fixturesDir, fileName));
      const input = await prepareImportInput({ fileName, bytes, limits: manifest.limits });
      const isNegative = fileName.toLowerCase().startsWith('negative');

      const detection = await runDetection(loaded, input, sdk);
      if (isNegative) {
        if (detection.matched !== false || detection.confidence !== 0) {
          throw new Error(`Negative fixture "${fileName}" unexpectedly matched (${JSON.stringify(detection)}).`);
        }
        let threwImporterError = false;
        try {
          await runParse(loaded, input, sdk);
        } catch (error) {
          if (!(error instanceof ImporterError)) {
            throw new Error(`Negative fixture "${fileName}" threw non-ImporterError: ${error?.message ?? error}`);
          }
          threwImporterError = true;
        }
        if (!threwImporterError) {
          throw new Error(`Negative fixture "${fileName}" did not throw ImporterError on parse().`);
        }
        fixtureResults.push({ fileName, kind: 'negative', detection });
      } else {
        if (detection.matched !== true || detection.confidence <= 0) {
          throw new Error(`Positive fixture "${fileName}" did not match (${JSON.stringify(detection)}).`);
        }
        const parsed = await runParse(loaded, input, sdk);
        if (parsed.transactions.length === 0 && !(parsed.sideInvestments?.length > 0)) {
          throw new Error(`Positive fixture "${fileName}" yielded zero transactions.`);
        }
        fixtureResults.push({ fileName, kind: 'positive', detection, result: parsed });
      }
    }
  }

  return {
    manifest,
    fixtureResults,
  };
}
