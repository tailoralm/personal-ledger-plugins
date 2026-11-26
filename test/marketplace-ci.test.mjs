import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { buildRegistry, extractChangelogSection } from '../scripts/build-registry.mjs';
import { runCiVerification, runCrossPluginDetectionMatrix } from '../scripts/ci-verify.mjs';
import {
  FIXED_DOS_DATE,
  FIXED_DOS_TIME,
  FIXED_UNIX_FILE_ATTRIBUTES,
  ZIP_LIMITS,
  buildDeterministicZip,
  parseDeterministicZip,
  unpackDeterministicZip,
  validateArchiveFileName,
} from '../scripts/lib/deterministic-zip.mjs';
import {
  compareSemVer,
  validateRegistrySemantics,
  validateSchema,
} from '../scripts/lib/schema-validator.mjs';
import {
  scanPluginDirectory,
  scanPrivacyAndSecrets,
  scanSourceText,
} from '../scripts/lib/security-scan.mjs';
import { packagePlugin } from '../scripts/package-plugin.mjs';
import { loadPlugin, validatePluginContract } from '../sdk/harness.mjs';
import { buildPositionedPdf } from '../sdk/pdf-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_SCHEMA = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'schemas/registry.v1.schema.json'), 'utf8'),
);

function withTempDir(prefix, fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function withTempDirAsync(prefix, fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function makeCsvPluginFiles({
  id = 'alpha-csv-bank',
  version = '1.0.0',
  tier,
  headerToken = 'ALPHA_HEADER',
  greedy = false,
  changelogNotes = '- Initial synthetic release.',
} = {}) {
  const manifest = {
    id,
    name: `${id} Importer`,
    version,
    pluginApiVersion: '1',
    type: 'bank-importer',
    description: `Synthetic importer for ${id}.`,
    author: { name: 'Synthetic Tester' },
    license: 'MIT',
    institution: { id, name: `${id} Institution`, country: 'PT' },
    formats: ['csv'],
    mimeTypes: ['text/csv'],
    extensions: ['.csv'],
    entrypoint: 'importer.mjs',
    accountTypes: ['bank'],
    capabilities: {
      supportsRunningBalance: true,
      supportsSourceIds: false,
      supportsMultiCurrency: false,
      supportsYearInference: false,
      supportsInvestments: false,
    },
    limits: { maxFileBytes: 1048576, timeoutMs: 5000, maxMemoryMb: 128 },
    permissions: [],
    ...(tier !== undefined ? { tier } : {}),
  };

  const importer = `const PLUGIN_ID = ${JSON.stringify(id)};
const INSTITUTION_ID = ${JSON.stringify(id)};
const MARKER = ${JSON.stringify(headerToken)};

export default {
  detect(input, sdk) {
    if (input.format !== 'csv') {
      if (${JSON.stringify(greedy)}) {
        return { matched: true, confidence: 0.5, format: input.format, institutionId: INSTITUTION_ID, reason: 'Greedy match' };
      }
      return { matched: false, confidence: 0, reason: 'Expected CSV format.' };
    }
    const text = sdk.csv.decodeBytes(input.bytes);
    const rows = sdk.csv.parseRows(text);
    const matched = ${JSON.stringify(greedy)} || (rows.length >= 2 && rows[0][0] === MARKER);
    if (!matched) {
      return { matched: false, confidence: 0, reason: 'Header marker missing.' };
    }
    return {
      matched: true,
      confidence: 0.95,
      format: 'csv',
      institutionId: INSTITUTION_ID,
      reason: 'Matched synthetic CSV header.',
    };
  },
  parse(input, sdk) {
    if (input.format !== 'csv') {
      throw new sdk.ImporterError(sdk.ERROR_CODES.UNSUPPORTED_FORMAT, 'Expected CSV.');
    }
    const rows = sdk.csv.parseRows(sdk.csv.decodeBytes(input.bytes));
    if (rows.length < 2 || rows[0][0] !== MARKER) {
      throw new sdk.ImporterError(sdk.ERROR_CODES.HEADER_NOT_FOUND, 'Header marker missing.');
    }
    const transactions = [];
    for (let i = 1; i < rows.length; i++) {
      const [rawDate, description, rawAmount, rawBalance] = rows[i];
      const date = sdk.dates.parseIsoDatePrefix(rawDate);
      const amount = sdk.money.normalizeDecimal(rawAmount);
      const balance = sdk.money.normalizeDecimal(rawBalance);
      if (!date || !description || amount === null || balance === null) continue;
      transactions.push({
        date,
        description,
        amount,
        currency: 'EUR',
        balance,
        evidence: { row: i + 1, locator: \`Record \${i + 1}\`, rawDate, rawAmount, runningBalance: balance },
      });
    }
    if (transactions.length === 0) {
      throw new sdk.ImporterError(sdk.ERROR_CODES.NO_TRANSACTIONS, 'No rows.');
    }
    return {
      pluginApiVersion: '1',
      pluginId: PLUGIN_ID,
      institutionId: INSTITUTION_ID,
      transactions,
      diagnostics: [],
    };
  },
};
`;

  const validCsv = `${headerToken},Description,Amount,Balance\n2026-08-01,Synthetic Salary,1000.00,1000.00\n2026-08-02,Corner Cafe,-4.50,0.00\n`;
  const negativeCsv = 'OtherCol,Value\nfoo,bar\n';
  const testCode = `import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validatePluginContract } from ${JSON.stringify(path.join(ROOT, 'sdk/harness.mjs'))};

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('${id} contract', async () => {
  const { manifest } = await validatePluginContract(PLUGIN_DIR);
  assert.equal(manifest.id, ${JSON.stringify(id)});
});
`;

  return {
    'manifest.json': JSON.stringify(manifest, null, 2),
    'README.md': `# ${id}\n\nSynthetic importer plugin.\n`,
    'CHANGELOG.md': `# Changelog\n\n## [${version}]\n\n${changelogNotes}\n`,
    'importer.mjs': importer,
    'fixtures/valid.csv': validCsv,
    'fixtures/negative-unrelated.csv': negativeCsv,
    'test/importer.test.mjs': testCode,
  };
}

function writeFiles(baseDir, fileMap) {
  for (const [relPath, content] of Object.entries(fileMap)) {
    const abs = path.join(baseDir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

test('schemas/registry.v1.schema.json and committed registry.json validate cleanly', () => {
  assert.equal(REGISTRY_SCHEMA.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(REGISTRY_SCHEMA.type, 'object');

  const diskRegistry = JSON.parse(fs.readFileSync(path.join(ROOT, 'registry.json'), 'utf8'));
  validateRegistrySemantics(diskRegistry, REGISTRY_SCHEMA);

  const checked = buildRegistry({ rootDir: ROOT, check: true });
  assert.equal(checked.inSync, true);
  assert.equal('generatedAt' in diskRegistry, false);

  const sampleValid = {
    schemaVersion: '1',
    repository: 'tailoralm/personal-ledger-plugins',
    rawRegistryUrl: 'https://raw.githubusercontent.com/tailoralm/personal-ledger-plugins/main/registry.json',
    plugins: [
      {
        id: 'alpha-bank',
        name: 'Alpha Bank',
        description: 'Alpha Bank CSV importer.',
        tier: 'official',
        author: { name: 'Maintainers', url: 'https://github.com/tailoralm/personal-ledger-plugins' },
        license: 'MIT',
        institution: { id: 'alpha-bank', name: 'Alpha Bank', country: 'PT' },
        formats: ['csv'],
        mimeTypes: ['text/csv'],
        extensions: ['.csv'],
        accountTypes: ['bank'],
        capabilities: {
          supportsRunningBalance: true,
          supportsSourceIds: false,
          supportsMultiCurrency: false,
          supportsYearInference: false,
          supportsInvestments: false,
        },
        latestVersion: '1.1.0',
        versions: [
          {
            version: '1.1.0',
            pluginApiVersion: '1',
            tag: 'alpha-bank@1.1.0',
            packageFile: 'alpha-bank-1.1.0.zip',
            downloadUrl: 'https://github.com/tailoralm/personal-ledger-plugins/releases/download/alpha-bank%401.1.0/alpha-bank-1.1.0.zip',
            sourcePath: 'plugins/alpha-bank',
            sha256: 'a'.repeat(64),
            sizeBytes: 1234,
            changelog: '- Added currency support.',
          },
          {
            version: '1.0.0',
            pluginApiVersion: '1',
            tag: 'alpha-bank@1.0.0',
            packageFile: 'alpha-bank-1.0.0.zip',
            downloadUrl: 'https://github.com/tailoralm/personal-ledger-plugins/releases/download/alpha-bank%401.0.0/alpha-bank-1.0.0.zip',
            sourcePath: 'plugins/alpha-bank',
            sha256: 'b'.repeat(64),
            sizeBytes: 1200,
            changelog: '- Initial release.',
          },
        ],
      },
    ],
  };
  validateRegistrySemantics(sampleValid, REGISTRY_SCHEMA);

  // Reject invalid schemaVersion / repository / sha256 / tier
  assert.equal(validateSchema(REGISTRY_SCHEMA, { ...sampleValid, schemaVersion: '2' }).valid, false);
  assert.equal(validateSchema(REGISTRY_SCHEMA, { ...sampleValid, repository: 'not-a-slug' }).valid, false);
  assert.equal(validateSchema(REGISTRY_SCHEMA, { ...sampleValid, rawRegistryUrl: 'http://insecure' }).valid, false);

  const badTier = structuredClone(sampleValid);
  badTier.plugins[0].tier = 'verified';
  assert.equal(validateSchema(REGISTRY_SCHEMA, badTier).valid, false);

  const badHash = structuredClone(sampleValid);
  badHash.plugins[0].versions[0].sha256 = 'ABCDEF';
  assert.equal(validateSchema(REGISTRY_SCHEMA, badHash).valid, false);

  // Semantic checks: unsorted plugins, unsorted versions, mismatched latestVersion/tag
  const unsortedPlugins = structuredClone(sampleValid);
  unsortedPlugins.plugins.push({ ...structuredClone(sampleValid.plugins[0]), id: 'aa-first' });
  unsortedPlugins.plugins[1].versions.forEach(v => {
    v.tag = `aa-first@${v.version}`;
    v.packageFile = `aa-first-${v.version}.zip`;
    v.sourcePath = 'plugins/aa-first';
    v.downloadUrl = `https://github.com/tailoralm/personal-ledger-plugins/releases/download/aa-first%40${v.version}/aa-first-${v.version}.zip`;
  });
  assert.throws(() => validateRegistrySemantics(unsortedPlugins, REGISTRY_SCHEMA), /not sorted by id/);

  const wrongLatest = structuredClone(sampleValid);
  wrongLatest.plugins[0].latestVersion = '1.0.0';
  assert.throws(() => validateRegistrySemantics(wrongLatest, REGISTRY_SCHEMA), /latestVersion/);

  const ascendingVersions = structuredClone(sampleValid);
  ascendingVersions.plugins[0].versions.reverse();
  assert.throws(() => validateRegistrySemantics(ascendingVersions, REGISTRY_SCHEMA), /sorted descending/);
  assert.equal(compareSemVer('1.10.0', '1.2.0') > 0, true);
  assert.equal(compareSemVer('1.0.0', '1.0.0-rc.1') > 0, true);
});

test('deterministic ZIP packaging is byte-for-byte reproducible across mtimes and unpacks cleanly', async () => {
  // Byte-for-byte reproducibility independent of input entry ordering
  const zipA = buildDeterministicZip(
    [
      { path: 'z.txt', data: 'last' },
      { path: 'a/b.txt', data: 'first' },
      { path: 'empty.txt', data: '' },
    ],
    { fileName: 'alpha-bank-1.0.0.zip' },
  );
  const zipB = buildDeterministicZip(
    [
      { path: 'empty.txt', data: '' },
      { path: 'a/b.txt', data: 'first' },
      { path: 'z.txt', data: 'last' },
    ],
    { fileName: 'alpha-bank-1.0.0.zip' },
  );
  assert.equal(Buffer.compare(zipA, zipB), 0);

  const inspected = parseDeterministicZip(zipA, { fileName: 'alpha-bank-1.0.0.zip', strictDeterministic: true });
  assert.deepEqual(inspected.entries.map(e => e.path), ['a/b.txt', 'empty.txt', 'z.txt']);
  for (const entry of inspected.entries) {
    assert.equal(entry.dosTime, FIXED_DOS_TIME);
    assert.equal(entry.dosDate, FIXED_DOS_DATE);
    assert.equal(entry.externalAttributes, FIXED_UNIX_FILE_ATTRIBUTES);
  }

  // Reproducible across filesystem mtime differences and temp artifacts excluded
  await withTempDirAsync('pl-zip-repro-', async tmpDir => {
    const pluginDir = path.join(tmpDir, 'alpha-csv-bank');
    const outDir = path.join(tmpDir, 'dist-packages');
    const unpackDir = path.join(tmpDir, 'unpacked');

    writeFiles(pluginDir, {
      ...makeCsvPluginFiles(),
      '.DS_Store': 'ignored',
      '.git/config': 'ignored',
      'node_modules/evil/index.js': 'ignored',
      'debug.tmp': 'ignored',
      'fixtures/.hidden': 'ignored',
    });

    const pkg1 = packagePlugin(pluginDir, { outDir, writeSha256: true });
    assert.equal(pkg1.fileName, 'alpha-csv-bank-1.0.0.zip');
    assert.equal(fs.existsSync(pkg1.outPath), true);
    assert.equal(fs.existsSync(pkg1.sha256Path), true);
    assert.equal(pkg1.entries.includes('.DS_Store'), false);
    assert.equal(pkg1.entries.some(p => p.includes('node_modules')), false);
    assert.equal(pkg1.entries.includes('debug.tmp'), false);
    assert.equal(pkg1.entries.includes('fixtures/.hidden'), false);
    assert.equal(fs.readFileSync(pkg1.sha256Path, 'utf8'), `${pkg1.sha256}  ${pkg1.fileName}\n`);

    // Change mtimes on every file and re-package
    const past = new Date('2010-01-01T00:00:00Z');
    const future = new Date('2030-05-05T12:34:56Z');
    fs.utimesSync(path.join(pluginDir, 'manifest.json'), past, past);
    fs.utimesSync(path.join(pluginDir, 'importer.mjs'), future, future);

    const pkg2 = packagePlugin(pluginDir);
    assert.equal(pkg2.sha256, pkg1.sha256);
    assert.equal(Buffer.compare(pkg2.bytes, pkg1.bytes), 0);

    // Unpack and verify contract passes directly from unpacked archive
    unpackDeterministicZip(pkg1.bytes, unpackDir, { fileName: pkg1.fileName, strictDeterministic: true });
    const loaded = await loadPlugin(unpackDir);
    assert.equal(loaded.manifest.id, 'alpha-csv-bank');
    await validatePluginContract(unpackDir);

    // CLI invocation check + standard PKZIP integrity verification with unzip -t
    const cliOut = path.join(tmpDir, 'cli-out');
    execFileSync(
      process.execPath,
      [path.join(ROOT, 'scripts/package-plugin.mjs'), pluginDir, '--out-dir', cliOut, '--write-sha256'],
      { stdio: 'pipe' },
    );
    assert.equal(Buffer.compare(fs.readFileSync(path.join(cliOut, pkg1.fileName)), pkg1.bytes), 0);
    execFileSync('unzip', ['-t', path.join(cliOut, pkg1.fileName)], { stdio: 'pipe' });
  });
});

function craftRawZipEntry({
  fileName,
  payload = Buffer.from('hello'),
  externalAttributes = FIXED_UNIX_FILE_ATTRIBUTES,
  declaredUncompressedSize,
  method = 0,
  crc32Override,
}) {
  const nameBytes = Buffer.from(fileName, 'utf8');
  const compressed = method === 8 ? zlib.deflateRawSync(payload) : payload;
  const crc = crc32Override ?? (zlib.crc32(payload) >>> 0);
  const uncompSize = declaredUncompressedSize ?? payload.byteLength;

  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(0x0800, 6);
  lh.writeUInt16LE(method, 8);
  lh.writeUInt16LE(FIXED_DOS_TIME, 10);
  lh.writeUInt16LE(FIXED_DOS_DATE, 12);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(compressed.byteLength, 18);
  lh.writeUInt32LE(uncompSize, 22);
  lh.writeUInt16LE(nameBytes.byteLength, 26);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(0x031e, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0x0800, 8);
  cd.writeUInt16LE(method, 10);
  cd.writeUInt16LE(FIXED_DOS_TIME, 12);
  cd.writeUInt16LE(FIXED_DOS_DATE, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(compressed.byteLength, 20);
  cd.writeUInt32LE(uncompSize, 24);
  cd.writeUInt16LE(nameBytes.byteLength, 28);
  cd.writeUInt32LE(externalAttributes, 38);
  cd.writeUInt32LE(0, 42);

  const cdOffset = lh.byteLength + nameBytes.byteLength + compressed.byteLength;
  const cdSize = cd.byteLength + nameBytes.byteLength;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  return Buffer.concat([lh, nameBytes, compressed, cd, nameBytes, eocd]);
}

test('deterministic ZIP rejects unsafe archive names, ZIP-slip, backslashes, symlinks, dotfiles, node_modules, and size/entry caps', () => {
  // Unsafe archive names
  for (const badName of ['evil.zip', 'bad_id-1.0.0.zip', 'Bad-1.0.0.zip', 'bank-1.0.zip', '../bank-1.0.0.zip', 'bank-1.0.0-rc1.zip']) {
    assert.throws(() => validateArchiveFileName(badName), /Unsafe archive filename/);
    assert.throws(
      () => buildDeterministicZip([{ path: 'manifest.json', data: '{}' }], { fileName: badName }),
      /Unsafe archive filename/,
    );
  }

  // Unsafe entry paths on build
  for (const badPath of [
    '../evil.txt',
    'a/../evil.txt',
    '/abs/path.txt',
    'sub\\evil.txt',
    'C:drive.txt',
    'dir/file\0.txt',
    '.env',
    '.git/config',
    'fixtures/.secret.csv',
    'node_modules/pkg/index.js',
    'dist-packages/x.zip',
    'dir/',
  ]) {
    assert.throws(() => buildDeterministicZip([{ path: badPath, data: 'x' }]), /Unsafe archive entry path/);
  }

  // Symlink flag on build
  assert.throws(
    () => buildDeterministicZip([{ path: 'link.txt', data: 'target', isSymlink: true }]),
    /symlink/,
  );

  // Oversized single file, total uncompressed, and entry count on build
  assert.throws(
    () => buildDeterministicZip([{ path: 'big.txt', data: Buffer.alloc(ZIP_LIMITS.maxSingleFileBytes + 1) }]),
    /single-file cap/,
  );
  assert.throws(
    () => buildDeterministicZip([
      { path: 'a.bin', data: Buffer.alloc(ZIP_LIMITS.maxSingleFileBytes) },
      { path: 'b.bin', data: Buffer.alloc(ZIP_LIMITS.maxSingleFileBytes) },
      { path: 'c.bin', data: Buffer.alloc(ZIP_LIMITS.maxSingleFileBytes) },
    ]),
    /total uncompressed cap/,
  );
  const tooManyEntries = Array.from({ length: ZIP_LIMITS.maxEntries + 1 }, (_, i) => ({
    path: `file-${i}.txt`,
    data: 'x',
  }));
  assert.throws(() => buildDeterministicZip(tooManyEntries), /max entry cap/);

  // Malicious raw ZIP inspections (ZIP-slip, backslash, hidden file, node_modules, symlink attr, zip bomb, bad CRC)
  assert.throws(() => parseDeterministicZip(craftRawZipEntry({ fileName: '../../escape.txt' })), /Unsafe archive entry path/);
  assert.throws(() => parseDeterministicZip(craftRawZipEntry({ fileName: 'sub\\escape.txt' })), /Unsafe archive entry path/);
  assert.throws(() => parseDeterministicZip(craftRawZipEntry({ fileName: '.hidden' })), /Unsafe archive entry path/);
  assert.throws(() => parseDeterministicZip(craftRawZipEntry({ fileName: 'node_modules/a.js' })), /Unsafe archive entry path/);
  assert.throws(
    () => parseDeterministicZip(craftRawZipEntry({
      fileName: 'symlink.txt',
      externalAttributes: (0o120777 << 16) >>> 0,
    })),
    /symlink/,
  );
  assert.throws(
    () => parseDeterministicZip(craftRawZipEntry({
      fileName: 'bomb.txt',
      payload: Buffer.alloc(64 * 1024, 0x41),
      method: 8,
    })),
    /max compression ratio/,
  );
  assert.throws(
    () => parseDeterministicZip(craftRawZipEntry({
      fileName: 'bad-crc.txt',
      payload: Buffer.from('hello'),
      crc32Override: 0xdeadbeef,
    })),
    /CRC-32 mismatch/,
  );

  // Symlink on disk rejected by packagePlugin & scanPluginDirectory
  withTempDir('pl-symlink-', tmpDir => {
    const pluginDir = path.join(tmpDir, 'alpha-csv-bank');
    writeFiles(pluginDir, makeCsvPluginFiles());
    fs.symlinkSync('/etc/hosts', path.join(pluginDir, 'fixtures/linked.csv'));
    assert.throws(() => packagePlugin(pluginDir), /symlink/);
  });
});

test('static security scanner detects forbidden imports/globals including template expressions without false-triggering on comments or literals', async () => {
  // Clean templates pass
  for (const tpl of ['javascript-importer', 'typescript-importer']) {
    const res = await scanPluginDirectory(path.join(ROOT, 'templates', tpl));
    assert.equal(res.ok, true, JSON.stringify(res.errors));
  }

  // Comments, string literals, regex literals, and TS SDK import type must NOT false-trigger
  const safeJs = `
    // import fs from 'node:fs';
    /* process.exit(1); fetch('https://evil.test'); eval('1'); new Function('return 2'); */
    const msg = "Never call require('fs'), import fs from 'node:fs', Deno, Bun, XMLHttpRequest, WebSocket, or globalThis.";
    const tmpl = \`Literal text mentioning process, require('fs'), and fetch safely\`;
    const rx = /process|fetch|https:\\/\\/example.com\\/require/;
    export default { detect() { return { matched: false, confidence: 0, reason: msg + tmpl + rx.source }; } };
  `;
  const safeRes = scanSourceText(safeJs, 'importer.mjs');
  assert.equal(safeRes.ok, true, JSON.stringify(safeRes.errors));

  const safeTs = `
    import type { ImportInput, ImporterSdk } from '../../../sdk/index.js';
    export default {
      detect(input: ImportInput, _sdk: ImporterSdk) {
        return { matched: false, confidence: 0, reason: input.fileName };
      },
    };
  `;
  assert.equal(scanSourceText(safeTs, 'src/importer.ts').ok, true);

  // TS non-type import or non-SDK import type is rejected
  assert.equal(scanSourceText(`import { dates } from '../../../sdk/index.js';`, 'src/importer.ts').ok, false);
  assert.equal(scanSourceText(`import type { X } from 'node:fs';`, 'src/importer.ts').ok, false);
  assert.equal(scanSourceText(`import type { X } from '../../../sdk/index.js';`, 'importer.mjs').ok, false);

  // Forbidden imports
  const badImports = [
    `import fs from 'node:fs';`,
    `import fs from 'fs/promises';`,
    `import path from 'path';`,
    `import mupdf from 'mupdf';`,
    `import db from 'node:sqlite';`,
    `import helper from '../shared.mjs';`,
    `export * from '../leak.mjs';`,
    `import mod from 'https://evil.example/mod.mjs';`,
    `import mod from 'http://evil.example/mod.mjs';`,
    `import mod from 'file:///etc/passwd';`,
    `import mod from 'data:text/javascript,export default 1';`,
    `import pkg from 'some-npm-package';`,
  ];
  for (const snippet of badImports) {
    const res = scanSourceText(snippet, 'importer.mjs');
    assert.equal(res.ok, false, `Expected forbidden import error for: ${snippet}`);
    assert.ok(res.errors.some(e => e.rule === 'forbidden-import'));
  }

  // Forbidden globals & template expressions
  const badGlobals = [
    'const x = process.env;',
    'const x = Deno.readTextFile;',
    'const x = Bun.file;',
    'const x = require("fs");',
    'const x = eval("1+1");',
    'const x = new Function("return 1");',
    'const x = fetch("https://example.com");',
    'const x = new XMLHttpRequest();',
    'const x = new WebSocket("wss://example.com");',
    'const x = globalThis;',
    'const x = Buffer.from("a");',
    'const x = __dirname;',
    'const x = __filename;',
    'const x = import(dynamicPath);',
    'const x = `prefix ${process.env.HOME} suffix`;',
    'const x = `outer ${`inner ${eval("1")}`}`;',
  ];
  for (const snippet of badGlobals) {
    const res = scanSourceText(snippet, 'importer.mjs');
    assert.equal(res.ok, false, `Expected forbidden global error for: ${snippet}`);
  }

  // Privacy & secret checks (constructed dynamically so this test file stays clean)
  const pemKey = ['-----BEGIN RSA ', 'PRIVATE KEY-----\nMIIE...'].join('');
  const ghpToken = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0';
  const ghPatToken = 'github_pat_' + '11ABCDEFGH2233445566';
  const stripeToken = 'sk_live_' + '51AbCdEfGhIjKlMnOp';
  const awsKey = 'AKIA' + '1234567890ABCDEF';
  const luhnPan = ['4532', '0151', '1283', '0366'].join(' ');
  const realIban = ['DE89', '3704', '0044', '0532', '0130', '00'].join('');

  assert.equal(scanPrivacyAndSecrets(pemKey, 'fixtures/key.txt').errors[0]?.rule, 'private-key');
  assert.equal(scanPrivacyAndSecrets(ghpToken, 'fixtures/tok.txt').errors[0]?.rule, 'api-token-ghp');
  assert.equal(scanPrivacyAndSecrets(ghPatToken, 'fixtures/tok.txt').errors[0]?.rule, 'api-token-github-pat');
  assert.equal(scanPrivacyAndSecrets(stripeToken, 'fixtures/tok.txt').errors[0]?.rule, 'api-token-stripe');
  assert.equal(scanPrivacyAndSecrets(awsKey, 'fixtures/tok.txt').errors[0]?.rule, 'api-token-aws');
  assert.equal(scanPrivacyAndSecrets(`Card: ${luhnPan}`, 'fixtures/card.csv').errors[0]?.rule, 'payment-pan');
  assert.equal(scanPrivacyAndSecrets(`IBAN: ${realIban}`, 'fixtures/iban.csv').errors[0]?.rule, 'personal-iban');

  // Synthetic placeholders pass cleanly
  const syntheticCsv = [
    'IBAN: XX00000000000000000000',
    'IBAN: PT50000000000000000000000',
    'Card: ****0366',
    'Card: 0000000000000000',
  ].join('\n');
  assert.equal(scanPrivacyAndSecrets(syntheticCsv, 'fixtures/synthetic.csv').ok, true);

  // PDF text leak detection via MuPDF extraction
  await withTempDirAsync('pl-pdf-leak-', async tmpDir => {
    const pluginDir = path.join(tmpDir, 'alpha-csv-bank');
    writeFiles(pluginDir, makeCsvPluginFiles());
    const leakPdf = buildPositionedPdf([
      [[50, 700, `Account IBAN ${realIban}`]],
    ]);
    fs.writeFileSync(path.join(pluginDir, 'fixtures/leak.pdf'), leakPdf);
    const scanRes = await scanPluginDirectory(pluginDir);
    assert.equal(scanRes.ok, false);
    assert.ok(scanRes.errors.some(e => e.rule === 'personal-iban' && e.file === 'fixtures/leak.pdf'));
  });
});

test('buildRegistry supports official/community tiers, multi-version rollback history, immutability, changelog extraction, and --check', () => {
  assert.match(
    extractChangelogSection('# Changelog\n\n## [1.2.0] - 2026-11-26\n\n- Added feature.\n\n## [1.1.0]\n\n- Old.\n', '1.2.0'),
    /Added feature/,
  );

  withTempDir('pl-registry-', tmpDir => {
    const pluginA = path.join(tmpDir, 'plugins/alpha-csv-bank');
    const pluginB = path.join(tmpDir, 'plugins/beta-csv-bank');
    writeFiles(pluginA, makeCsvPluginFiles({ id: 'alpha-csv-bank', version: '1.0.0', tier: 'official' }));
    writeFiles(pluginB, makeCsvPluginFiles({ id: 'beta-csv-bank', version: '1.0.0', headerToken: 'BETA_HEADER' }));

    const first = buildRegistry({ rootDir: tmpDir });
    assert.equal(first.registry.plugins.length, 2);
    assert.equal(first.registry.plugins[0].id, 'alpha-csv-bank');
    assert.equal(first.registry.plugins[0].tier, 'official');
    assert.equal(first.registry.plugins[1].id, 'beta-csv-bank');
    assert.equal(first.registry.plugins[1].tier, 'community');
    assert.equal(first.registry.plugins[0].latestVersion, '1.0.0');

    // --check passes when up-to-date
    assert.equal(buildRegistry({ rootDir: tmpDir, check: true }).inSync, true);

    // Modifying code WITHOUT bumping version must fail immutability check
    fs.appendFileSync(path.join(pluginA, 'importer.mjs'), '\n// modified without bump\n');
    assert.throws(
      () => buildRegistry({ rootDir: tmpDir }),
      /Immutable version conflict for "alpha-csv-bank@1\.0\.0"/,
    );

    // Bumping version to 1.1.0 with CHANGELOG section preserves 1.0.0 for rollback
    const v110Manifest = JSON.parse(fs.readFileSync(path.join(pluginA, 'manifest.json'), 'utf8'));
    v110Manifest.version = '1.1.0';
    fs.writeFileSync(path.join(pluginA, 'manifest.json'), JSON.stringify(v110Manifest, null, 2));
    fs.writeFileSync(
      path.join(pluginA, 'CHANGELOG.md'),
      '# Changelog\n\n## [1.1.0]\n\n- Second release.\n\n## [1.0.0]\n\n- Initial synthetic release.\n',
    );

    // Before rebuilding, --check must detect drift
    assert.throws(() => buildRegistry({ rootDir: tmpDir, check: true }), /out of sync/);

    const second = buildRegistry({ rootDir: tmpDir });
    const alphaEntry = second.registry.plugins.find(p => p.id === 'alpha-csv-bank');
    assert.equal(alphaEntry.latestVersion, '1.1.0');
    assert.deepEqual(alphaEntry.versions.map(v => v.version), ['1.1.0', '1.0.0']);
    assert.equal(alphaEntry.versions[0].changelog, '- Second release.');
    assert.equal(alphaEntry.versions[1].changelog, '- Initial synthetic release.');
    assert.equal(
      alphaEntry.versions[0].downloadUrl,
      'https://github.com/tailoralm/personal-ledger-plugins/releases/download/alpha-csv-bank%401.1.0/alpha-csv-bank-1.1.0.zip',
    );

    // Missing CHANGELOG version section must fail
    v110Manifest.version = '1.2.0';
    fs.writeFileSync(path.join(pluginA, 'manifest.json'), JSON.stringify(v110Manifest, null, 2));
    assert.throws(() => buildRegistry({ rootDir: tmpDir }), /missing a "## \[1\.2\.0\]"/);
  });
});

test('cross-plugin detection matrix passes for mutually exclusive plugins and fails on greedy overlap', async () => {
  await withTempDirAsync('pl-matrix-', async tmpDir => {
    const dirA = path.join(tmpDir, 'plugins/alpha-csv-bank');
    const dirB = path.join(tmpDir, 'plugins/beta-csv-bank');
    writeFiles(dirA, makeCsvPluginFiles({ id: 'alpha-csv-bank', headerToken: 'ALPHA_HEADER' }));
    writeFiles(dirB, makeCsvPluginFiles({ id: 'beta-csv-bank', headerToken: 'BETA_HEADER' }));

    const sharedNegativeFiles = [
      path.join(ROOT, 'fixtures/compatibility/inputs/negative-unrelated.csv'),
      path.join(ROOT, 'fixtures/compatibility/inputs/negative-unrelated.pdf'),
    ];

    const passing = await runCrossPluginDetectionMatrix([dirA, dirB], { sharedNegativeFiles });
    assert.equal(passing.ok, true);
    assert.equal(passing.pluginCount, 2);
    assert.equal(passing.failures.length, 0);
    assert.ok(passing.checksRun >= 8);

    // Test greedy plugin in a fresh directory path to avoid Node ESM import() cache for the same URL
    const dirBGreedy = path.join(tmpDir, 'plugins/beta-greedy-bank');
    writeFiles(dirBGreedy, makeCsvPluginFiles({ id: 'beta-greedy-bank', headerToken: 'BETA_HEADER', greedy: true }));
    const failing = await runCrossPluginDetectionMatrix([dirA, dirBGreedy], { sharedNegativeFiles });
    assert.equal(failing.ok, false);
    assert.ok(failing.failures.some(f => f.kind === 'cross-plugin-false-positive' && f.pluginId === 'beta-greedy-bank'));
    assert.ok(failing.failures.some(f => f.kind === 'shared-negative' && f.pluginId === 'beta-greedy-bank'));
  });
});

test('runCiVerification passes end-to-end on repo and multi-plugin workspace, and rejects stale TypeScript dist output', async () => {
  // Full verification on actual repository
  const repoResult = await runCiVerification({ rootDir: ROOT });
  assert.equal(repoResult.ok, true);
  assert.ok(repoResult.schemaCount >= 4);
  assert.ok(repoResult.templateCount >= 2);

  // End-to-end multi-plugin workspace including a TypeScript plugin
  await withTempDirAsync('pl-ci-e2e-', async tmpDir => {
    fs.cpSync(path.join(ROOT, 'schemas'), path.join(tmpDir, 'schemas'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'sdk'), path.join(tmpDir, 'sdk'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'templates'), path.join(tmpDir, 'templates'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'fixtures'), path.join(tmpDir, 'fixtures'), { recursive: true });

    const dirA = path.join(tmpDir, 'plugins/alpha-csv-bank');
    const dirB = path.join(tmpDir, 'plugins/example-pdf-bank');
    writeFiles(dirA, makeCsvPluginFiles({ id: 'alpha-csv-bank', headerToken: 'ALPHA_HEADER', tier: 'official' }));
    fs.cpSync(path.join(ROOT, 'templates/typescript-importer'), dirB, { recursive: true });
    buildRegistry({ rootDir: tmpDir });

    const outDir = path.join(tmpDir, 'release-out');
    const fullRun = await runCiVerification({ rootDir: tmpDir, outDir });
    assert.equal(fullRun.ok, true);
    assert.equal(fullRun.pluginCount, 2);
    assert.equal(fullRun.packaged.length, 2);
    assert.equal(fullRun.tsCheckedCount, 2);
    assert.equal(fs.existsSync(path.join(outDir, 'alpha-csv-bank-1.0.0.zip.sha256')), true);
    assert.equal(fs.existsSync(path.join(outDir, 'example-pdf-bank-1.0.0.zip.sha256')), true);

    // Stale TypeScript compiled output must fail runCiVerification
    fs.appendFileSync(
      path.join(tmpDir, 'plugins/example-pdf-bank/dist/importer.mjs'),
      '\n// stale edit\n',
    );
    await assert.rejects(() => runCiVerification({ rootDir: tmpDir }), /is stale/);
  });
});
