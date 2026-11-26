import { isValidIsoDate, isoToDisplayDate } from './index.mjs';

const LEGACY_CSV_HEADERS = ['date', 'description', 'cleanDescription', 'category', 'value', 'bank'];

function serializeSemicolonCsv(rows) {
  return rows
    .map(row =>
      row
        .map(cell => {
          const text = String(cell ?? '');
          return [';', '"', '\r', '\n'].some(ch => text.includes(ch))
            ? `"${text.replace(/"/g, '""')}"`
            : text;
        })
        .join(';'),
    )
    .join('\n');
}

function alignRawSign(amount, rawAmount) {
  if (amount.startsWith('-') && !rawAmount.startsWith('-')) {
    return `-${rawAmount}`;
  }
  return rawAmount;
}

/**
 * Converts a Plugin SDK v1 ImportResult into Personal-Ledger legacy Transaction[],
 * StatementEvidence[], StatementDiagnostic[], and Investment[] structures.
 */
export function toLegacyTransactions(importResult, options = {}) {
  const rawPdfValues = options?.rawPdfValues === true;
  const transactions = [];
  const evidenceByIndex = [];

  for (const tx of importResult.transactions) {
    const ev = tx.evidence;
    const isPdf = ev?.page !== undefined;
    const value = rawPdfValues && isPdf && ev?.rawAmount
      ? alignRawSign(tx.amount, ev.rawAmount)
      : tx.amount;
    const balance = rawPdfValues && isPdf && ev?.runningBalance !== undefined
      ? ev.runningBalance
      : (tx.balance ?? '');

    transactions.push({
      date: isoToDisplayDate(tx.date),
      description: tx.description,
      cleanDescription: '',
      category: '',
      value,
      balance,
    });

    const runningBalance = ev?.runningBalance !== undefined
      ? ev.runningBalance
      : tx.balance;

    evidenceByIndex.push({
      row: ev.row,
      ...(ev.page !== undefined ? { page: ev.page } : {}),
      locator: ev.locator,
      ...(tx.sourceId !== undefined ? { sourceId: tx.sourceId } : {}),
      ...(ev.action !== undefined ? { action: ev.action } : {}),
      currency: tx.currency,
      ...(ev.rawAmount !== undefined ? { rawAmount: ev.rawAmount } : {}),
      ...(runningBalance !== undefined ? { runningBalance } : {}),
      ...(ev.rawDate !== undefined ? { rawDate: ev.rawDate } : {}),
      ...(ev.yearInferred !== undefined ? { yearInferred: ev.yearInferred } : {}),
      ...(ev.investment !== undefined ? { investment: { ...ev.investment } } : {}),
    });
  }

  const diagnostics = (importResult.diagnostics ?? []).map(item => ({
    locator: item.locator,
    reason: item.reason,
    ...(item.date !== undefined
      ? { date: isValidIsoDate(item.date) ? isoToDisplayDate(item.date) : item.date }
      : {}),
    ...(item.description !== undefined ? { description: item.description } : {}),
    ...(item.value !== undefined ? { value: item.value } : {}),
  }));

  const sideInvestments = (importResult.sideInvestments ?? []).map(item => ({ ...item }));

  return {
    transactions,
    evidenceByIndex,
    diagnostics,
    sideInvestments,
  };
}

/**
 * Converts a Plugin SDK v1 ImportResult into the 6-column semicolon-delimited
 * normalized CSV format expected by Personal-Ledger CLI and Combine workflows.
 */
export function toLegacyNormalizedCsv(importResult, institutionName) {
  if (!importResult.transactions.length) {
    return '';
  }

  const bank = institutionName || importResult.institutionId;
  const rows = [
    LEGACY_CSV_HEADERS,
    ...importResult.transactions.map(tx => [
      isoToDisplayDate(tx.date),
      tx.description,
      '',
      '',
      tx.amount.replace('.', ','),
      bank,
    ]),
  ];

  return serializeSemicolonCsv(rows);
}
