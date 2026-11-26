import fs from 'node:fs';
import path from 'node:path';
import { extractPdfDocument } from '../../sdk/pdf-host.mjs';
import {
  ZIP_LIMITS,
  comparePosixPaths,
  validateArchiveFileName,
} from './deterministic-zip.mjs';

const CODE_EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.mts', '.ts']);
const TEXT_EXTENSIONS = new Set([
  '.mjs', '.js', '.cjs', '.mts', '.ts', '.json', '.md', '.txt', '.csv', '.tsv', '.xml', '.yml', '.yaml',
]);
const FORBIDDEN_DIRS = new Set(['node_modules', 'dist-packages']);

const FORBIDDEN_RUNTIME_IDENTIFIERS = [
  'process',
  'Deno',
  'Bun',
  'require',
  'eval',
  'Function',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'globalThis',
  'Buffer',
  '__dirname',
  '__filename',
];

const REGEX_PREV_KEYWORDS = new Set([
  'return', 'throw', 'case', 'delete', 'void', 'typeof', 'in',
  'instanceof', 'new', 'yield', 'await', 'else', 'do', 'of',
]);

const ALLOWED_TS_TYPE_IMPORT_RE = /^(?:\.\.\/)+sdk\/index\.(?:d\.ts|m?js)$/;

const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g;
const TOKEN_PATTERNS = [
  { rule: 'api-token-ghp', re: /\bghp_[A-Za-z0-9]{12,}\b/g, label: 'GitHub classic personal access token (ghp_...)' },
  { rule: 'api-token-github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, label: 'GitHub fine-grained personal access token (github_pat_...)' },
  { rule: 'api-token-stripe', re: /\bsk_live_[A-Za-z0-9]{12,}\b/g, label: 'Stripe live secret key (sk_live_...)' },
  { rule: 'api-token-aws', re: /\bAKIA[0-9A-Z]{16}\b/g, label: 'AWS access key ID (AKIA...)' },
];

const PAN_CANDIDATE_RE = /(?<![A-Za-z0-9.])(?:\d{4}(?:[ -]\d{4}){2,3}(?:[ -]\d{1,4})?|\d{4}[ -]\d{6}[ -]\d{5}|\d{13,19})(?![A-Za-z0-9.])/g;
const IBAN_CANDIDATE_RE = /\b(?:[A-Z]{2}\d{2}(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,4})?|[A-Z]{2}\d{2}[A-Z0-9]{11,30})\b/g;

function getLineNumber(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * Token-aware JS/TS scanner that strips line comments, block comments, regex literals,
 * and string/template text while preserving executable `${...}` template expressions
 * and retaining exact newline counts for accurate line reporting.
 */
export function stripJsTsCommentsAndLiterals(source) {
  const withoutComments = [];
  const codeOnly = [];
  const strings = new Map();
  const len = source.length;
  const stack = []; // stack of { type: 'TEMPLATE' } | { type: 'EXPR', braceDepth: number }

  let i = 0;
  let stringIndex = 0;
  let lastToken = 'START'; // START | OP | KW_REGEX | IDENT | NUM | CLOSE | STR

  const pushBoth = (ch) => {
    withoutComments.push(ch);
    codeOnly.push(ch);
  };

  const pushMasked = (ch) => {
    withoutComments.push(ch);
    if (ch === '\n') codeOnly.push('\n');
  };

  const skipCommentPreserveLines = (endIdx) => {
    for (let k = i; k < endIdx; k++) {
      const ch = source[k];
      const out = ch === '\n' ? '\n' : ' ';
      withoutComments.push(out);
      codeOnly.push(out);
    }
    i = endIdx;
  };

  const scanString = (quote) => {
    withoutComments.push(quote);
    i++;
    const rawChars = [];
    let newlineCount = 0;
    while (i < len) {
      const ch = source[i];
      if (ch === '\\') {
        withoutComments.push(ch);
        i++;
        if (i < len) {
          const esc = source[i];
          withoutComments.push(esc);
          if (esc === '\n') {
            newlineCount++;
          } else {
            rawChars.push(esc);
          }
          i++;
        }
        continue;
      }
      if (ch === quote) {
        withoutComments.push(quote);
        i++;
        break;
      }
      withoutComments.push(ch);
      if (ch === '\n') newlineCount++;
      rawChars.push(ch);
      i++;
    }
    const token = `__STR_${stringIndex++}__`;
    strings.set(token, rawChars.join(''));
    codeOnly.push(`"${token}"`);
    for (let n = 0; n < newlineCount; n++) {
      codeOnly.push('\n');
    }
    lastToken = 'STR';
  };

  const scanRegex = () => {
    withoutComments.push('/');
    codeOnly.push('/(?:)/');
    i++;
    let inCharClass = false;
    while (i < len) {
      const ch = source[i];
      if (ch === '\\') {
        withoutComments.push(ch);
        i++;
        if (i < len) {
          withoutComments.push(source[i]);
          if (source[i] === '\n') codeOnly.push('\n');
          i++;
        }
        continue;
      }
      if (ch === '[' && !inCharClass) {
        inCharClass = true;
        withoutComments.push(ch);
        i++;
        continue;
      }
      if (ch === ']' && inCharClass) {
        inCharClass = false;
        withoutComments.push(ch);
        i++;
        continue;
      }
      if (ch === '/' && !inCharClass) {
        withoutComments.push('/');
        i++;
        while (i < len && /[a-zA-Z]/.test(source[i])) {
          withoutComments.push(source[i]);
          i++;
        }
        lastToken = 'STR';
        return;
      }
      if (ch === '\n') {
        withoutComments.push('\n');
        codeOnly.push('\n');
        i++;
        lastToken = 'OP';
        return;
      }
      withoutComments.push(ch);
      i++;
    }
    lastToken = 'STR';
  };

  while (i < len) {
    const top = stack[stack.length - 1];
    if (top && top.type === 'TEMPLATE') {
      const ch = source[i];
      if (ch === '\\') {
        pushMasked(ch);
        i++;
        if (i < len) {
          pushMasked(source[i]);
          i++;
        }
        continue;
      }
      if (ch === '`') {
        withoutComments.push('`');
        codeOnly.push('"');
        stack.pop();
        i++;
        lastToken = 'STR';
        continue;
      }
      if (ch === '$' && source[i + 1] === '{') {
        withoutComments.push('${');
        codeOnly.push('" (');
        stack.push({ type: 'EXPR', braceDepth: 0 });
        i += 2;
        lastToken = 'OP';
        continue;
      }
      pushMasked(ch);
      i++;
      continue;
    }

    const ch = source[i];
    const next = source[i + 1];

    // Comments
    if (ch === '/' && next === '/') {
      let end = i + 2;
      while (end < len && source[end] !== '\n') end++;
      skipCommentPreserveLines(end);
      continue;
    }
    if (ch === '/' && next === '*') {
      const closeIdx = source.indexOf('*/', i + 2);
      const end = closeIdx === -1 ? len : closeIdx + 2;
      skipCommentPreserveLines(end);
      continue;
    }

    // Regex literal vs division
    if (ch === '/') {
      const canStartRegex = lastToken === 'START' || lastToken === 'OP' || lastToken === 'KW_REGEX';
      if (canStartRegex) {
        scanRegex();
        continue;
      }
      pushBoth('/');
      i++;
      lastToken = 'OP';
      continue;
    }

    // Quotes & templates
    if (ch === '\'' || ch === '"') {
      scanString(ch);
      continue;
    }
    if (ch === '`') {
      withoutComments.push('`');
      codeOnly.push('"');
      stack.push({ type: 'TEMPLATE' });
      i++;
      continue;
    }

    // Braces inside template expressions
    if (ch === '{') {
      if (top && top.type === 'EXPR') {
        top.braceDepth++;
      }
      pushBoth('{');
      i++;
      lastToken = 'OP';
      continue;
    }
    if (ch === '}') {
      if (top && top.type === 'EXPR') {
        if (top.braceDepth === 0) {
          withoutComments.push('}');
          codeOnly.push(') "');
          stack.pop();
          i++;
          continue;
        }
        top.braceDepth--;
      }
      pushBoth('}');
      i++;
      lastToken = 'OP';
      continue;
    }

    if (/\s/.test(ch)) {
      pushBoth(ch);
      i++;
      continue;
    }

    // Identifiers / keywords
    if (/[A-Za-z_$]/.test(ch)) {
      let end = i + 1;
      while (end < len && /[A-Za-z0-9_$]/.test(source[end])) end++;
      const ident = source.slice(i, end);
      withoutComments.push(ident);
      codeOnly.push(ident);
      lastToken = REGEX_PREV_KEYWORDS.has(ident) ? 'KW_REGEX' : 'IDENT';
      i = end;
      continue;
    }

    // Numbers
    if (/[0-9]/.test(ch)) {
      let end = i + 1;
      while (end < len && /[0-9a-fA-FxXoObBn._]/.test(source[end])) end++;
      const num = source.slice(i, end);
      withoutComments.push(num);
      codeOnly.push(num);
      lastToken = 'NUM';
      i = end;
      continue;
    }

    // Closing brackets allow division after them
    if (ch === ')' || ch === ']') {
      pushBoth(ch);
      i++;
      lastToken = 'CLOSE';
      continue;
    }

    pushBoth(ch);
    i++;
    lastToken = 'OP';
  }

  return {
    withoutComments: withoutComments.join(''),
    codeOnly: codeOnly.join(''),
    strings,
  };
}

function classifyForbiddenSpecifier(specifier) {
  if (specifier.startsWith('node:')) {
    return `Forbidden Node built-in import "${specifier}"`;
  }
  if (/^(?:https?|file|data):/i.test(specifier)) {
    return `Forbidden URL/scheme import "${specifier}"`;
  }
  if (specifier.includes('..')) {
    return `Forbidden parent-relative import "${specifier}"`;
  }
  if (specifier.startsWith('/')) {
    return `Forbidden absolute-path import "${specifier}"`;
  }
  if (!specifier.startsWith('./')) {
    return `Forbidden external or built-in package import "${specifier}"`;
  }
  return null;
}

function isAllowedTypeOnlySdkImport(statementText, specifier, isTypeScriptFile) {
  if (!isTypeScriptFile) return false;
  if (!ALLOWED_TS_TYPE_IMPORT_RE.test(specifier)) return false;
  if (/^\s*import\s+type\b/.test(statementText)) return true;

  const namedMatch = /^\s*import\s*\{([^}]*)\}\s*from\s*['"]/.exec(statementText);
  if (!namedMatch) return false;
  const specifiers = namedMatch[1]
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
  return specifiers.length > 0 && specifiers.every(part => /^type\s+/.test(part));
}

function isLuhnValid(digits) {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function matchesPaymentIin(digits) {
  return (
    /^4\d{12}(?:\d{3})?(?:\d{3})?$/.test(digits)
    || /^(?:5[1-5]\d{14}|2(?:22[1-9]|2[3-9]\d|[3-6]\d{2}|7[01]\d|720)\d{12})$/.test(digits)
    || /^3[47]\d{13}$/.test(digits)
    || /^(?:6(?:011|4[4-9]\d|5\d{2})\d{12,15}|62\d{14,17}|3(?:0[0-5]|[68]\d)\d{11,13}|5[06-9]\d{10,17})$/.test(digits)
  );
}

function computeIbanMod97(compactIban) {
  const rearranged = compactIban.slice(4) + compactIban.slice(0, 4);
  let remainder = 0;
  for (let i = 0; i < rearranged.length; i++) {
    const code = rearranged.charCodeAt(i);
    if (code >= 48 && code <= 57) {
      remainder = (remainder * 10 + (code - 48)) % 97;
    } else if (code >= 65 && code <= 90) {
      const val = code - 55; // A=10 .. Z=35
      remainder = (remainder * 100 + val) % 97;
    } else {
      return -1;
    }
  }
  return remainder;
}

function isSyntheticIban(compactIban) {
  const country = compactIban.slice(0, 2);
  if (country === 'XX' || country === 'ZZ') return true;
  const bban = compactIban.slice(4);
  if (/^0+$/.test(bban)) return true;
  if (/^(\d)\1+$/.test(bban)) return true;
  if (/(?:TEST|FAKE|DEMO|SYNTH|EXAMPLE|DUMMY)/.test(bban)) return true;
  return false;
}

export function scanPrivacyAndSecrets(text, filePath = 'input.txt') {
  const errors = [];
  const warnings = [];

  for (const match of text.matchAll(PRIVATE_KEY_RE)) {
    errors.push({
      file: filePath,
      line: getLineNumber(text, match.index ?? 0),
      rule: 'private-key',
      message: `Detected private key header "${match[0]}" in "${filePath}".`,
    });
  }

  for (const { rule, re, label } of TOKEN_PATTERNS) {
    for (const match of text.matchAll(re)) {
      errors.push({
        file: filePath,
        line: getLineNumber(text, match.index ?? 0),
        rule,
        message: `Detected ${label} in "${filePath}".`,
      });
    }
  }

  const ibanSpans = [];
  for (const match of text.matchAll(IBAN_CANDIDATE_RE)) {
    const raw = match[0];
    const compact = raw.replace(/\s+/g, '');
    if (compact.length < 15 || compact.length > 34) continue;
    if (computeIbanMod97(compact) !== 1) continue;
    const start = match.index ?? 0;
    ibanSpans.push([start, start + raw.length]);
    if (isSyntheticIban(compact)) continue;

    errors.push({
      file: filePath,
      line: getLineNumber(text, start),
      rule: 'personal-iban',
      message: `Detected non-synthetic MOD-97 valid IBAN in "${filePath}". Use only synthetic/zero-fill/XX placeholders.`,
    });
  }

  for (const match of text.matchAll(PAN_CANDIDATE_RE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (ibanSpans.some(([s, e]) => start >= s && end <= e)) {
      continue;
    }
    const digits = match[0].replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    if (/^0+$/.test(digits)) continue;
    if (!matchesPaymentIin(digits)) continue;
    if (!isLuhnValid(digits)) continue;

    errors.push({
      file: filePath,
      line: getLineNumber(text, start),
      rule: 'payment-pan',
      message: `Detected Luhn-valid payment card number pattern in "${filePath}". Use masked or synthetic placeholders instead.`,
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

export function scanSourceText(source, filePath = 'importer.mjs') {
  const errors = [];
  const warnings = [];
  const ext = path.extname(filePath).toLowerCase();
  const isTypeScriptFile = ext === '.ts' || ext === '.mts';

  const { codeOnly, strings } = stripJsTsCommentsAndLiterals(source);

  // 1. Static import / export-from statements (matching string placeholders in codeOnly)
  const staticImportRe = /\bimport\s*"(__STR_\d+__)"|\b(?:import|export)\s+(?:type\s+)?[^;=()'"`]+?\s+from\s+"(__STR_\d+__)"/g;
  for (const match of codeOnly.matchAll(staticImportRe)) {
    const fullStatement = match[0];
    const token = match[1] ?? match[2];
    const specifier = strings.get(token) ?? '';
    if (isAllowedTypeOnlySdkImport(fullStatement, specifier, isTypeScriptFile)) {
      continue;
    }
    const problem = classifyForbiddenSpecifier(specifier);
    if (problem) {
      errors.push({
        file: filePath,
        line: getLineNumber(codeOnly, match.index ?? 0),
        rule: 'forbidden-import',
        message: `${problem} in "${filePath}".`,
      });
    } else if (isTypeScriptFile) {
      // Runtime relative imports in TS plugins are permitted only for ./ local files
      if (!specifier.startsWith('./') || specifier.includes('..')) {
        errors.push({
          file: filePath,
          line: getLineNumber(codeOnly, match.index ?? 0),
          rule: 'forbidden-import',
          message: `Forbidden TypeScript import "${specifier}" in "${filePath}".`,
        });
      }
    }
  }

  // 2. Literal require('...') or import('...') specifiers
  const callImportRe = /\b(?:import|require)\s*\(\s*"(__STR_\d+__)"\s*\)/g;
  for (const match of codeOnly.matchAll(callImportRe)) {
    const specifier = strings.get(match[1]) ?? '';
    const problem = classifyForbiddenSpecifier(specifier);
    if (problem) {
      errors.push({
        file: filePath,
        line: getLineNumber(codeOnly, match.index ?? 0),
        rule: 'forbidden-import',
        message: `${problem} in "${filePath}".`,
      });
    }
  }

  // 3. Dynamic import(...) in codeOnly (catches import(expr) and import('...'))
  const dynamicImportRe = /\bimport\s*\(/g;
  for (const match of codeOnly.matchAll(dynamicImportRe)) {
    errors.push({
      file: filePath,
      line: getLineNumber(codeOnly, match.index ?? 0),
      rule: 'forbidden-dynamic-import',
      message: `Forbidden dynamic import() in "${filePath}".`,
    });
  }

  // 4. Forbidden runtime globals/APIs in executable code (including template expressions)
  for (const identifier of FORBIDDEN_RUNTIME_IDENTIFIERS) {
    const re = new RegExp(`\\b${identifier}\\b`, 'g');
    for (const match of codeOnly.matchAll(re)) {
      errors.push({
        file: filePath,
        line: getLineNumber(codeOnly, match.index ?? 0),
        rule: 'forbidden-global',
        message: `Forbidden runtime global/API "${identifier}" in "${filePath}".`,
      });
    }
  }

  // 5. Secrets & privacy checks on raw source text as well
  const privacy = scanPrivacyAndSecrets(source, filePath);
  errors.push(...privacy.errors);
  warnings.push(...privacy.warnings);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

function stripRawPdfStreamsAndXref(rawLatin1) {
  return rawLatin1
    .replace(/stream[\r\n][\s\S]*?endstream/g, ' ')
    .replace(/xref[\r\n][\s\S]*?trailer/g, ' ');
}

function walkPluginFiles(rootDir, currentRel, errors, filesOut) {
  const currentAbs = currentRel ? path.join(rootDir, currentRel) : rootDir;
  const entries = fs.readdirSync(currentAbs).sort(comparePosixPaths);

  for (const name of entries) {
    const relPosix = currentRel ? `${currentRel}/${name}` : name;
    const absPath = path.join(currentAbs, name);
    const stat = fs.lstatSync(absPath);

    if (stat.isSymbolicLink()) {
      errors.push({
        file: relPosix,
        line: 1,
        rule: 'forbidden-symlink',
        message: `Symlink "${relPosix}" is not allowed inside a plugin directory.`,
      });
      continue;
    }

    if (name.startsWith('.')) {
      errors.push({
        file: relPosix,
        line: 1,
        rule: 'hidden-file',
        message: `Hidden file or directory "${relPosix}" is not allowed inside a plugin directory.`,
      });
      continue;
    }

    if (stat.isDirectory()) {
      if (FORBIDDEN_DIRS.has(name)) {
        errors.push({
          file: relPosix,
          line: 1,
          rule: 'forbidden-directory',
          message: `Directory "${relPosix}" is not allowed inside a plugin directory.`,
        });
        continue;
      }
      walkPluginFiles(rootDir, relPosix, errors, filesOut);
    } else if (stat.isFile()) {
      filesOut.push({ relPosix, absPath, sizeBytes: stat.size });
    }
  }
}

export async function scanPluginDirectory(pluginDir, options = {}) {
  const resolvedDir = path.resolve(pluginDir);
  const errors = [];
  const warnings = [];

  if (!fs.existsSync(resolvedDir)) {
    return {
      ok: false,
      errors: [{ file: pluginDir, line: 1, rule: 'missing-directory', message: `Plugin directory "${pluginDir}" does not exist.` }],
      warnings,
    };
  }

  const rootStat = fs.lstatSync(resolvedDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return {
      ok: false,
      errors: [{ file: pluginDir, line: 1, rule: 'invalid-directory', message: `Plugin path "${pluginDir}" must be a non-symlink directory.` }],
      warnings,
    };
  }

  const files = [];
  walkPluginFiles(resolvedDir, '', errors, files);

  if (files.length > ZIP_LIMITS.maxEntries) {
    errors.push({
      file: '.',
      line: 1,
      rule: 'too-many-files',
      message: `Plugin directory has ${files.length} files, exceeding ZIP entry limit (${ZIP_LIMITS.maxEntries}).`,
    });
  }

  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.sizeBytes;
    if (file.sizeBytes > ZIP_LIMITS.maxSingleFileBytes) {
      errors.push({
        file: file.relPosix,
        line: 1,
        rule: 'file-too-large',
        message: `File "${file.relPosix}" exceeds single-file limit (${file.sizeBytes} > ${ZIP_LIMITS.maxSingleFileBytes} bytes).`,
      });
    }
  }
  if (totalBytes > ZIP_LIMITS.maxUncompressedTotalBytes) {
    errors.push({
      file: '.',
      line: 1,
      rule: 'total-size-too-large',
      message: `Plugin directory total size exceeds uncompressed limit (${totalBytes} > ${ZIP_LIMITS.maxUncompressedTotalBytes} bytes).`,
    });
  }

  const manifestFile = files.find(f => f.relPosix === 'manifest.json');
  if (manifestFile) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile.absPath, 'utf8'));
      if (!Array.isArray(manifest.permissions) || manifest.permissions.length > 0) {
        errors.push({
          file: 'manifest.json',
          line: 1,
          rule: 'manifest-permissions',
          message: 'Plugin manifest must declare "permissions": [].',
        });
      }
      if (typeof manifest.id === 'string' && typeof manifest.version === 'string') {
        try {
          validateArchiveFileName(`${manifest.id}-${manifest.version}.zip`);
        } catch (err) {
          errors.push({
            file: 'manifest.json',
            line: 1,
            rule: 'unsafe-archive-name',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      errors.push({
        file: 'manifest.json',
        line: 1,
        rule: 'invalid-manifest-json',
        message: `Failed to parse manifest.json: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  for (const file of files) {
    const ext = path.extname(file.relPosix).toLowerCase();
    const isUnderTestDir = file.relPosix === 'test' || file.relPosix.startsWith('test/');

    if (CODE_EXTENSIONS.has(ext) && !isUnderTestDir) {
      const source = fs.readFileSync(file.absPath, 'utf8');
      const codeResult = scanSourceText(source, file.relPosix);
      errors.push(...codeResult.errors);
      warnings.push(...codeResult.warnings);
      continue;
    }

    if (ext === '.pdf') {
      const bytes = fs.readFileSync(file.absPath);
      const rawStripped = stripRawPdfStreamsAndXref(bytes.toString('latin1'));
      const rawFindings = scanPrivacyAndSecrets(rawStripped, file.relPosix);
      errors.push(...rawFindings.errors);
      warnings.push(...rawFindings.warnings);

      if (options.scanPdfText !== false) {
        try {
          const pdfDoc = await extractPdfDocument(bytes);
          const extractedText = pdfDoc.pages.map(p => p.text).join('\n');
          const pdfFindings = scanPrivacyAndSecrets(extractedText, file.relPosix);
          errors.push(...pdfFindings.errors);
          warnings.push(...pdfFindings.warnings);
        } catch (err) {
          warnings.push({
            file: file.relPosix,
            line: 1,
            rule: 'pdf-scan-fallback',
            message: `Could not extract PDF text for privacy scan (${err instanceof Error ? err.message : String(err)}).`,
          });
        }
      }
      continue;
    }

    if (TEXT_EXTENSIONS.has(ext) || isUnderTestDir) {
      const buf = fs.readFileSync(file.absPath);
      if (buf.includes(0)) continue;
      const text = buf.toString('utf8');
      const privacy = scanPrivacyAndSecrets(text, file.relPosix);
      errors.push(...privacy.errors);
      warnings.push(...privacy.warnings);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}
