/**
 * Personal Ledger Plugin SDK v1 (pure ESM, zero Node/host/FS/network imports).
 * Safe for isolated execution inside QuickJS, Wasm, or worker sandboxes.
 */

export const PLUGIN_API_VERSION = '1';

export const ERROR_CODES = Object.freeze({
  EMPTY_INPUT: 'EMPTY_INPUT',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
  HEADER_NOT_FOUND: 'HEADER_NOT_FOUND',
  UNRECOGNIZED_STATEMENT: 'UNRECOGNIZED_STATEMENT',
  NO_TRANSACTIONS: 'NO_TRANSACTIONS',
  PDF_EXTRACTION_FAILED: 'PDF_EXTRACTION_FAILED',
  INVALID_STATEMENT: 'INVALID_STATEMENT',
});

export class ImporterError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ImporterError';
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isValidYmd(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  if (year < 1900 || year > 2100 || month < 1 || month > 12) {
    return false;
  }
  const maxDay = DAYS_IN_MONTH[month] + (month === 2 && isLeapYear(year) ? 1 : 0);
  return day >= 1 && day <= maxDay;
}

export function toIsoDate(year, month, day) {
  if (!isValidYmd(year, month, day)) {
    return null;
  }
  const yyyy = String(year).padStart(4, '0');
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function isValidIsoDate(str) {
  if (typeof str !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (!match) return false;
  return isValidYmd(Number(match[1]), Number(match[2]), Number(match[3]));
}

export function isValidDisplayDate(str, sep = '/') {
  if (typeof str !== 'string') return false;
  const re = new RegExp(`^(\\d{2})${escapeRegExp(sep)}(\\d{2})${escapeRegExp(sep)}(\\d{4})$`);
  const match = re.exec(str);
  if (!match) return false;
  return isValidYmd(Number(match[3]), Number(match[2]), Number(match[1]));
}

export function parseDisplayDate(ddmmyyyy, sep = '/') {
  if (typeof ddmmyyyy !== 'string') return null;
  const trimmed = ddmmyyyy.trim();
  const re = new RegExp(`^(\\d{2})${escapeRegExp(sep)}(\\d{2})${escapeRegExp(sep)}(\\d{4})$`);
  const match = re.exec(trimmed);
  if (!match) return null;
  return toIsoDate(Number(match[3]), Number(match[2]), Number(match[1]));
}

export function parseIsoDatePrefix(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/.exec(trimmed);
  if (!match) return null;
  return toIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

export function isoToDisplayDate(iso) {
  if (!isValidIsoDate(iso)) {
    throw new ImporterError(ERROR_CODES.INVALID_STATEMENT, `Invalid ISO calendar date: "${iso}"`);
  }
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
}

export function formatUtcTimestampToDisplay(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(.*)$/.exec(trimmed);
  if (!match) return trimmed;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const rest = match[4];
  if (!isValidYmd(year, month, day) || (rest !== '' && !/^[\sT]/.test(rest))) {
    return trimmed;
  }
  return `${match[3]}/${match[2]}/${match[1]}${rest}`;
}

export const dates = Object.freeze({
  isValidYmd,
  isValidIsoDate,
  isValidDisplayDate,
  toIsoDate,
  parseDisplayDate,
  parseIsoDatePrefix,
  isoToDisplayDate,
  formatUtcTimestampToDisplay,
});

export function normalizePortugueseDecimal(raw) {
  if (typeof raw !== 'string') return null;
  let value = raw.replace(/[^0-9.,\-]/g, '');
  if (!value) return null;
  value = value.replace(/\./g, '').replace(',', '.');
  return /^-?\d+(?:\.\d+)?$/.test(value) ? value : null;
}

export function normalizeDecimal(raw, options = {}) {
  if (typeof raw !== 'string') return null;
  const sep = options?.decimalSeparator ?? 'auto';
  if (sep === ',') {
    return normalizePortugueseDecimal(raw);
  }
  let value = raw.replace(/[^0-9.,\-]/g, '');
  if (!value) return null;

  if (sep === '.') {
    value = value.replace(/,/g, '');
    return /^-?\d+(?:\.\d+)?$/.test(value) ? value : null;
  }

  const hasComma = value.includes(',');
  const hasDot = value.includes('.');
  if (hasComma && hasDot) {
    if (value.lastIndexOf(',') > value.lastIndexOf('.')) {
      value = value.replace(/\./g, '').replace(',', '.');
    } else {
      value = value.replace(/,/g, '');
    }
  } else if (hasComma) {
    value = value.replace(',', '.');
  }

  return /^-?\d+(?:\.\d+)?$/.test(value) ? value : null;
}

export function withSign(decimal, sign) {
  if (typeof decimal !== 'string') return '';
  const unsigned = decimal.trim().replace(/^[+-]/, '');
  if (!unsigned || /^0+(?:[.,]0+)?$/.test(unsigned)) {
    return unsigned;
  }
  return sign === 'negative' ? `-${unsigned}` : unsigned;
}

export const money = Object.freeze({
  normalizeDecimal,
  normalizePortugueseDecimal,
  withSign,
});

function toUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  throw new ImporterError(ERROR_CODES.INVALID_STATEMENT, 'Expected byte input as Uint8Array or ArrayBuffer.');
}

function decodeUtf8StrictFallback(bytes) {
  let result = '';
  let i = 0;
  while (i < bytes.length) {
    const b1 = bytes[i++];
    if (b1 <= 0x7f) {
      result += String.fromCharCode(b1);
      continue;
    }
    if (b1 >= 0xc2 && b1 <= 0xdf) {
      if (i >= bytes.length) throw new Error('Truncated UTF-8 sequence');
      const b2 = bytes[i++];
      if ((b2 & 0xc0) !== 0x80) throw new Error('Invalid UTF-8 continuation byte');
      result += String.fromCharCode(((b1 & 0x1f) << 6) | (b2 & 0x3f));
      continue;
    }
    if (b1 >= 0xe0 && b1 <= 0xef) {
      if (i + 1 >= bytes.length) throw new Error('Truncated UTF-8 sequence');
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      if ((b2 & 0xc0) !== 0x80 || (b3 & 0xc0) !== 0x80) throw new Error('Invalid UTF-8 continuation byte');
      if (b1 === 0xe0 && b2 < 0xa0) throw new Error('Overlong UTF-8');
      if (b1 === 0xed && b2 >= 0xa0) throw new Error('UTF-8 surrogate code point');
      const cp = ((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      result += String.fromCharCode(cp);
      continue;
    }
    if (b1 >= 0xf0 && b1 <= 0xf4) {
      if (i + 2 >= bytes.length) throw new Error('Truncated UTF-8 sequence');
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      const b4 = bytes[i++];
      if ((b2 & 0xc0) !== 0x80 || (b3 & 0xc0) !== 0x80 || (b4 & 0xc0) !== 0x80) {
        throw new Error('Invalid UTF-8 continuation byte');
      }
      const cp = ((b1 & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f);
      if (cp < 0x10000 || cp > 0x10ffff) throw new Error('Invalid UTF-8 code point');
      result += String.fromCodePoint(cp);
      continue;
    }
    throw new Error('Invalid UTF-8 start byte');
  }
  return result;
}

function decodeUtf8Fatal(bytes) {
  if (typeof TextDecoder === 'function') {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  return decodeUtf8StrictFallback(bytes);
}

function decodeLatin1(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return out;
}

function encodeLatin1Strict(text) {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) {
      throw new Error('Character outside Latin-1 range');
    }
    bytes[i] = code;
  }
  return bytes;
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function decodeBytes(inputBytes) {
  const bytes = toUint8Array(inputBytes);
  let text;
  try {
    text = decodeUtf8Fatal(bytes);
  } catch {
    return stripBom(decodeLatin1(bytes));
  }

  // Repair double-encoded UTF-8 mojibake (e.g. "DescriÃ§Ã£o" -> "Descrição")
  if (/[\u00C0-\u00FF][\u0080-\u00BF]/.test(text)) {
    try {
      const fixed = decodeUtf8Fatal(encodeLatin1Strict(text));
      return stripBom(fixed);
    } catch {
      // Keep original decoded UTF-8 when re-decoding fails
    }
  }

  return stripBom(text);
}

export function detectDelimiter(text, candidates = [',', ';', '\t']) {
  const clean = stripBom(String(text ?? ''));
  const counts = new Map(candidates.map(d => [d, 0]));
  let quoted = false;
  let nonblank = false;

  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    if (char === '"') {
      if (quoted && clean[i + 1] === '"') {
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && (char === '\r' || char === '\n')) {
      if (nonblank) break;
      for (const candidate of counts.keys()) counts.set(candidate, 0);
    } else if (!quoted && counts.has(char)) {
      counts.set(char, counts.get(char) + 1);
    }
    if (char.trim()) nonblank = true;
  }

  let best = candidates[0] ?? ',';
  let bestCount = -1;
  for (const [candidate, count] of counts.entries()) {
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

export function parseRows(rawText, options = {}) {
  const text = stripBom(String(rawText ?? ''));
  if (!text) return [];

  const delimiter = !options?.delimiter || options.delimiter === 'auto'
    ? detectDelimiter(text)
    : options.delimiter;
  const skipEmptyRows = options?.skipEmptyRows !== false;

  const rows = [];
  let index = 0;
  let line = 1;

  while (index < text.length) {
    const recordLine = line;
    const row = [];
    while (true) {
      let value = '';
      if (text[index] === '"') {
        index++;
        let closed = false;
        while (index < text.length) {
          const char = text[index++];
          if (char === '"') {
            if (text[index] === '"') {
              value += '"';
              index++;
            } else {
              closed = true;
              break;
            }
          } else {
            value += char;
            if (char === '\n' || (char === '\r' && text[index] !== '\n')) {
              line++;
            }
          }
        }
        if (!closed) {
          throw new ImporterError(ERROR_CODES.INVALID_STATEMENT, `Unclosed CSV quote at line ${recordLine}.`, { line: recordLine });
        }
        while (text[index] === ' ') index++;
        if (index < text.length && text[index] !== delimiter && text[index] !== '\r' && text[index] !== '\n') {
          throw new ImporterError(
            ERROR_CODES.INVALID_STATEMENT,
            `Unexpected text after a quoted CSV field at line ${recordLine}.`,
            { line: recordLine },
          );
        }
      } else {
        while (index < text.length && text[index] !== delimiter && text[index] !== '\r' && text[index] !== '\n') {
          if (text[index] === '"') {
            throw new ImporterError(
              ERROR_CODES.INVALID_STATEMENT,
              `Quote inside an unquoted CSV field at line ${recordLine}.`,
              { line: recordLine },
            );
          }
          value += text[index++];
        }
      }
      row.push(value);
      if (text[index] === delimiter) {
        index++;
        continue;
      }
      if (text[index] === '\r' && text[index + 1] === '\n') index++;
      if (text[index] === '\r' || text[index] === '\n') {
        index++;
        line++;
      }
      break;
    }
    rows.push(row);
  }

  return skipEmptyRows ? rows.filter(r => r.some(cell => cell.trim() !== '')) : rows;
}

export function normalizeHeader(cell) {
  return String(cell ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export const csv = Object.freeze({
  decodeBytes,
  detectDelimiter,
  parseRows,
  normalizeHeader,
});

function statelessRegex(regex) {
  if (!(regex instanceof RegExp)) return regex;
  if (!regex.global && !regex.sticky) return regex;
  return new RegExp(regex.source, regex.flags.replace(/[gy]/g, ''));
}

export function extractTableWords(pdfDoc, { headerRegex, footerRegex } = {}) {
  if (!pdfDoc || !Array.isArray(pdfDoc.pages)) {
    throw new ImporterError(ERROR_CODES.PDF_EXTRACTION_FAILED, 'Missing extracted PDF document pages.');
  }
  const safeHeader = statelessRegex(headerRegex);
  const safeFooter = footerRegex ? statelessRegex(footerRegex) : null;

  let collecting = false;
  const collectedWords = [];
  const statementPages = [];

  for (const page of pdfDoc.pages) {
    const words = Array.isArray(page.words) ? page.words : [];
    const pageText = typeof page.text === 'string'
      ? page.text
      : words.map(w => w.text).join(' ');

    if (!collecting) {
      const tableStart = safeHeader ? pageText.search(safeHeader) : 0;
      statementPages.push(tableStart === -1 ? pageText : pageText.slice(0, tableStart));
      collecting = tableStart !== -1;
    }

    if (collecting) {
      collectedWords.push(...words);
    }

    if (collecting && safeFooter && safeFooter.test(pageText)) {
      break;
    }
  }

  if (collectedWords.length === 0) {
    throw new ImporterError(ERROR_CODES.HEADER_NOT_FOUND, 'Transaction table not found in PDF.');
  }

  return {
    words: collectedWords,
    statementText: statementPages.join(' '),
  };
}

export function groupRows(words, { marginToIgnore = 0, tolerance = 4, pageOffset = 1000 } = {}) {
  const rows = new Map();

  for (const word of words) {
    if (word.x < marginToIgnore) continue;

    const groupY = word.y + (word.page - 1) * pageOffset;
    let foundKey = null;

    for (const key of rows.keys()) {
      if (Math.abs(key - groupY) <= tolerance) {
        foundKey = key;
        break;
      }
    }

    if (foundKey === null) {
      rows.set(groupY, [word]);
    } else {
      rows.get(foundKey).push(word);
    }
  }

  return rows;
}

export function parsePositionedTable(pdfDoc, config) {
  const { words, statementText } = extractTableWords(pdfDoc, {
    headerRegex: config.headerRegex,
    footerRegex: config.footerRegex,
  });

  const rows = groupRows(words, {
    marginToIgnore: config.marginToIgnore ?? 0,
    tolerance: config.tolerance ?? 4,
    pageOffset: config.pageOffset ?? 1000,
  });

  const normalizeDate = typeof config.dateNormalizer === 'function'
    ? config.dateNormalizer(statementText)
    : (date => date);

  const decimalNormalizer = typeof config.normalizeAmount === 'function'
    ? config.normalizeAmount
    : config.decimalFormat === 'pt'
      ? normalizePortugueseDecimal
      : normalizeDecimal;

  const requireBalance = config.requireBalance !== false;
  const dateSeparator = config.dateSeparator ?? '/';

  let columns = null;
  let rowNumber = 0;
  const transactions = [];
  const diagnostics = [];

  for (const groupWords of rows.values()) {
    rowNumber++;
    const rowWords = [...groupWords].sort((a, b) => a.x - b.x);
    const page = rowWords[0].page;
    const locator = `Page ${page}, row ${rowNumber}`;

    if (!columns) {
      const rowText = rowWords.map(w => w.text.toLowerCase()).join(' ');
      let matchedKeywords = 0;
      for (const keyword of config.headerKeywords) {
        if (rowText.includes(keyword)) matchedKeywords++;
      }
      if (matchedKeywords === config.headerKeywords.length) {
        columns = config.columnsConfig(rowWords);
      }
      continue;
    }

    const row = config.extractDataFromRow(rowWords, columns);

    if (typeof config.isEndOfPage === 'function' && config.isEndOfPage(row, rowWords)) {
      columns = null;
      continue;
    }

    const rawDateFromColumn = columns.date1
      ? rowWords.filter(word => word.x >= columns.date1[0] && word.x < columns.date1[1]).map(word => word.text).join(' ')
      : '';
    const rawDate = typeof row.rawDate === 'string'
      ? row.rawDate
      : rawDateFromColumn || String(row.date ?? '').trim();

    const dateResult = normalizeDate(String(row.date ?? '').trim(), row, statementText);
    const normalizedDateStr = typeof dateResult === 'string' ? dateResult : String(dateResult?.date ?? '');
    const yearInferred = typeof dateResult === 'object' && dateResult !== null && 'yearInferred' in dateResult
      ? Boolean(dateResult.yearInferred)
      : row.yearInferred === true;

    let isoDate = isValidIsoDate(normalizedDateStr)
      ? normalizedDateStr
      : parseDisplayDate(normalizedDateStr, dateSeparator);
    if (!isoDate && dateSeparator !== '/') {
      isoDate = parseDisplayDate(normalizedDateStr, '/');
    }

    const description = String(row.description ?? '').trim();
    const rawAmount = String(row.rawAmount ?? row.value ?? '').trim();
    const rawBalance = String(row.balance ?? '').trim();
    const normalizedBalance = rawBalance !== '' ? decimalNormalizer(rawBalance) : null;
    const balanceInvalid = requireBalance
      ? (!rawBalance || normalizedBalance === null)
      : (rawBalance !== '' && normalizedBalance === null);

    if (!isoDate || !description || balanceInvalid) {
      if (String(row.date ?? '').trim()) {
        diagnostics.push({
          locator,
          reason: 'Invalid date, description, or running balance',
          ...(normalizedDateStr.trim() ? { date: normalizedDateStr.trim() } : {}),
          ...(rawDate ? { rawDate } : {}),
          ...(description ? { description } : {}),
          ...(rawAmount ? { value: rawAmount } : {}),
        });
      }
      continue;
    }

    const normalizedAmount = rawAmount !== '' ? decimalNormalizer(String(row.value ?? '').trim()) : null;
    if (normalizedAmount === null) {
      diagnostics.push({
        locator,
        reason: 'Invalid or missing amount',
        ...(normalizedDateStr.trim() ? { date: normalizedDateStr.trim() } : {}),
        ...(rawDate ? { rawDate } : {}),
        description,
        ...(rawAmount ? { value: rawAmount } : {}),
      });
      continue;
    }

    const tx = {
      date: isoDate,
      description,
      amount: normalizedAmount,
      currency: String(row.currency ?? '').trim().toUpperCase(),
      ...(normalizedBalance !== null ? { balance: normalizedBalance } : {}),
      ...(row.sourceId ? { sourceId: String(row.sourceId).trim() } : {}),
      ...(row.accountReference ? { accountReference: String(row.accountReference).trim() } : {}),
      evidence: {
        row: rowNumber,
        page,
        locator,
        ...(rawDate ? { rawDate } : {}),
        ...(rawAmount ? { rawAmount } : {}),
        ...(rawBalance ? { runningBalance: normalizedBalance ?? rawBalance } : {}),
        ...(yearInferred ? { yearInferred: true } : {}),
        ...(row.action ? { action: String(row.action) } : {}),
      },
    };
    transactions.push(tx);
  }

  if (transactions.length === 0 || (typeof config.isValid === 'function' && !config.isValid(transactions, { statementText, diagnostics }))) {
    throw new ImporterError(ERROR_CODES.NO_TRANSACTIONS, 'No valid transactions parsed from PDF.');
  }

  return {
    transactions,
    diagnostics,
    statementText,
  };
}

export const pdf = Object.freeze({
  extractTableWords,
  groupRows,
  parsePositionedTable,
});

export function resolveOption(input, manifestOptionId, fallback) {
  const opts = input?.options;
  if (opts && Object.prototype.hasOwnProperty.call(opts, manifestOptionId) && opts[manifestOptionId] !== undefined) {
    return opts[manifestOptionId];
  }
  return fallback;
}

export function isStatementOnlyMode(input) {
  const opts = input?.options;
  if (opts && typeof opts.statementOnly === 'boolean') {
    return opts.statementOnly;
  }
  if (opts && typeof opts.includeAllActivity === 'boolean') {
    return !opts.includeAllActivity;
  }
  return false;
}

export const options = Object.freeze({
  resolveOption,
  isStatementOnlyMode,
});

export function createImporterSdk() {
  return Object.freeze({
    apiVersion: PLUGIN_API_VERSION,
    ERROR_CODES,
    ImporterError,
    dates,
    money,
    csv,
    pdf,
    options,
  });
}
