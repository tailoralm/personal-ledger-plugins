const PLUGIN_ID = 'eu-trading212';
const INSTITUTION_ID = 'trading212';
const STATEMENT_ACTIONS = new Set(['card debit', 'card credit', 'deposit']);
const BUY_ACTIONS = new Set(['market buy', 'limit buy', 'stop buy', 'stop limit buy']);
const SELL_ACTIONS = new Set(['market sell', 'limit sell', 'stop sell', 'stop limit sell']);
const CASH_CREDITS = new Set(['spending cashback', 'interest on cash']);
const SIDE_ACTIONS = new Set([
  'market buy', ...CASH_CREDITS, 'dividend (dividend)', 'dividend (dividend manufactured payment)',
]);

const HEADERS = {
  action: 'action',
  time: 'time (utc)',
  total: 'total',
  merchant: 'merchant name',
  id: 'id',
  isin: 'isin',
  ticker: 'ticker',
  name: 'name',
  shares: 'no. of shares',
  price: 'price / share',
  priceCurrency: 'currency (price / share)',
  exchangeRate: 'exchange rate',
  currency: 'currency (total)',
  fee: 'currency conversion fee',
  feeCurrency: 'currency (currency conversion fee)',
  tax: 'withholding tax',
  taxCurrency: 'currency (withholding tax)',
};

const STATEMENT_POSITIONS = { action: 0, time: 1, total: 11, merchant: 17 };
const SIDE_POSITIONS = {
  action: 0, time: 1, ticker: 3, name: 4, shares: 7, price: 8, priceCurrency: 9,
  exchangeRate: 10, total: 11, currency: 12, fee: 15, feeCurrency: 16,
};

function resolveLayouts(rows, fullActivity) {
  const candidates = rows.slice(0, 10).map((row, index) => {
    const header = row.map(cell => cell.trim().toLowerCase());
    const columns = Object.fromEntries(
      Object.entries(HEADERS).map(([key, label]) => [key, header.indexOf(label)]),
    );
    return { index, columns };
  });
  const hasBase = ({ columns }) => columns.action >= 0 && columns.time >= 0 && columns.total >= 0;
  const statement = candidates.find(layout => {
    const { columns } = layout;
    return hasBase(layout) && (columns.merchant >= 0
      || (fullActivity && [columns.ticker, columns.name, columns.isin, columns.id].some(i => i >= 0)));
  });
  return {
    headerMatched: Boolean(statement),
    statement: statement ?? { index: 0, columns: { ...candidates[0].columns, ...STATEMENT_POSITIONS } },
    side: candidates.find(hasBase) ?? { index: 0, columns: SIDE_POSITIONS },
  };
}

function cell(row, columns, key) {
  return row[columns[key]] ?? '';
}

function parseSideInvestments(rows, { index, columns }, sdk) {
  const investments = [];
  for (const row of rows.slice(index + 1)) {
    const read = key => cell(row, columns, key).trim();
    const action = read('action');
    if (!SIDE_ACTIONS.has(action.toLowerCase())) continue;
    const decimal = key => sdk.money.normalizeDecimal(read(key)) ?? read(key);
    investments.push({
      action,
      time: read('time'),
      ticker: read('ticker'),
      name: read('name'),
      shares: decimal('shares'),
      pricePerShare: decimal('price'),
      currencyPricePerShare: read('priceCurrency'),
      exchangeRate: decimal('exchangeRate'),
      total: decimal('total'),
      currencyTotal: read('currency'),
      conversionFee: decimal('fee'),
      currencyConversionFee: read('feeCurrency'),
    });
  }
  return investments;
}

function investmentKind(action) {
  if (BUY_ACTIONS.has(action)) return 'buy';
  if (SELL_ACTIONS.has(action)) return 'sell';
  if (/^dividend(?:[ (]|$)/.test(action)) return 'dividend';
  return undefined;
}

function investmentDescription(action, kind, ticker, name) {
  const instrument = ticker && name && ticker.toLowerCase() !== name.toLowerCase()
    ? `${ticker} (${name})`
    : ticker || name;
  if (!instrument) return action;
  return `${kind === 'dividend' ? 'Dividend' : action} · ${instrument}`;
}

function signedAmount(amount, action, kind, sdk) {
  if (kind === 'buy' || action === 'withdrawal') return sdk.money.withSign(amount, 'negative');
  if (kind || CASH_CREDITS.has(action)) return sdk.money.withSign(amount, 'positive');
  return amount;
}

function readText(input, sdk) {
  if (input.bytes != null) {
    try {
      return sdk.csv.decodeBytes(input.bytes);
    } catch (error) {
      if (typeof input.text !== 'string') throw error;
    }
  }
  return input.text ?? '';
}

function parseStatement(input, sdk) {
  if (input.format !== 'csv') {
    throw new sdk.ImporterError(sdk.ERROR_CODES.UNSUPPORTED_FORMAT, 'Trading212 importer expects CSV input');
  }
  const rows = sdk.csv.parseRows(readText(input, sdk), { delimiter: ',' });
  if (rows.length === 0) {
    throw new sdk.ImporterError(sdk.ERROR_CODES.EMPTY_INPUT, 'Trading212 CSV file is empty');
  }

  const fullActivity = !sdk.options.isStatementOnlyMode(input);
  const { statement, side, headerMatched } = resolveLayouts(rows, fullActivity);
  const { index, columns } = statement;
  const transactions = [];
  const diagnostics = [];

  for (let i = index + 1; i < rows.length; i++) {
    const row = rows[i];
    const raw = key => cell(row, columns, key);
    const read = key => raw(key).trim();
    const rowNumber = i + 1;
    const locator = `Record ${rowNumber}`;
    const actionCell = read('action');
    const action = actionCell.toLowerCase();
    const rawDate = read('time');
    const date = sdk.dates.parseIsoDatePrefix(rawDate);
    const rawAmount = read('total');
    const sourceCurrency = read('currency');
    const currency = sourceCurrency.toUpperCase();
    const merchant = read('merchant');
    const ticker = read('ticker');
    const name = read('name');
    const kind = investmentKind(action);
    const diagnosticFields = {
      locator,
      ...(rawDate ? { date: date ?? rawDate, rawDate } : {}),
      ...(rawAmount ? { value: sourceCurrency ? `${rawAmount} ${sourceCurrency}` : rawAmount } : {}),
    };
    const allowed = STATEMENT_ACTIONS.has(action)
      || (fullActivity && (kind || action === 'withdrawal' || CASH_CREDITS.has(action)));
    if (!allowed) {
      const instrument = name || ticker;
      const description = merchant || [actionCell, instrument].filter(Boolean).join(' · ');
      diagnostics.push({
        ...diagnosticFields,
        code: 'UNSUPPORTED_ACTION',
        severity: 'info',
        reason: 'Action outside supported statement activity',
        ...(description ? { description } : {}),
      });
      continue;
    }

    const description = kind ? investmentDescription(actionCell, kind, ticker, name) : merchant || actionCell;
    const amount = sdk.money.normalizeDecimal(rawAmount);
    if (!date || amount === null || (currency && !/^[A-Z]{3}$/.test(currency))) {
      const invalidCurrency = date && amount !== null;
      diagnostics.push({
        ...diagnosticFields,
        code: invalidCurrency ? 'INVALID_CURRENCY' : 'INVALID_ROW',
        severity: 'warning',
        reason: invalidCurrency ? 'Invalid statement currency.' : 'Missing or invalid date, description, or amount',
        description,
      });
      continue;
    }

    const isin = read('isin');
    const shares = read('shares');
    let sourceId = read('id');
    if (!sourceId && kind) {
      const prefix = kind === 'dividend' ? 'div' : `trade:${action}`;
      sourceId = `${prefix}:${rawDate}|${ticker || isin || name}|${rawAmount}|${shares}`;
    }

    const evidence = { row: rowNumber, locator, rawDate: raw('time'), rawAmount: raw('total'), action };
    if (kind) {
      evidence.investment = {
        kind,
        action: actionCell,
        timestamp: rawDate,
        isin,
        ticker,
        instrumentName: name,
        shares,
        pricePerShare: read('price'),
        priceCurrency: read('priceCurrency').toUpperCase(),
        exchangeRate: read('exchangeRate'),
        conversionFee: read('fee'),
        feeCurrency: read('feeCurrency').toUpperCase(),
        withholdingTax: read('tax'),
        taxCurrency: read('taxCurrency').toUpperCase(),
      };
    }

    transactions.push({
      date,
      description,
      amount: signedAmount(amount, action, kind, sdk),
      currency,
      ...(sourceId ? { sourceId } : {}),
      evidence,
    });
  }

  const sideInvestments = parseSideInvestments(rows, side, sdk);
  if (transactions.length === 0 && (fullActivity || sideInvestments.length === 0)) {
    throw new sdk.ImporterError(
      sdk.ERROR_CODES.NO_TRANSACTIONS,
      fullActivity
        ? 'No supported transactions found in Trading212 CSV'
        : 'No "Card debit"/"Card credit"/"Deposit" transactions found in Trading212 CSV',
      { diagnostics },
    );
  }

  return {
    headerMatched,
    result: { pluginApiVersion: '1', pluginId: PLUGIN_ID, institutionId: INSTITUTION_ID, transactions, diagnostics, sideInvestments },
  };
}

export default {
  detect(input, sdk) {
    try {
      const { headerMatched, result } = parseStatement(input, sdk);
      return {
        matched: true,
        confidence: headerMatched ? 0.98 : 0.85,
        format: 'csv',
        institutionId: INSTITUTION_ID,
        reason: 'Matched Trading212 CSV statement.',
        metadata: { headerMatched, transactionCount: result.transactions.length },
      };
    } catch (error) {
      if (!(error instanceof sdk.ImporterError)) throw error;
      return { matched: false, confidence: 0, reason: error.message };
    }
  },

  parse(input, sdk) {
    return parseStatement(input, sdk).result;
  },
};
