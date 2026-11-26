const PLUGIN_ID = 'pt-bankinter';
const INSTITUTION_ID = 'bankinter';

const HEADER_KEYWORDS = ['data movimento', 'data valor', 'descrição', 'montante', 'saldo'];
const MARGIN_TO_IGNORE = 0;
const HEADER_REGEX = /data\s+movimento.*data\s+valor.*descriç[ãa]o.*transação.*montante.*moeda.*saldo.*taxa\s+c[âa]mbio/i;
const FOOTER_REGEX = /\bconforme\b/i;

function isNumericToken(text) {
  return /^[\d.,\s-]+$/.test(text);
}

function columnsConfig(words) {
  const columns = {
    date1: [0, 60],
    date2: [68, 108],
    description: [108, 304], // end = Transação start - 1
    credit: [347, 391], // start = Montante start - 1, end = Moeda start - 1
    debit: [467, 521], // start = Taxa start - 1
    balance: [420, 467], // start = Saldo start - 1, end = Taxa start
  };

  for (const word of words) {
    const text = word.text;
    const x = Math.floor(word.x);
    const x1 = Math.floor(word.x + word.width);

    if (text === 'Movimento') {
      columns.date1[1] = x1;
    } else if (text.toLowerCase().startsWith('descri')) {
      columns.description[0] = x;
    } else if (text === 'Transação') {
      columns.description[1] = x - 1;
    } else if (text === 'Montante') {
      columns.credit = [x - 1, x1];
    } else if (text === 'Moeda') {
      columns.credit[1] = x - 1;
    } else if (text === 'Saldo') {
      columns.balance = [x - 1, x1];
    } else if (text === 'Taxa' && x < 500) {
      columns.debit[0] = x - 1;
      columns.balance[1] = x;
    } else if (text === 'Câmbio' && x < 500) {
      columns.debit[1] = x1 + 1;
    }
  }

  return columns;
}

function extractDataFromRow(rowWords, columns) {
  let date = '';
  let description = '';
  let value = '';
  let balance = '';
  let currency = '';
  let valueMontante = '';
  let valueTaxaCambio = '';

  for (const word of rowWords) {
    const x = word.x;
    const text = word.text;

    if (x >= columns.date1[0] && x < columns.date1[1]) {
      date = text.replace(/-/g, '/');
    } else if (x >= columns.date2[1] && x < columns.description[1]) {
      const clean = text
        .replace(/[",;\r\n\t]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (clean) {
        description += (description ? ' ' : '') + clean;
      }
    } else if (x >= columns.credit[0] && x < columns.credit[1]) {
      if (isNumericToken(text) && text !== '-') {
        valueMontante += text.replace(/\./g, '');
      }
    } else if (x >= columns.credit[1] && x < columns.balance[0]) {
      const code = text.trim();
      if (/^[A-Za-z]{3}$/.test(code)) {
        currency = code.toUpperCase();
      }
    } else if (x >= columns.debit[0] && x < columns.debit[1]) {
      if (isNumericToken(text) && text !== '-') {
        valueTaxaCambio += text.replace(/\./g, '');
      }
    } else if (x >= columns.balance[0] && x < columns.balance[1]) {
      if (isNumericToken(text)) {
        balance += text.replace(/\./g, '');
      }
    }
  }

  if (valueMontante) {
    value = valueMontante;
  } else if (valueTaxaCambio) {
    value = `-${valueTaxaCambio}`;
  }

  const trimmedBalance = balance.trim();
  return {
    date,
    description,
    value,
    balance: trimmedBalance,
    currency,
    rawAmount: value,
    ...(trimmedBalance ? { runningBalance: trimmedBalance } : {}),
  };
}

function hasStatementFooter(pdfDoc) {
  let collecting = false;
  for (const page of pdfDoc.pages) {
    const pageText = typeof page.text === 'string'
      ? page.text
      : (Array.isArray(page.words) ? page.words.map(w => w.text).join(' ') : '');
    if (!collecting && HEADER_REGEX.test(pageText)) {
      collecting = true;
    }
    if (collecting && FOOTER_REGEX.test(pageText)) {
      return true;
    }
  }
  return false;
}

function parseBankInterTable(input, sdk) {
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
    isValid: transactions => transactions.length > 0,
  });
}

export default {
  detect(input, sdk) {
    if (input.format !== 'pdf' || !input.pdf) {
      return {
        matched: false,
        confidence: 0,
        reason: 'BankInter importer only supports PDF statements.',
      };
    }

    try {
      const parsed = parseBankInterTable(input, sdk);
      const hasFooter = hasStatementFooter(input.pdf);
      return {
        matched: true,
        confidence: hasFooter ? 0.98 : 0.92,
        format: 'pdf',
        institutionId: INSTITUTION_ID,
        reason: `Matched BankInter PDF statement (${parsed.transactions.length} transaction(s)).`,
        metadata: {
          transactionCount: parsed.transactions.length,
          hasFooter,
        },
      };
    } catch (error) {
      return {
        matched: false,
        confidence: 0,
        reason: error instanceof Error ? error.message : 'PDF does not match BankInter statement layout.',
      };
    }
  },

  parse(input, sdk) {
    if (input.format !== 'pdf' || !input.pdf) {
      throw new sdk.ImporterError(
        sdk.ERROR_CODES.UNSUPPORTED_FORMAT,
        `BankInter importer expects PDF input, received "${input.format}".`,
      );
    }

    const parsed = parseBankInterTable(input, sdk);
    return {
      pluginApiVersion: '1',
      pluginId: PLUGIN_ID,
      institutionId: INSTITUTION_ID,
      transactions: parsed.transactions,
      diagnostics: parsed.diagnostics,
    };
  },
};
