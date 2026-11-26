const PLUGIN_ID = 'eu-revolut';
const INSTITUTION_ID = 'revolut';

const DEFAULT_COLUMNS = Object.freeze({
  product: 1, // Produto / Product
  completedDate: 3, // Data de conclusão / Completed Date
  description: 4, // Descrição / Description
  amount: 5, // Montante / Amount
});

const HEADER_ALIASES = Object.freeze({
  product: ['produto', 'product'],
  completedDate: ['data de conclus', 'completed date'],
  description: ['descricao', 'description'],
  amount: ['montante', 'amount'],
  currency: ['currency (total)', 'currency', 'moeda'],
  id: ['id', 'transaction id'],
  balance: ['balance', 'saldo'],
});

const CURRENT_PRODUCTS = new Set(['atual', 'current']);
const ISO_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})(?:[T\s].*)?$/;
const CURRENCY_CODE_RE = /^[A-Z]{3}$/;

function readCell(row, index) {
  return index >= 0 && index < row.length ? row[index] : '';
}

function decodeInputText(input, sdk) {
  if (input.bytes !== undefined && input.bytes !== null) {
    try {
      return sdk.csv.decodeBytes(input.bytes);
    } catch (error) {
      if (typeof input.text === 'string') {
        return input.text;
      }
      throw error;
    }
  }
  if (typeof input.text === 'string') {
    return input.text;
  }
  throw new sdk.ImporterError(sdk.ERROR_CODES.EMPTY_INPUT, 'Revolut CSV file is empty');
}

function resolveOptionalColumns(headerRow, sdk) {
  const normalized = headerRow.map(cell => sdk.csv.normalizeHeader(cell));
  return {
    currency: normalized.findIndex(cell => HEADER_ALIASES.currency.includes(cell)),
    id: normalized.findIndex(cell => HEADER_ALIASES.id.includes(cell)),
    balance: normalized.findIndex(cell => HEADER_ALIASES.balance.includes(cell)),
  };
}

function resolveColumns(rows, sdk) {
  const scanLimit = Math.min(rows.length, 10);
  for (let i = 0; i < scanLimit; i++) {
    const normalized = rows[i].map(cell => sdk.csv.normalizeHeader(cell));
    const product = normalized.findIndex(cell => HEADER_ALIASES.product.includes(cell));
    const completedDate = normalized.findIndex(cell =>
      HEADER_ALIASES.completedDate.some(prefix => cell.startsWith(prefix)),
    );
    const description = normalized.findIndex(cell => HEADER_ALIASES.description.includes(cell));
    const amount = normalized.findIndex(cell => HEADER_ALIASES.amount.includes(cell));

    if (product !== -1 && completedDate !== -1 && description !== -1 && amount !== -1) {
      return {
        headerIndex: i,
        headerMatched: true,
        columns: {
          product,
          completedDate,
          description,
          amount,
          ...resolveOptionalColumns(rows[i], sdk),
        },
      };
    }
  }

  return {
    headerIndex: 0,
    headerMatched: false,
    columns: {
      ...DEFAULT_COLUMNS,
      ...resolveOptionalColumns(rows[0], sdk),
    },
  };
}

function readStatement(text, sdk) {
  const preferred = sdk.csv.detectDelimiter(text);
  const alternatives = [',', ';', '\t'].filter(delimiter => delimiter !== preferred);
  let fallback;
  let preferredError;

  for (const delimiter of [preferred, ...alternatives]) {
    let rows;
    try {
      rows = sdk.csv.parseRows(text, { delimiter });
    } catch (error) {
      if (!(error instanceof sdk.ImporterError)) throw error;
      if (delimiter === preferred) preferredError = error;
      continue;
    }
    if (rows.length === 0) return null;
    const layout = resolveColumns(rows, sdk);
    if (layout.headerMatched) return { rows, ...layout };
    if (delimiter === preferred) fallback = { rows, ...layout };
  }

  if (preferredError) throw preferredError;
  return fallback;
}

function extractDiagnosticDate(rawDate, parsedIso) {
  if (parsedIso) return parsedIso;
  if (!rawDate) return undefined;
  const match = ISO_PREFIX_RE.exec(rawDate);
  return match ? match[1] : rawDate;
}

function buildDiagnostic({ locator, code, severity, reason, date, rawDate, description, value }) {
  return {
    locator,
    code,
    severity,
    reason,
    ...(date ? { date } : {}),
    ...(rawDate ? { rawDate } : {}),
    ...(description ? { description } : {}),
    ...(value ? { value } : {}),
  };
}

function parseRevolutStatement(input, sdk) {
  if (input.format !== 'csv') {
    throw new sdk.ImporterError(
      sdk.ERROR_CODES.UNSUPPORTED_FORMAT,
      `Revolut importer expects CSV input, received "${input.format}".`,
    );
  }

  const text = decodeInputText(input, sdk);
  const statement = readStatement(text, sdk);
  if (!statement) {
    throw new sdk.ImporterError(sdk.ERROR_CODES.EMPTY_INPUT, 'Revolut CSV file is empty');
  }

  const { rows, headerIndex, headerMatched, columns } = statement;
  const transactions = [];
  const diagnostics = [];

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    const rowNumber = i + 1;
    const locator = `Record ${rowNumber}`;

    const product = readCell(row, columns.product).trim().toLowerCase();
    const rawDateCell = readCell(row, columns.completedDate);
    const rawDate = rawDateCell.trim();
    const parsedIso = sdk.dates.parseIsoDatePrefix(rawDate);
    const diagDate = extractDiagnosticDate(rawDate, parsedIso);
    const description = readCell(row, columns.description).trim();
    const rawAmountCell = readCell(row, columns.amount);
    const rawAmount = rawAmountCell.trim();
    const currency = readCell(row, columns.currency).trim().toUpperCase();
    const diagnosticValue = rawAmount && currency ? `${rawAmount} ${currency}` : rawAmount;

    if (!CURRENT_PRODUCTS.has(product)) {
      diagnostics.push(buildDiagnostic({
        locator,
        code: 'FILTERED_PRODUCT',
        severity: 'info',
        reason: 'Product outside Atual/Current',
        date: diagDate,
        rawDate,
        description,
        value: diagnosticValue,
      }));
      continue;
    }

    const normalizedAmount = sdk.money.normalizeDecimal(rawAmount);
    if (!parsedIso || !description || normalizedAmount === null) {
      diagnostics.push(buildDiagnostic({
        locator,
        code: 'INVALID_ROW',
        severity: 'warning',
        reason: 'Missing or invalid date, description, or amount',
        date: diagDate,
        rawDate,
        description,
        value: diagnosticValue,
      }));
      continue;
    }

    if (currency && !CURRENCY_CODE_RE.test(currency)) {
      diagnostics.push(buildDiagnostic({
        locator,
        code: 'INVALID_CURRENCY',
        severity: 'warning',
        reason: `Invalid ISO 4217 currency code "${currency}"`,
        date: parsedIso,
        rawDate,
        description,
        value: diagnosticValue,
      }));
      continue;
    }

    const rawBalance = readCell(row, columns.balance).trim();
    const normalizedBalance = rawBalance !== '' ? sdk.money.normalizeDecimal(rawBalance) : null;
    const runningBalance = rawBalance !== '' ? (normalizedBalance ?? rawBalance) : undefined;
    const sourceId = readCell(row, columns.id).trim();

    transactions.push({
      date: parsedIso,
      description,
      amount: normalizedAmount,
      currency,
      ...(normalizedBalance !== null ? { balance: normalizedBalance } : {}),
      ...(sourceId ? { sourceId } : {}),
      evidence: {
        row: rowNumber,
        locator,
        rawDate: rawDateCell,
        rawAmount: rawAmountCell,
        ...(runningBalance !== undefined ? { runningBalance } : {}),
      },
    });
  }

  if (transactions.length === 0) {
    throw new sdk.ImporterError(
      sdk.ERROR_CODES.NO_TRANSACTIONS,
      'No "Atual"/"Current" transactions found in Revolut CSV',
      { diagnostics },
    );
  }

  return {
    headerMatched,
    result: {
      pluginApiVersion: '1',
      pluginId: PLUGIN_ID,
      institutionId: INSTITUTION_ID,
      transactions,
      diagnostics,
    },
  };
}

export default {
  detect(input, sdk) {
    if (input.format !== 'csv') {
      return {
        matched: false,
        confidence: 0,
        reason: 'Revolut importer only supports CSV statements.',
      };
    }

    try {
      const parsed = parseRevolutStatement(input, sdk);
      return {
        matched: true,
        confidence: parsed.headerMatched ? 0.98 : 0.85,
        format: 'csv',
        institutionId: INSTITUTION_ID,
        reason: `Matched Revolut CSV statement (${parsed.result.transactions.length} transaction(s)).`,
        metadata: {
          transactionCount: parsed.result.transactions.length,
          headerMatched: parsed.headerMatched,
        },
      };
    } catch (error) {
      if (error instanceof sdk.ImporterError) {
        return {
          matched: false,
          confidence: 0,
          reason: error.message || 'CSV does not match Revolut statement layout.',
        };
      }
      throw error;
    }
  },

  parse(input, sdk) {
    return parseRevolutStatement(input, sdk).result;
  },
};
