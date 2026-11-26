const PLUGIN_ID = 'example-pdf-bank';
const INSTITUTION_ID = 'example-pdf-bank';
const HEADER_KEYWORDS = ['data', 'lanc.', 'descritivo', 'debito', 'credito', 'saldo'];
const HEADER_REGEX = /data\s+lanc\.?\s+descritivo\s+debito\s+credito\s+saldo/i;
const FOOTER_REGEX = /\bsaldo\s+final\b/i;
function isNumericToken(text) {
    return /^[\d.,\s-]+$/.test(text) && text.trim() !== '-';
}
function computeColumns(headerWords) {
    const columns = {
        date1: [40, 120],
        description: [120, 330],
        debit: [330, 415],
        credit: [415, 505],
        balance: [505, 620],
    };
    for (const word of headerWords) {
        const lower = word.text.toLowerCase();
        const x = Math.floor(word.x);
        const xEnd = Math.ceil(word.x + word.width);
        if (lower === 'data') {
            columns.date1[0] = Math.max(0, x - 5);
        }
        else if (lower === 'lanc.' || lower === 'lanc') {
            columns.date1[1] = xEnd + 8;
        }
        else if (lower === 'descritivo') {
            columns.description[0] = x - 5;
            columns.date1[1] = Math.min(columns.date1[1], x - 5);
        }
        else if (lower === 'debito') {
            const start = Math.floor(xEnd - 55);
            columns.debit = [start, xEnd + 10];
            columns.description[1] = start;
        }
        else if (lower === 'credito') {
            columns.credit = [Math.floor(xEnd - 55), xEnd + 10];
            columns.debit[1] = columns.credit[0];
        }
        else if (lower === 'saldo') {
            columns.balance = [Math.floor(xEnd - 65), 620];
            columns.credit[1] = columns.balance[0];
        }
    }
    return columns;
}
function extractPdfRow(rowWords, columns) {
    let date = '';
    let description = '';
    let debit = '';
    let credit = '';
    let balance = '';
    for (const word of rowWords) {
        const x = word.x;
        const text = word.text;
        if (x >= columns.date1[0] && x < columns.date1[1]) {
            date += (date ? ' ' : '') + text;
        }
        else if (x >= columns.description[0] && x < columns.description[1]) {
            const cleaned = text.replace(/[",;\r\n\t]/g, '').replace(/\s+/g, ' ').trim();
            if (cleaned) {
                description += (description ? ' ' : '') + cleaned;
            }
        }
        else if (x >= columns.debit[0] && x < columns.debit[1]) {
            if (isNumericToken(text))
                debit += text;
        }
        else if (x >= columns.credit[0] && x < columns.credit[1]) {
            if (isNumericToken(text))
                credit += text;
        }
        else if (x >= columns.balance[0] && x < columns.balance[1]) {
            if (isNumericToken(text))
                balance += text;
        }
    }
    let value = '';
    if (credit) {
        value = credit;
    }
    else if (debit) {
        value = debit.startsWith('-') ? debit : `-${debit}`;
    }
    return {
        date: date.trim(),
        description,
        value,
        balance: balance.trim(),
        rawDate: date.trim(),
        rawAmount: value,
    };
}
function buildDateNormalizer(sdk) {
    return (statementText) => {
        const closing = statementText.match(/\b(\d{2})\/(\d{2})\/(\d{2})\s+EXT\.\s*N\.\s*(\d{4})\/\d+\b/i);
        const closingYear = closing ? Number(closing[4]) : null;
        const closingMonth = closing ? Number(closing[2]) : null;
        const closingDay = closing ? Number(closing[3]) : null;
        const hasValidClosing = closing !== null
            && closing[4].endsWith(closing[1])
            && sdk.dates.isValidYmd(closingYear, closingMonth, closingDay);
        return (rawDate) => {
            const trimmed = rawDate.trim();
            if (sdk.dates.isValidDisplayDate(trimmed, '/')) {
                return { date: sdk.dates.parseDisplayDate(trimmed, '/') ?? trimmed, yearInferred: false };
            }
            const shortMatch = /^(\d{1,2})\.(\d{1,2})$/.exec(trimmed);
            if (!shortMatch) {
                return { date: trimmed, yearInferred: false };
            }
            const month = Number(shortMatch[1]);
            const day = Number(shortMatch[2]);
            const baseYear = hasValidClosing ? closingYear : 2026;
            const inferredYear = hasValidClosing && month > closingMonth
                ? baseYear - 1
                : baseYear;
            const iso = sdk.dates.toIsoDate(inferredYear, month, day);
            return {
                date: iso ?? `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${inferredYear}`,
                yearInferred: true,
            };
        };
    };
}
function parseCsvStatement(input, sdk) {
    const text = sdk.csv.decodeBytes(input.bytes);
    const rows = sdk.csv.parseRows(text);
    if (rows.length < 2) {
        throw new sdk.ImporterError(sdk.ERROR_CODES.HEADER_NOT_FOUND, 'CSV statement header not found.');
    }
    const header = rows[0].map(cell => sdk.csv.normalizeHeader(cell));
    const dateIdx = header.indexOf('data');
    const descIdx = header.indexOf('descritivo');
    const debitIdx = header.indexOf('debito');
    const creditIdx = header.indexOf('credito');
    const balanceIdx = header.indexOf('saldo');
    if (dateIdx === -1 || descIdx === -1 || (debitIdx === -1 && creditIdx === -1)) {
        throw new sdk.ImporterError(sdk.ERROR_CODES.HEADER_NOT_FOUND, 'Example PDF Bank CSV headers not found.');
    }
    const transactions = [];
    const diagnostics = [];
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 1;
        const locator = `Record ${rowNum}`;
        const rawDate = (row[dateIdx] ?? '').trim();
        const description = (row[descIdx] ?? '').trim();
        const rawDebit = debitIdx >= 0 ? (row[debitIdx] ?? '').trim() : '';
        const rawCredit = creditIdx >= 0 ? (row[creditIdx] ?? '').trim() : '';
        const rawBalance = balanceIdx >= 0 ? (row[balanceIdx] ?? '').trim() : '';
        const isoDate = sdk.dates.parseDisplayDate(rawDate, '/') ?? sdk.dates.parseIsoDatePrefix(rawDate);
        const rawAmount = rawCredit || (rawDebit ? `-${rawDebit}` : '');
        const normalizedAmount = rawCredit
            ? sdk.money.normalizePortugueseDecimal(rawCredit)
            : rawDebit
                ? sdk.money.withSign(sdk.money.normalizePortugueseDecimal(rawDebit) ?? '', 'negative') || null
                : null;
        const normalizedBalance = rawBalance ? sdk.money.normalizePortugueseDecimal(rawBalance) : null;
        if (!isoDate || !description || !normalizedAmount) {
            diagnostics.push({
                locator,
                code: 'INVALID_ROW',
                severity: 'warning',
                reason: 'Missing or invalid date, description, or amount.',
                ...(rawDate ? { rawDate, date: rawDate } : {}),
                ...(description ? { description } : {}),
                ...(rawAmount ? { value: rawAmount } : {}),
            });
            continue;
        }
        transactions.push({
            date: isoDate,
            description,
            amount: normalizedAmount,
            currency: '',
            ...(normalizedBalance !== null ? { balance: normalizedBalance } : {}),
            evidence: {
                row: rowNum,
                locator,
                rawDate,
                ...(rawAmount ? { rawAmount } : {}),
                ...(normalizedBalance !== null ? { runningBalance: normalizedBalance } : {}),
            },
        });
    }
    if (transactions.length === 0) {
        throw new sdk.ImporterError(sdk.ERROR_CODES.NO_TRANSACTIONS, 'No valid transactions found in CSV statement.');
    }
    return {
        pluginApiVersion: '1',
        pluginId: PLUGIN_ID,
        institutionId: INSTITUTION_ID,
        transactions,
        diagnostics,
    };
}
const plugin = {
    detect(input, sdk) {
        if (input.format === 'pdf') {
            if (!input.pdf) {
                return {
                    matched: false,
                    confidence: 0,
                    reason: 'Missing extracted PDF pages.',
                };
            }
            try {
                const { words } = sdk.pdf.extractTableWords(input.pdf, {
                    headerRegex: HEADER_REGEX,
                    footerRegex: FOOTER_REGEX,
                });
                const hasClosing = input.pdf.pages.some(page => /EXT\.\s*N\.\s*\d{4}\/\d+/i.test(page.text));
                return {
                    matched: true,
                    confidence: hasClosing ? 0.98 : 0.9,
                    format: 'pdf',
                    institutionId: INSTITUTION_ID,
                    reason: `Matched Example PDF Bank table headers across ${words.length} words.`,
                };
            }
            catch {
                return {
                    matched: false,
                    confidence: 0,
                    reason: 'PDF does not contain Example PDF Bank table headers.',
                };
            }
        }
        if (input.format === 'csv') {
            try {
                const rows = sdk.csv.parseRows(sdk.csv.decodeBytes(input.bytes));
                if (rows.length >= 2) {
                    const header = rows[0].map(cell => sdk.csv.normalizeHeader(cell));
                    const matched = header.includes('data') && header.includes('descritivo')
                        && (header.includes('debito') || header.includes('credito'));
                    if (matched) {
                        return {
                            matched: true,
                            confidence: 0.92,
                            format: 'csv',
                            institutionId: INSTITUTION_ID,
                            reason: 'Matched Example PDF Bank CSV headers.',
                        };
                    }
                }
            }
            catch {
                // Fall through to non-match
            }
            return {
                matched: false,
                confidence: 0,
                reason: 'CSV does not match Example PDF Bank headers.',
            };
        }
        return {
            matched: false,
            confidence: 0,
            reason: `Unsupported file format "${input.format}".`,
        };
    },
    parse(input, sdk) {
        if (input.format === 'csv') {
            return parseCsvStatement(input, sdk);
        }
        if (input.format !== 'pdf' || !input.pdf) {
            throw new sdk.ImporterError(sdk.ERROR_CODES.UNSUPPORTED_FORMAT, `Example PDF Bank expects PDF or CSV input, received "${input.format}".`);
        }
        const parsed = sdk.pdf.parsePositionedTable(input.pdf, {
            headerKeywords: HEADER_KEYWORDS,
            headerRegex: HEADER_REGEX,
            footerRegex: FOOTER_REGEX,
            marginToIgnore: 35,
            decimalFormat: 'pt',
            requireBalance: true,
            columnsConfig: computeColumns,
            extractDataFromRow: extractPdfRow,
            isEndOfPage: row => row.description.includes('A TRANSPORTAR') || row.description.includes('SALDO FINAL'),
            dateNormalizer: buildDateNormalizer(sdk),
            isValid: transactions => transactions.length > 0,
        });
        return {
            pluginApiVersion: '1',
            pluginId: PLUGIN_ID,
            institutionId: INSTITUTION_ID,
            transactions: parsed.transactions,
            diagnostics: parsed.diagnostics,
        };
    },
};
export default plugin;
