import { isValidIsoDate } from '../../sdk/index.mjs';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getJsonType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(key => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

function decodePointerSegment(segment) {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function resolveJsonPointer(rootSchema, ref) {
  if (ref === '#') return rootSchema;
  if (!ref.startsWith('#/')) {
    throw new Error(`Unsupported $ref "${ref}": only local JSON pointer refs (#/...) are supported.`);
  }
  const parts = ref.slice(2).split('/').map(decodePointerSegment);
  let current = rootSchema;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !(part in current)) {
      throw new Error(`Unresolvable $ref "${ref}" at segment "${part}".`);
    }
    current = current[part];
  }
  return current;
}

function matchesType(value, expectedType) {
  const actual = getJsonType(value);
  if (expectedType === 'integer') {
    return typeof value === 'number' && Number.isInteger(value);
  }
  if (expectedType === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  return actual === expectedType;
}

function validateNode(schema, value, rootSchema, instancePath, errors) {
  if (schema === true) return;
  if (schema === false) {
    errors.push({ path: instancePath || '/', keyword: 'false', message: 'Value is disallowed by schema (false).' });
    return;
  }
  if (!isPlainObject(schema)) {
    throw new Error(`Invalid schema node at ${instancePath || '/'}`);
  }

  if (schema.$ref !== undefined) {
    const target = resolveJsonPointer(rootSchema, schema.$ref);
    validateNode(target, value, rootSchema, instancePath, errors);
  }

  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some(t => matchesType(value, t))) {
      errors.push({
        path: instancePath || '/',
        keyword: 'type',
        message: `Expected type ${allowed.join(' | ')}, got ${getJsonType(value)}.`,
      });
      return;
    }
  }

  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    errors.push({
      path: instancePath || '/',
      keyword: 'const',
      message: `Expected constant value ${JSON.stringify(schema.const)}.`,
    });
  }

  if (schema.enum !== undefined && !schema.enum.some(candidate => deepEqual(value, candidate))) {
    errors.push({
      path: instancePath || '/',
      keyword: 'enum',
      message: `Value must be one of ${JSON.stringify(schema.enum)}.`,
    });
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({
        path: instancePath || '/',
        keyword: 'minLength',
        message: `String length ${value.length} is less than minLength ${schema.minLength}.`,
      });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({
        path: instancePath || '/',
        keyword: 'maxLength',
        message: `String length ${value.length} exceeds maxLength ${schema.maxLength}.`,
      });
    }
    if (schema.pattern !== undefined) {
      const re = new RegExp(schema.pattern, 'u');
      if (!re.test(value)) {
        errors.push({
          path: instancePath || '/',
          keyword: 'pattern',
          message: `String ${JSON.stringify(value)} does not match pattern ${schema.pattern}.`,
        });
      }
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({
        path: instancePath || '/',
        keyword: 'minimum',
        message: `Number ${value} is less than minimum ${schema.minimum}.`,
      });
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      errors.push({
        path: instancePath || '/',
        keyword: 'exclusiveMinimum',
        message: `Number ${value} must be strictly greater than ${schema.exclusiveMinimum}.`,
      });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({
        path: instancePath || '/',
        keyword: 'maximum',
        message: `Number ${value} exceeds maximum ${schema.maximum}.`,
      });
    }
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
      errors.push({
        path: instancePath || '/',
        keyword: 'exclusiveMaximum',
        message: `Number ${value} must be strictly less than ${schema.exclusiveMaximum}.`,
      });
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({
        path: instancePath || '/',
        keyword: 'minItems',
        message: `Array length ${value.length} is less than minItems ${schema.minItems}.`,
      });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({
        path: instancePath || '/',
        keyword: 'maxItems',
        message: `Array length ${value.length} exceeds maxItems ${schema.maxItems}.`,
      });
    }
    if (schema.uniqueItems === true) {
      for (let i = 0; i < value.length; i++) {
        for (let j = i + 1; j < value.length; j++) {
          if (deepEqual(value[i], value[j])) {
            errors.push({
              path: `${instancePath}/${j}`,
              keyword: 'uniqueItems',
              message: `Duplicate array item at indices ${i} and ${j}.`,
            });
            break;
          }
        }
      }
    }
    if (schema.items !== undefined) {
      for (let i = 0; i < value.length; i++) {
        validateNode(schema.items, value[i], rootSchema, `${instancePath}/${i}`, errors);
      }
    }
  }

  if (isPlainObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, reqKey)) {
          errors.push({
            path: `${instancePath}/${reqKey}`,
            keyword: 'required',
            message: `Missing required property "${reqKey}".`,
          });
        }
      }
    }

    const props = schema.properties ?? {};
    for (const [key, propSchema] of Object.entries(props)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        validateNode(propSchema, value[key], rootSchema, `${instancePath}/${key}`, errors);
      }
    }

    if (schema.additionalProperties !== undefined) {
      for (const key of Object.keys(value)) {
        if (Object.prototype.hasOwnProperty.call(props, key)) continue;
        if (schema.additionalProperties === false) {
          errors.push({
            path: `${instancePath}/${key}`,
            keyword: 'additionalProperties',
            message: `Unexpected additional property "${key}".`,
          });
        } else if (isPlainObject(schema.additionalProperties)) {
          validateNode(schema.additionalProperties, value[key], rootSchema, `${instancePath}/${key}`, errors);
        }
      }
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      validateNode(sub, value, rootSchema, instancePath, errors);
    }
  }

  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.some(sub => {
      const subErrors = [];
      validateNode(sub, value, rootSchema, instancePath, subErrors);
      return subErrors.length === 0;
    });
    if (!matched) {
      errors.push({
        path: instancePath || '/',
        keyword: 'anyOf',
        message: 'Value did not satisfy any schema in anyOf.',
      });
    }
  }

  if (Array.isArray(schema.oneOf)) {
    let matches = 0;
    for (const sub of schema.oneOf) {
      const subErrors = [];
      validateNode(sub, value, rootSchema, instancePath, subErrors);
      if (subErrors.length === 0) matches++;
    }
    if (matches !== 1) {
      errors.push({
        path: instancePath || '/',
        keyword: 'oneOf',
        message: `Expected value to match exactly one schema in oneOf, matched ${matches}.`,
      });
    }
  }

  if (schema.not !== undefined) {
    const subErrors = [];
    validateNode(schema.not, value, rootSchema, instancePath, subErrors);
    if (subErrors.length === 0) {
      errors.push({
        path: instancePath || '/',
        keyword: 'not',
        message: 'Value must not satisfy the schema in "not".',
      });
    }
  }

  if (schema.if !== undefined) {
    const ifErrors = [];
    validateNode(schema.if, value, rootSchema, instancePath, ifErrors);
    if (ifErrors.length === 0) {
      if (schema.then !== undefined) {
        validateNode(schema.then, value, rootSchema, instancePath, errors);
      }
    } else if (schema.else !== undefined) {
      validateNode(schema.else, value, rootSchema, instancePath, errors);
    }
  }
}

export function validateSchema(schema, data) {
  const errors = [];
  validateNode(schema, data, schema, '', errors);
  return {
    valid: errors.length === 0,
    errors,
  };
}

export function assertValidSchema(schema, data, label = 'Document') {
  const result = validateSchema(schema, data);
  if (!result.valid) {
    const formatted = result.errors.map(err => `  - ${err.path || '/'} [${err.keyword}]: ${err.message}`).join('\n');
    throw new Error(`${label} failed JSON Schema validation:\n${formatted}`);
  }
}

function validateCapabilityOptions(options, label) {
  const optionIds = new Set();
  for (const option of options ?? []) {
    if (optionIds.has(option.id)) {
      throw new Error(`${label} has duplicate capability option id "${option.id}".`);
    }
    optionIds.add(option.id);
    if (option.type === 'enum') {
      if (!option.values.includes(option.default)) {
        throw new Error(`Capability option "${option.id}" default "${option.default}" must be one of ${JSON.stringify(option.values)}.`);
      }
      if (option.legacyCliDefault !== undefined && !option.values.includes(option.legacyCliDefault)) {
        throw new Error(`Capability option "${option.id}" legacyCliDefault "${option.legacyCliDefault}" must be one of ${JSON.stringify(option.values)}.`);
      }
    }
  }
}

export function compareSemVer(a, b) {
  const semverRe = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
  const ma = semverRe.exec(a);
  const mb = semverRe.exec(b);
  if (!ma || !mb) {
    throw new Error(`Invalid SemVer comparison between "${a}" and "${b}".`);
  }

  for (let i = 1; i <= 3; i++) {
    const na = Number(ma[i]);
    const nb = Number(mb[i]);
    if (na !== nb) return na - nb;
  }

  const preA = ma[4] ? ma[4].split('.') : null;
  const preB = mb[4] ? mb[4].split('.') : null;
  if (!preA && !preB) return 0;
  if (!preA) return 1;
  if (!preB) return -1;

  const len = Math.max(preA.length, preB.length);
  for (let i = 0; i < len; i++) {
    if (i >= preA.length) return -1;
    if (i >= preB.length) return 1;
    const partA = preA[i];
    const partB = preB[i];
    const numA = /^\d+$/.test(partA);
    const numB = /^\d+$/.test(partB);
    if (numA && numB) {
      const diff = Number(partA) - Number(partB);
      if (diff !== 0) return diff;
    } else if (numA !== numB) {
      return numA ? -1 : 1;
    } else if (partA !== partB) {
      return partA < partB ? -1 : 1;
    }
  }
  return 0;
}

export function validateManifestSemantics(manifest, manifestSchema) {
  assertValidSchema(manifestSchema, manifest, 'Plugin manifest');
  validateCapabilityOptions(manifest.capabilities?.options, 'Plugin manifest');
}

export function validateRegistrySemantics(registry, registrySchema) {
  assertValidSchema(registrySchema, registry, 'Plugin registry');

  const seenIds = new Set();
  for (let i = 0; i < registry.plugins.length; i++) {
    const entry = registry.plugins[i];
    if (seenIds.has(entry.id)) {
      throw new Error(`Plugin registry contains duplicate plugin id "${entry.id}".`);
    }
    seenIds.add(entry.id);

    if (i > 0 && registry.plugins[i - 1].id > entry.id) {
      throw new Error(`Plugin registry plugins[] is not sorted by id ("${registry.plugins[i - 1].id}" before "${entry.id}").`);
    }

    validateCapabilityOptions(entry.capabilities?.options, `Registry entry "${entry.id}"`);

    const seenVersions = new Set();
    for (let j = 0; j < entry.versions.length; j++) {
      const ver = entry.versions[j];
      if (seenVersions.has(ver.version)) {
        throw new Error(`Registry entry "${entry.id}" contains duplicate version "${ver.version}".`);
      }
      seenVersions.add(ver.version);

      if (j > 0 && compareSemVer(entry.versions[j - 1].version, ver.version) <= 0) {
        throw new Error(`Registry entry "${entry.id}" versions[] must be sorted descending by SemVer ("${entry.versions[j - 1].version}" before "${ver.version}").`);
      }

      const expectedTag = `${entry.id}@${ver.version}`;
      if (ver.tag !== expectedTag) {
        throw new Error(`Registry entry "${entry.id}" version "${ver.version}" has invalid tag "${ver.tag}" (expected "${expectedTag}").`);
      }
      const expectedFile = `${entry.id}-${ver.version}.zip`;
      if (ver.packageFile !== expectedFile) {
        throw new Error(`Registry entry "${entry.id}" version "${ver.version}" has invalid packageFile "${ver.packageFile}" (expected "${expectedFile}").`);
      }
      const expectedSourcePath = `plugins/${entry.id}`;
      if (ver.sourcePath !== expectedSourcePath) {
        throw new Error(`Registry entry "${entry.id}" version "${ver.version}" has invalid sourcePath "${ver.sourcePath}" (expected "${expectedSourcePath}").`);
      }
      const expectedDownloadSuffix = `/releases/download/${encodeURIComponent(entry.id)}%40${encodeURIComponent(ver.version)}/${expectedFile}`;
      if (!ver.downloadUrl.endsWith(expectedDownloadSuffix)) {
        throw new Error(`Registry entry "${entry.id}" version "${ver.version}" downloadUrl "${ver.downloadUrl}" must end with "${expectedDownloadSuffix}".`);
      }
    }

    if (entry.latestVersion !== entry.versions[0].version) {
      throw new Error(`Registry entry "${entry.id}" latestVersion "${entry.latestVersion}" does not match highest version "${entry.versions[0].version}".`);
    }
  }
}

export function validateImportResultSemantics(importResult, importResultSchema, manifest) {
  assertValidSchema(importResultSchema, importResult, 'ImportResult');

  for (let i = 0; i < importResult.transactions.length; i++) {
    const tx = importResult.transactions[i];
    if (!isValidIsoDate(tx.date)) {
      throw new Error(`ImportResult transaction[${i}] has non-calendar date "${tx.date}" (${tx.evidence?.locator ?? 'unknown locator'}).`);
    }
  }

  if (manifest) {
    if (importResult.pluginId !== manifest.id) {
      throw new Error(`ImportResult pluginId "${importResult.pluginId}" does not match manifest.id "${manifest.id}".`);
    }
    if (importResult.institutionId !== manifest.institution.id) {
      throw new Error(`ImportResult institutionId "${importResult.institutionId}" does not match manifest.institution.id "${manifest.institution.id}".`);
    }
  }
}
