import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  validateImportResultSemantics,
  validateManifestSemantics,
  validateSchema,
} from '../scripts/lib/schema-validator.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const manifestSchema = readJson('schemas/plugin-manifest.v1.schema.json');
const detectionSchema = readJson('schemas/detection-result.v1.schema.json');
const importResultSchema = readJson('schemas/import-result.v1.schema.json');

function baseManifest(overrides = {}) {
  return {
    id: 'sample-bank',
    name: 'Sample Bank Importer',
    version: '1.0.0',
    pluginApiVersion: '1',
    type: 'bank-importer',
    description: 'Parses Sample Bank statements.',
    author: { name: 'Test Author', url: 'https://example.com' },
    license: 'MIT',
    institution: { id: 'sample-bank', name: 'Sample Bank', country: 'PT' },
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
    ...overrides,
  };
}

test('JSON Schema files declare Draft 2020-12', () => {
  for (const schema of [manifestSchema, detectionSchema, importResultSchema]) {
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(schema.type, 'object');
  }
});

test('plugin-manifest schema validates valid manifests and rejects invalid fields', () => {
  validateManifestSemantics(baseManifest(), manifestSchema);

  validateManifestSemantics(
    baseManifest({
      institution: { id: 'trading212', name: 'Trading 212', country: 'EU', legacyNames: ['Trading212'] },
      capabilities: {
        supportsRunningBalance: false,
        supportsSourceIds: true,
        supportsMultiCurrency: true,
        supportsYearInference: false,
        supportsInvestments: true,
        supportsSideInvestments: true,
        supportsBackfill: true,
        options: [
          {
            id: 'includeAllActivity',
            label: 'Include all activity',
            description: 'Include buys, sells, dividends, cashback, and interest.',
            type: 'boolean',
            default: true,
            legacyCliDefault: false,
          },
          {
            id: 'mode',
            label: 'Import mode',
            description: 'Select scope.',
            type: 'enum',
            values: ['full', 'cash-only'],
            default: 'full',
            legacyCliDefault: 'cash-only',
          },
        ],
      },
      tier: 'official',
      languages: ['en', 'pt-PT'],
      keywords: ['bank', 'csv'],
    }),
    manifestSchema,
  );

  // Invalid id (single segment / uppercase)
  assert.equal(validateSchema(manifestSchema, baseManifest({ id: 'singleword' })).valid, false);
  assert.equal(validateSchema(manifestSchema, baseManifest({ id: 'Bad-Id' })).valid, false);

  // Invalid SemVer
  assert.equal(validateSchema(manifestSchema, baseManifest({ version: '1.0' })).valid, false);
  assert.equal(validateSchema(manifestSchema, baseManifest({ version: 'v1.0.0' })).valid, false);
  assert.equal(validateSchema(manifestSchema, baseManifest({ version: '01.0.0' })).valid, false);

  // Non-empty permissions must fail
  assert.equal(validateSchema(manifestSchema, baseManifest({ permissions: ['fs:read'] })).valid, false);

  // Unsafe entrypoints must fail
  assert.equal(validateSchema(manifestSchema, baseManifest({ entrypoint: '../evil.mjs' })).valid, false);
  assert.equal(validateSchema(manifestSchema, baseManifest({ entrypoint: '/abs/importer.mjs' })).valid, false);
  assert.equal(validateSchema(manifestSchema, baseManifest({ entrypoint: 'importer.js' })).valid, false);

  // Invalid country / account type / extra property
  assert.equal(validateSchema(manifestSchema, baseManifest({ institution: { id: 'a', name: 'A', country: 'pt' } })).valid, false);
  assert.equal(validateSchema(manifestSchema, baseManifest({ accountTypes: ['crypto'] })).valid, false);
  assert.equal(validateSchema(manifestSchema, baseManifest({ unknownField: 123 })).valid, false);

  // Invalid capability option semantics
  assert.throws(
    () => validateManifestSemantics(
      baseManifest({
        capabilities: {
          ...baseManifest().capabilities,
          options: [{ id: 'mode', label: 'Mode', description: 'Mode', type: 'enum', values: ['a', 'b'], default: 'c' }],
        },
      }),
      manifestSchema,
    ),
    /must be one of/,
  );

  assert.equal(
    validateSchema(
      manifestSchema,
      baseManifest({
        capabilities: {
          ...baseManifest().capabilities,
          options: [{ id: 'flag', label: 'Flag', description: 'Flag', type: 'boolean', default: true, values: ['true'] }],
        },
      }),
    ).valid,
    false,
  );
});

test('detection-result schema enforces matched vs confidence invariants', () => {
  assert.equal(
    validateSchema(detectionSchema, { matched: false, confidence: 0, reason: 'Header missing' }).valid,
    true,
  );
  assert.equal(
    validateSchema(detectionSchema, {
      matched: true,
      confidence: 0.95,
      reason: 'Matched headers',
      format: 'csv',
      institutionId: 'sample-bank',
      ambiguity: { possibleOverlap: false, notes: 'Distinct header row' },
      metadata: { headerRow: 1 },
    }).valid,
    true,
  );

  // matched=false with confidence > 0 must fail
  assert.equal(
    validateSchema(detectionSchema, { matched: false, confidence: 0.1, reason: 'Nope' }).valid,
    false,
  );
  // matched=true with confidence = 0 must fail
  assert.equal(
    validateSchema(detectionSchema, { matched: true, confidence: 0, reason: 'Matched' }).valid,
    false,
  );
  // Empty reason or out-of-range confidence must fail
  assert.equal(
    validateSchema(detectionSchema, { matched: false, confidence: 0, reason: '' }).valid,
    false,
  );
  assert.equal(
    validateSchema(detectionSchema, { matched: true, confidence: 1.1, reason: 'Too high' }).valid,
    false,
  );
});

test('import-result schema and semantic validator enforce ISO dates, decimals, currency, and evidence', () => {
  const validResult = {
    pluginApiVersion: '1',
    pluginId: 'sample-bank',
    institutionId: 'sample-bank',
    transactions: [
      {
        date: '2024-02-29',
        description: 'Leap Day Coffee',
        amount: '-3.50',
        currency: 'EUR',
        balance: '0.00',
        sourceId: 'src-1',
        evidence: {
          row: 2,
          locator: 'Record 2',
          rawDate: '2024-02-29 08:30:00',
          rawAmount: '-3.50',
          runningBalance: '0.00',
        },
      },
      {
        date: '2026-08-01',
        description: 'Unstated Currency Payment',
        amount: '100',
        currency: '',
        evidence: {
          row: 1,
          page: 1,
          locator: 'Page 1, row 1',
          yearInferred: true,
        },
      },
    ],
    diagnostics: [
      {
        locator: 'Record 3',
        reason: 'Invalid calendar date',
        code: 'INVALID_ROW',
        severity: 'warning',
        rawDate: '2026-02-30',
      },
    ],
  };

  validateImportResultSemantics(validResult, importResultSchema, baseManifest());

  // Non-leap Feb 29 fails calendar validation
  const badLeap = structuredClone(validResult);
  badLeap.transactions[0].date = '2025-02-29';
  assert.throws(() => validateImportResultSemantics(badLeap, importResultSchema), /non-calendar date/);

  // Feb 30 fails calendar validation
  const feb30 = structuredClone(validResult);
  feb30.transactions[0].date = '2026-02-30';
  assert.throws(() => validateImportResultSemantics(feb30, importResultSchema), /non-calendar date/);

  // DD/MM/YYYY fails schema pattern
  const ddmmyyyy = structuredClone(validResult);
  ddmmyyyy.transactions[0].date = '29/02/2024';
  assert.equal(validateSchema(importResultSchema, ddmmyyyy).valid, false);

  // Whitespace-only description fails
  const blankDesc = structuredClone(validResult);
  blankDesc.transactions[0].description = '   ';
  assert.equal(validateSchema(importResultSchema, blankDesc).valid, false);

  // Signed + or comma decimal fails
  const plusAmt = structuredClone(validResult);
  plusAmt.transactions[0].amount = '+3.50';
  assert.equal(validateSchema(importResultSchema, plusAmt).valid, false);

  const commaAmt = structuredClone(validResult);
  commaAmt.transactions[0].amount = '3,50';
  assert.equal(validateSchema(importResultSchema, commaAmt).valid, false);

  // Invalid currency fails
  const badCurr = structuredClone(validResult);
  badCurr.transactions[0].currency = 'eur';
  assert.equal(validateSchema(importResultSchema, badCurr).valid, false);

  // Manifest pluginId mismatch fails
  assert.throws(
    () => validateImportResultSemantics(validResult, importResultSchema, baseManifest({ id: 'other-bank' })),
    /does not match manifest\.id/,
  );
});

test('zero-dependency schema validator covers allOf, anyOf, oneOf, not, $ref, uniqueItems', () => {
  const testSchema = {
    $defs: {
      item: { type: 'integer', minimum: 1 },
    },
    type: 'object',
    properties: {
      list: { type: 'array', items: { $ref: '#/$defs/item' }, uniqueItems: true, minItems: 1, maxItems: 3 },
      choice: { oneOf: [{ type: 'string', minLength: 2, maxLength: 4 }, { type: 'integer', exclusiveMinimum: 10 }] },
      either: { anyOf: [{ const: 'a' }, { const: 'b' }] },
      guarded: { allOf: [{ type: 'string' }, { not: { pattern: 'bad' } }] },
    },
  };

  assert.equal(validateSchema(testSchema, { list: [1, 2], choice: 11, either: 'a', guarded: 'ok' }).valid, true);
  assert.equal(validateSchema(testSchema, { list: [1, 1] }).valid, false);
  assert.equal(validateSchema(testSchema, { choice: 10 }).valid, false);
  assert.equal(validateSchema(testSchema, { choice: 'x' }).valid, false);
  assert.equal(validateSchema(testSchema, { either: 'c' }).valid, false);
  assert.equal(validateSchema(testSchema, { guarded: 'bad-word' }).valid, false);
});
