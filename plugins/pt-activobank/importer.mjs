const PLUGIN_ID = 'pt-activobank';
const INSTITUTION_ID = 'activobank';

const HEADER_KEYWORDS = ['lanc.', 'valor', 'descritivo', 'debito', 'credito', 'saldo'];
const MARGIN_TO_IGNORE = 50;
const HEADER_REGEX = /data\s+lanc\.?\s+data\s+valor.*descritivo.*debito.*credito.*saldo/i;
const FOOTER_REGEX = /\bsaldo final\b/i;
const CLOSING_HEADER_REGEX = /\b(\d{2})\/(\d{2})\/(\d{2})\s+EXT\.\s*N\.\s*(\d{4})\/\d+\b/i;

function isNumber(text) {
  return /^[\d.,\s]+$/.test(text);
}

function columnsConfig(words) {
  const columns = {
    date1: [50, 110],
    date2: [0, 0],
    description: [110, 350],
    debit: [350, 420],
    credit: [420, 518],
    balance: [518, 600],
  };

  for (const word of words) {
    const text = word.text.toLowerCase();
    const wordX = Math.floor(word.x);
    if (text === 'lanc.') {
      columns.date1 = [wordX, word.x + word.width];
    } else if (text === 'valor') {
      columns.date2 = [wordX, word.x + word.width];
    } else if (text === 'descritivo') {
      columns.description[0] = wordX;
    } else if (text === 'debito') {
      const endOf = word.x + word.width;
      const startOf = Math.floor(endOf - 55);
      columns.debit = [startOf, endOf];
      columns.description[1] = startOf;
    } else if (text === 'credito') {
      columns.credit = [wordX, word.x + word.width];
    } else if (text === 'saldo') {
      columns.balance = [wordX, word.x + word.width];
    }
  }

  return columns;
}

function extractDataFromRow(rowWords, columns) {
  let date = '';
  let description = '';
  let value = '';
  let balance = '';
  let debit = '';
  let credit = '';
  let yearInferred = false;

  for (const word of rowWords) {
    const x = word.x;
    const text = word.text;

    if (x >= columns.date1[0] && x < columns.date1[1]) {
      date += text.split(/\s+/)[0];
      if (/^\d{1,2}\.\d{1,2}(?:\s|$)/.test(text)) {
        yearInferred = true;
      }
    } else if (x >= columns.date2[1] && x < columns.description[1]) {
      const clean = text
        .replace(/[",;\r\n\t]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (clean) {
        description += (description ? ' ' : '') + clean;
      }
    } else if (x >= columns.debit[0] && x < columns.debit[1]) {
      if (isNumber(text)) {
        debit += text;
      }
    } else if (x >= columns.debit[1] && x < columns.credit[1]) {
      if (isNumber(text)) {
        credit += text;
      }
    } else if (x >= columns.credit[1] && x < columns.balance[1]) {
      if (isNumber(text)) {
        balance += text;
      }
    }
  }

  if (credit) {
    value = credit;
  } else if (debit) {
    value = `-${debit}`;
  }

  const trimmedBalance = balance.trim();
  return {
    date,
    description,
    value,
    balance: trimmedBalance,
    rawAmount: value,
    ...(trimmedBalance ? { runningBalance: trimmedBalance } : {}),
    ...(yearInferred ? { yearInferred: true } : {}),
  };
}

function extractClosingDate(statementText, sdk) {
  const closing = statementText.match(CLOSING_HEADER_REGEX);
  if (!closing) return undefined;

  const year = Number(closing[4]);
  const month = Number(closing[2]);
  const day = Number(closing[3]);
  if (!closing[4].endsWith(closing[1])) return undefined;
  if (!sdk.dates.isValidYmd(year, month, day)) return undefined;

  return { year, month };
}

function resolveFallbackYear(input) {
  const rawRef = input?.options?.referenceYear;
  if (typeof rawRef === 'number' && Number.isInteger(rawRef) && rawRef >= 1900 && rawRef <= 2100) {
    return rawRef;
  }
  if (typeof rawRef === 'string' && /^\d{4}$/.test(rawRef.trim())) {
    const parsed = Number(rawRef.trim());
    if (parsed >= 1900 && parsed <= 2100) {
      return parsed;
    }
  }
  return new Date().getUTCFullYear();
}

function buildDateNormalizer(sdk, fallbackYear) {
  return (statementText) => {
    const closingDate = extractClosingDate(statementText, sdk);
    return (date) => {
      const match = date.match(/^(\d{1,2})\.(\d{1,2})$/);
      if (!match) return date;
      const [, month, day] = match;
      // December postings can appear on a statement closing in January of the following year.
      const year = closingDate
        ? closingDate.year - Number(Number(month) > closingDate.month)
        : fallbackYear;
      return `${day.padStart(2, '0')}/${month.padStart(2, '0')}/${year}`;
    };
  };
}

function parseActivoBankTable(input, sdk) {
  const fallbackYear = resolveFallbackYear(input);
  return sdk.pdf.parsePositionedTable(input.pdf, {
    headerKeywords: HEADER_KEYWORDS,
    headerRegex: HEADER_REGEX,
    footerRegex: FOOTER_REGEX,
    marginToIgnore: MARGIN_TO_IGNORE,
    decimalFormat: 'pt',
    requireBalance: true,
    columnsConfig,
    extractDataFromRow,
    isEndOfPage: row => row.description.includes('A TRANSPORTAR'),
    dateNormalizer: buildDateNormalizer(sdk, fallbackYear),
    isValid: transactions => transactions.length > 0,
  });
}

export default {
  detect(input, sdk) {
    if (input.format !== 'pdf' || !input.pdf) {
      return {
        matched: false,
        confidence: 0,
        reason: 'ActivoBank importer only supports PDF statements.',
      };
    }

    try {
      const parsed = parseActivoBankTable(input, sdk);
      const hasClosingHeader = CLOSING_HEADER_REGEX.test(parsed.statementText);
      return {
        matched: true,
        confidence: hasClosingHeader ? 0.98 : 0.92,
        format: 'pdf',
        institutionId: INSTITUTION_ID,
        reason: `Matched ActivoBank PDF statement (${parsed.transactions.length} transaction(s)).`,
        metadata: {
          transactionCount: parsed.transactions.length,
          hasClosingHeader,
        },
      };
    } catch (error) {
      return {
        matched: false,
        confidence: 0,
        reason: error instanceof Error ? error.message : 'PDF does not match ActivoBank statement layout.',
      };
    }
  },

  parse(input, sdk) {
    if (input.format !== 'pdf' || !input.pdf) {
      throw new sdk.ImporterError(
        sdk.ERROR_CODES.UNSUPPORTED_FORMAT,
        `ActivoBank importer expects PDF input, received "${input.format}".`,
      );
    }

    const parsed = parseActivoBankTable(input, sdk);
    return {
      pluginApiVersion: '1',
      pluginId: PLUGIN_ID,
      institutionId: INSTITUTION_ID,
      transactions: parsed.transactions,
      diagnostics: parsed.diagnostics,
    };
  },
};
