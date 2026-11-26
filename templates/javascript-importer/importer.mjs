const PLUGIN_ID = 'example-csv-bank';
const INSTITUTION_ID = 'example-csv-bank';

const HEADER_ALIASES = {
  account: ['account', 'conta'],
  status: ['status', 'estado'],
  date: ['completed date', 'data de conclusao', 'data'],
  description: ['description', 'descricao', 'descritivo'],
  amount: ['amount', 'montante', 'valor'],
  currency: ['currency', 'moeda'],
  balance: ['balance', 'saldo'],
  reference: ['reference', 'transaction id', 'id'],
};

const SUPPORTED_ACCOUNTS = new Set(['checking', 'corrente', 'atual', 'current']);
const COMPLETED_STATUSES = new Set(['completed', 'concluido', 'settled']);
const PENDING_STATUSES = new Set(['pending', 'pendente']);

function findColumnIndexes(headerRow, sdk) {
  const normalized = headerRow.map(cell => sdk.csv.normalizeHeader(cell));
  const find = aliases => normalized.findIndex(cell => aliases.includes(cell));
  return {
    account: find(HEADER_ALIASES.account),
    status: find(HEADER_ALIASES.status),
    date: find(HEADER_ALIASES.date),
    description: find(HEADER_ALIASES.description),
    amount: find(HEADER_ALIASES.amount),
    currency: find(HEADER_ALIASES.currency),
    balance: find(HEADER_ALIASES.balance),
    reference: find(HEADER_ALIASES.reference),
  };
}

function hasRequiredHeaders(columns) {
  return (
    columns.account !== -1 &&
    columns.status !== -1 &&
    columns.date !== -1 &&
    columns.description !== -1 &&
    columns.amount !== -1
  );
}

function locateHeader(rows, sdk) {
  const scanLimit = Math.min(rows.length, 5);
  for (let i = 0; i < scanLimit; i++) {
    const columns = findColumnIndexes(rows[i], sdk);
    if (hasRequiredHeaders(columns)) {
      return { headerIndex: i, columns };
    }
  }
  return null;
}

function readCell(row, index) {
  return index >= 0 && index < row.length ? row[index] : '';
}

function parseDateValue(rawDate, sdk) {
  const trimmed = rawDate.trim();
  if (!trimmed) return null;
  return (
    sdk.dates.parseIsoDatePrefix(trimmed) ??
    sdk.dates.parseDisplayDate(trimmed, '/') ??
    sdk.dates.parseDisplayDate(trimmed, '-')
  );
}

export default {
  detect(input, sdk) {
    if (input.format !== 'csv') {
      return {
        matched: false,
        confidence: 0,
        reason: 'Example CSV Bank only supports CSV statements.',
      };
    }

    let rows;
    try {
      const text = sdk.csv.decodeBytes(input.bytes);
      rows = sdk.csv.parseRows(text);
    } catch (error) {
      return {
        matched: false,
        confidence: 0,
        reason: `File could not be decoded as CSV: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (rows.length < 2) {
      return {
        matched: false,
        confidence: 0,
        reason: 'CSV does not contain a header row and transaction rows.',
      };
    }

    const located = locateHeader(rows, sdk);
    if (!located) {
      return {
        matched: false,
        confidence: 0,
        reason: 'Required Example CSV Bank headers (Account, Status, Completed Date, Description, Amount) were not found.',
      };
    }

    return {
      matched: true,
      confidence: 0.96,
      format: 'csv',
      institutionId: INSTITUTION_ID,
      reason: 'Matched Example CSV Bank statement headers.',
    };
  },

  parse(input, sdk) {
    if (input.format !== 'csv') {
      throw new sdk.ImporterError(
        sdk.ERROR_CODES.UNSUPPORTED_FORMAT,
        `Example CSV Bank expects CSV input, received "${input.format}".`,
      );
    }

    const text = sdk.csv.decodeBytes(input.bytes);
    const rows = sdk.csv.parseRows(text);
    if (rows.length === 0) {
      throw new sdk.ImporterError(sdk.ERROR_CODES.EMPTY_INPUT, 'CSV statement is empty.');
    }

    const located = locateHeader(rows, sdk);
    if (!located) {
      throw new sdk.ImporterError(
        sdk.ERROR_CODES.HEADER_NOT_FOUND,
        'Required Example CSV Bank headers were not found.',
      );
    }

    const includePending = sdk.options.resolveOption(input, 'includePending', false);
    const { headerIndex, columns } = located;
    const transactions = [];
    const diagnostics = [];

    for (let i = headerIndex + 1; i < rows.length; i++) {
      const row = rows[i];
      const rowNumber = i + 1;
      const locator = `Record ${rowNumber}`;

      const account = readCell(row, columns.account).trim();
      const status = readCell(row, columns.status).trim();
      const rawDate = readCell(row, columns.date);
      const description = readCell(row, columns.description).trim();
      const rawAmount = readCell(row, columns.amount);
      const currency = readCell(row, columns.currency).trim().toUpperCase();
      const rawBalance = readCell(row, columns.balance).trim();
      const sourceId = readCell(row, columns.reference).trim();

      const parsedDate = parseDateValue(rawDate, sdk);
      const normalizedAmount = sdk.money.normalizeDecimal(rawAmount);
      const diagValue = rawAmount.trim() && currency ? `${rawAmount.trim()} ${currency}` : rawAmount.trim();

      if (!SUPPORTED_ACCOUNTS.has(account.toLowerCase())) {
        diagnostics.push({
          locator,
          code: 'FILTERED_ACCOUNT',
          severity: 'info',
          reason: `Account "${account || '(empty)'}" is outside supported checking accounts.`,
          ...(parsedDate || rawDate.trim() ? { date: parsedDate ?? rawDate.trim() } : {}),
          ...(rawDate.trim() ? { rawDate: rawDate.trim() } : {}),
          ...(description ? { description } : {}),
          ...(diagValue ? { value: diagValue } : {}),
        });
        continue;
      }

      const statusLower = status.toLowerCase();
      const statusAllowed = COMPLETED_STATUSES.has(statusLower)
        || (includePending && PENDING_STATUSES.has(statusLower));
      if (!statusAllowed) {
        diagnostics.push({
          locator,
          code: 'FILTERED_STATUS',
          severity: 'info',
          reason: `Transaction status "${status || '(empty)'}" excluded.`,
          ...(parsedDate || rawDate.trim() ? { date: parsedDate ?? rawDate.trim() } : {}),
          ...(rawDate.trim() ? { rawDate: rawDate.trim() } : {}),
          ...(description ? { description } : {}),
          ...(diagValue ? { value: diagValue } : {}),
        });
        continue;
      }

      if (!parsedDate || !description || normalizedAmount === null) {
        diagnostics.push({
          locator,
          code: 'INVALID_ROW',
          severity: 'warning',
          reason: 'Missing or invalid date, description, or amount.',
          ...(parsedDate || rawDate.trim() ? { date: parsedDate ?? rawDate.trim() } : {}),
          ...(rawDate.trim() ? { rawDate: rawDate.trim() } : {}),
          ...(description ? { description } : {}),
          ...(diagValue ? { value: diagValue } : {}),
        });
        continue;
      }

      if (currency && !/^[A-Z]{3}$/.test(currency)) {
        diagnostics.push({
          locator,
          code: 'INVALID_CURRENCY',
          severity: 'warning',
          reason: `Invalid ISO 4217 currency code "${currency}".`,
          date: parsedDate,
          rawDate: rawDate.trim(),
          description,
          ...(diagValue ? { value: diagValue } : {}),
        });
        continue;
      }

      let normalizedBalance;
      if (rawBalance !== '') {
        const parsedBalance = sdk.money.normalizeDecimal(rawBalance);
        if (parsedBalance === null) {
          diagnostics.push({
            locator,
            code: 'INVALID_BALANCE',
            severity: 'warning',
            reason: `Invalid running balance "${rawBalance}".`,
            date: parsedDate,
            rawDate: rawDate.trim(),
            description,
            ...(diagValue ? { value: diagValue } : {}),
          });
          continue;
        }
        normalizedBalance = parsedBalance;
      }

      transactions.push({
        date: parsedDate,
        description,
        amount: normalizedAmount,
        currency,
        ...(normalizedBalance !== undefined ? { balance: normalizedBalance } : {}),
        ...(sourceId ? { sourceId } : {}),
        evidence: {
          row: rowNumber,
          locator,
          rawDate: rawDate.trim(),
          rawAmount: rawAmount.trim(),
          ...(normalizedBalance !== undefined ? { runningBalance: normalizedBalance } : {}),
        },
      });
    }

    if (transactions.length === 0) {
      throw new sdk.ImporterError(
        sdk.ERROR_CODES.NO_TRANSACTIONS,
        'No valid transactions found in Example CSV Bank statement.',
        { diagnosticsCount: diagnostics.length },
      );
    }

    return {
      pluginApiVersion: '1',
      pluginId: PLUGIN_ID,
      institutionId: INSTITUTION_ID,
      transactions,
      diagnostics,
    };
  },
};
