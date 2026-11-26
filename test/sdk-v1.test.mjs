import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ERROR_CODES,
  ImporterError,
  createImporterSdk,
  csv,
  dates,
  money,
  options,
  pdf,
} from '../sdk/index.mjs';
import { extractPdfDocument } from '../sdk/pdf-host.mjs';
import { toLegacyNormalizedCsv, toLegacyTransactions } from '../sdk/compat.mjs';
import {
  SCHEMAS,
  assertPluginIsolation,
  loadPlugin,
  prepareImportInput,
  runDetection,
  runParse,
} from '../sdk/harness.mjs';
import { buildPositionedPdf, statementPdf } from '../sdk/pdf-fixture.mjs';
import { assertValidSchema, validateImportResultSemantics } from '../scripts/lib/schema-validator.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('sdk/index.mjs has zero imports and zero host globals', () => {
  const sdkSource = fs.readFileSync(path.join(ROOT, 'sdk/index.mjs'), 'utf8');
  assert.equal(/\bimport\b|\brequire\s*\(/.test(sdkSource), false);
  assert.equal(/\bBuffer\b|\bprocess\b|\b__dirname\b|\b__filename\b/.test(sdkSource), false);
});

test('sdk.dates handles integer calendar validation, leap years, and format conversions', () => {
  assert.equal(dates.isValidYmd(2024, 2, 29), true);
  assert.equal(dates.isValidYmd(2000, 2, 29), true);
  assert.equal(dates.isValidYmd(1900, 2, 29), false);
  assert.equal(dates.isValidYmd(2025, 2, 29), false);
  assert.equal(dates.isValidYmd(2100, 2, 29), false);
  assert.equal(dates.isValidYmd(1899, 12, 31), false);
  assert.equal(dates.isValidYmd(2101, 1, 1), false);

  assert.equal(dates.toIsoDate(2026, 5, 1), '2026-05-01');
  assert.equal(dates.toIsoDate(2026, 2, 30), null);
  assert.equal(dates.isValidIsoDate('2024-02-29'), true);
  assert.equal(dates.isValidIsoDate('2025-02-29'), false);

  assert.equal(dates.isValidDisplayDate('01/05/2026'), true);
  assert.equal(dates.isValidDisplayDate('30/02/2026'), false);
  assert.equal(dates.isValidDisplayDate('03-02-2026', '-'), true);

  assert.equal(dates.parseDisplayDate('01/05/2026'), '2026-05-01');
  assert.equal(dates.parseDisplayDate('03-02-2026', '-'), '2026-02-03');
  assert.equal(dates.parseDisplayDate('29/02/2025'), null);

  assert.equal(dates.parseIsoDatePrefix('2026-09-17 09:52:20'), '2026-09-17');
  assert.equal(dates.parseIsoDatePrefix('2026-09-17T09:52:20Z'), '2026-09-17');
  assert.equal(dates.parseIsoDatePrefix('2026-02-30 00:00:00'), null);

  assert.equal(dates.isoToDisplayDate('2026-05-01'), '01/05/2026');
  assert.throws(() => dates.isoToDisplayDate('2026-02-30'), err => err instanceof ImporterError);

  assert.equal(dates.formatUtcTimestampToDisplay('2026-09-17 09:52:20'), '17/09/2026 09:52:20');
  assert.equal(dates.formatUtcTimestampToDisplay('2026-02-30 09:52:20'), '2026-02-30 09:52:20');
  assert.equal(dates.formatUtcTimestampToDisplay('unparseable'), 'unparseable');
});

test('sdk.money preserves string decimal precision and normalizes Portuguese and international formats', () => {
  assert.equal(money.normalizeDecimal('EUR -12,50'), '-12.50');
  assert.equal(money.normalizeDecimal('1.234,56'), '1234.56');
  assert.equal(money.normalizeDecimal('1,234.56'), '1234.56');
  assert.equal(money.normalizeDecimal('12345678901234567.89'), '12345678901234567.89');
  assert.equal(money.normalizeDecimal('0.00'), '0.00');
  assert.equal(money.normalizeDecimal('invalid'), null);
  assert.equal(money.normalizeDecimal('1,234,567'), null);

  assert.equal(money.normalizePortugueseDecimal('1.500,00'), '1500.00');
  assert.equal(money.normalizePortugueseDecimal('-1.234'), '-1234');
  assert.equal(money.normalizePortugueseDecimal('0,00'), '0.00');

  assert.equal(money.withSign('12.50', 'negative'), '-12.50');
  assert.equal(money.withSign('-12.50', 'positive'), '12.50');
  assert.equal(money.withSign('0.00', 'negative'), '0.00');
  assert.equal(money.withSign('-0', 'negative'), '0');
});

test('sdk.csv decodes UTF-8, BOM, Latin-1, and double-encoded UTF-8 mojibake without Buffer', () => {
  // UTF-8 BOM + semicolon + quoted newline
  const bomText = '\uFEFFDate;Desc;Amount\r\n01/05/2026;"Line 1\n""Line 2""";-10,50\r\n';
  const decodedBom = csv.decodeBytes(new TextEncoder().encode(bomText));
  assert.equal(decodedBom.startsWith('\uFEFF'), false);
  const parsedSemi = csv.parseRows(decodedBom);
  assert.deepEqual(parsedSemi, [
    ['Date', 'Desc', 'Amount'],
    ['01/05/2026', 'Line 1\n"Line 2"', '-10,50'],
  ]);

  // Tab-delimited auto detection
  const tsvRows = csv.parseRows('A\tB\tC\n1\t2\t3\n');
  assert.deepEqual(tsvRows, [['A', 'B', 'C'], ['1', '2', '3']]);

  // Latin-1 fallback (invalid UTF-8 bytes)
  const latin1Bytes = new Uint8Array([0x43, 0x61, 0x66, 0xe9]); // "Café" in ISO-8859-1
  assert.equal(csv.decodeBytes(latin1Bytes), 'Café');

  // Double-encoded UTF-8 including C1 control byte 0x93 from en-dash U+2013
  const original = 'Descrição,Café – Lisbon €5';
  const utf8Once = Buffer.from(original, 'utf8');
  const doubleEncoded = Buffer.from(utf8Once.toString('latin1'), 'utf8');
  assert.equal(csv.decodeBytes(new Uint8Array(doubleEncoded)), original);

  // Header normalization strips diacritics and collapses spaces
  assert.equal(csv.normalizeHeader('  Data de   conclusão  '), 'data de conclusao');

  // Malformed quotes raise ImporterError
  assert.throws(
    () => csv.parseRows('A,B\n"unclosed,2\n'),
    err => err instanceof ImporterError && err.code === ERROR_CODES.INVALID_STATEMENT,
  );
  assert.throws(
    () => csv.parseRows('A,B\nfoo"bar,2\n'),
    err => err instanceof ImporterError && err.code === ERROR_CODES.INVALID_STATEMENT,
  );
});

test('sdk/pdf-host extracts positioned words via MuPDF and enforces size/page/word caps', async () => {
  const bytes = statementPdf('BankInter');
  const extracted = await extractPdfDocument(bytes);
  assert.equal(extracted.pageCount, 1);
  assert.equal(extracted.pages[0].page, 1);
  assert.ok(extracted.pages[0].words.some(w => w.text === 'Descrição' && w.page === 1));
  assert.ok(extracted.pages[0].words.some(w => w.text === '-12,50' && Math.abs(w.x - 350) < 1));

  await assert.rejects(
    () => extractPdfDocument(bytes, { maxFileBytes: 10 }),
    err => err instanceof ImporterError && err.code === ERROR_CODES.PDF_EXTRACTION_FAILED,
  );

  const twoPageBytes = buildPositionedPdf([
    [[50, 700, 'Page1']],
    [[50, 700, 'Page2']],
  ]);
  await assert.rejects(
    () => extractPdfDocument(twoPageBytes, { maxPages: 1 }),
    err => err instanceof ImporterError && err.code === ERROR_CODES.PDF_EXTRACTION_FAILED,
  );
  await assert.rejects(
    () => extractPdfDocument(twoPageBytes, { maxWords: 1 }),
    err => err instanceof ImporterError && err.code === ERROR_CODES.PDF_EXTRACTION_FAILED,
  );
  await assert.rejects(
    () => extractPdfDocument(new TextEncoder().encode('not a pdf')),
    err => err instanceof ImporterError && err.code === ERROR_CODES.PDF_EXTRACTION_FAILED,
  );
});

test('sdk.pdf helpers never mutate frozen input words and parse multi-page positioned tables', async () => {
  const bytes = buildPositionedPdf([
    [
      [50, 760, '26/01/30 EXT. N. 2026/001'],
      [50, 700, 'Data'], [70, 700, 'Lanc.'], [105, 700, 'Data'], [125, 700, 'Valor'],
      [170, 700, 'Descritivo'], [380, 700, 'Debito'], [450, 700, 'Credito'], [535, 700, 'Saldo'],
      [70, 680, '12.31'], [125, 680, '12.31'], [170, 680, 'Cafe'], [380, 680, '12,50'], [535, 680, '100,00'],
      [170, 640, 'A'], [182, 640, 'TRANSPORTAR'],
    ],
    [
      [50, 700, 'Data'], [70, 700, 'Lanc.'], [105, 700, 'Data'], [125, 700, 'Valor'],
      [170, 700, 'Descritivo'], [380, 700, 'Debito'], [450, 700, 'Credito'], [535, 700, 'Saldo'],
      [70, 680, '01.05'], [125, 680, '01.05'], [170, 680, 'Salary'], [450, 680, '500,00'], [535, 680, '600,00'],
      [170, 640, 'SALDO'], [205, 640, 'FINAL'],
    ],
  ]);

  const input = await prepareImportInput({ fileName: 'multi.pdf', bytes });
  const beforeY = input.pdf.pages[1].words[0].y;
  const rows = pdf.groupRows([...input.pdf.pages[0].words, ...input.pdf.pages[1].words], { marginToIgnore: 50 });
  assert.ok(rows.size >= 4);
  assert.equal(input.pdf.pages[1].words[0].y, beforeY);

  // Mutation attempts on frozen input throw TypeError
  assert.throws(() => { input.options.injected = true; }, TypeError);
  assert.throws(() => { input.pdf.pages[0].words[0].y += 1000; }, TypeError);

  const { statementText } = pdf.extractTableWords(input.pdf, {
    headerRegex: /data\s+lanc\.?\s+data\s+valor.*descritivo.*debito.*credito.*saldo/i,
    footerRegex: /\bsaldo\s+final\b/i,
  });
  assert.match(statementText, /EXT\. N\. 2026\/001/);
  assert.equal(/Descritivo/.test(statementText), false);

  assert.throws(
    () => pdf.extractTableWords(input.pdf, { headerRegex: /NONEXISTENT HEADER/ }),
    err => err instanceof ImporterError && err.code === ERROR_CODES.HEADER_NOT_FOUND,
  );

  // BankInter-style DD-MM-YYYY positioned table parse + compat CSV escaping
  const bankinterBytes = statementPdf('BankInter');
  const bankinterInput = await prepareImportInput({ fileName: 'bankinter.pdf', bytes: bankinterBytes });
  const bankinterParsed = pdf.parsePositionedTable(bankinterInput.pdf, {
    headerKeywords: ['data movimento', 'data valor', 'descrição', 'montante', 'saldo'],
    headerRegex: /data\s+movimento.*data\s+valor.*descriç[ãa]o.*transação.*montante.*moeda.*saldo.*taxa\s+c[âa]mbio/i,
    footerRegex: /\bconforme\b/i,
    decimalFormat: 'pt',
    dateSeparator: '-',
    columnsConfig: () => ({
      date1: [0, 60],
      date2: [68, 108],
      description: [108, 304],
      credit: [347, 391],
      debit: [467, 521],
      balance: [420, 467],
    }),
    extractDataFromRow: (rowWords, columns) => {
      let date = '';
      let description = '';
      let value = '';
      let balance = '';
      for (const word of rowWords) {
        if (word.x >= columns.date1[0] && word.x < columns.date1[1]) date = word.text;
        else if (word.x >= columns.date2[1] && word.x < columns.description[1]) {
          description += (description ? ' ' : '') + word.text;
        } else if (word.x >= columns.credit[0] && word.x < columns.credit[1]) {
          value += word.text;
        } else if (word.x >= columns.balance[0] && word.x < columns.balance[1]) {
          balance += word.text;
        }
      }
      return { date, description, value, balance, rawDate: date, rawAmount: value };
    },
  });
  assert.equal(bankinterParsed.transactions.length, 1);
  assert.equal(bankinterParsed.transactions[0].date, '2026-02-03');
  assert.equal(bankinterParsed.transactions[0].amount, '-12.50');
  assert.equal(bankinterParsed.transactions[0].balance, '100.00');
  assert.equal(bankinterParsed.transactions[0].evidence.locator, 'Page 1, row 2');

  // Quote/semicolon escaping and empty-transactions behavior in toLegacyNormalizedCsv
  const escapedCsv = toLegacyNormalizedCsv({
    pluginApiVersion: '1',
    pluginId: 'sample-bank',
    institutionId: 'sample',
    transactions: [{
      date: '2026-02-03',
      description: 'Cafe; "Central"',
      amount: '-12.50',
      currency: 'EUR',
      evidence: { row: 1, locator: 'Record 1' },
    }],
    diagnostics: [],
  }, 'BankInter');
  assert.equal(escapedCsv, 'date;description;cleanDescription;category;value;bank\n03/02/2026;"Cafe; ""Central""";;;-12,50;BankInter');
  assert.equal(toLegacyNormalizedCsv({
    pluginApiVersion: '1',
    pluginId: 'sample-bank',
    institutionId: 'sample',
    transactions: [],
    diagnostics: [],
  }, 'BankInter'), '');
});

test('sdk.options and harness enforce limits and isolation', async () => {
  const input = await prepareImportInput({
    fileName: 'x.csv',
    text: 'a,b\n1,2\n',
    options: { includePending: true, includeAllActivity: false },
  });
  assert.equal(options.resolveOption(input, 'includePending', false), true);
  assert.equal(options.resolveOption(input, 'missing', 'default'), 'default');
  assert.equal(options.isStatementOnlyMode(input), true);

  await assert.rejects(
    () => prepareImportInput({ fileName: 'empty.csv', bytes: new Uint8Array(0) }),
    err => err instanceof ImporterError && err.code === ERROR_CODES.EMPTY_INPUT,
  );
  await assert.rejects(
    () => prepareImportInput({ fileName: 'big.csv', text: '123456', limits: { maxFileBytes: 4 } }),
    err => err instanceof ImporterError && err.code === ERROR_CODES.FILE_TOO_LARGE,
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-iso-'));
  try {
    const badImport = path.join(tmpDir, 'bad-import.mjs');
    fs.writeFileSync(badImport, 'import fs from "node:fs"; export default {};\n');
    assert.throws(() => assertPluginIsolation(badImport, tmpDir), /forbidden import specifier/);

    const badParent = path.join(tmpDir, 'bad-parent.mjs');
    fs.writeFileSync(badParent, 'import x from "../sdk/index.mjs"; export default x;\n');
    assert.throws(() => assertPluginIsolation(badParent, tmpDir), /forbidden import specifier/);

    const badGlobal = path.join(tmpDir, 'bad-global.mjs');
    fs.writeFileSync(badGlobal, 'export default { detect() { return Buffer.from("a"); }, parse() {} };\n');
    assert.throws(() => assertPluginIsolation(badGlobal, tmpDir), /forbidden host global "Buffer"/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('cross-repository compatibility fixture suite passes schema, SDK, and legacy compat checks', async () => {
  const compatDir = path.join(ROOT, 'fixtures/compatibility');
  const casesDir = path.join(compatDir, 'cases');
  const sdk = createImporterSdk();

  // Case 01: Valid parse + mojibake + legacy normalized CSV
  const case01 = JSON.parse(fs.readFileSync(path.join(casesDir, '01-valid-parse-and-mojibake.json'), 'utf8'));
  const mojiBytes = fs.readFileSync(path.join(compatDir, case01.inputFile));
  const decodedRows = sdk.csv.parseRows(sdk.csv.decodeBytes(mojiBytes));
  assert.deepEqual(decodedRows[0].map(h => sdk.csv.normalizeHeader(h)), case01.expectedDecodedHeaders);
  assert.equal(decodedRows[1][4], 'Café Central');
  assert.equal(decodedRows[2][4], 'Livraria São João');
  validateImportResultSemantics(case01.expectedImportResult, SCHEMAS.importResult);
  assert.equal(toLegacyNormalizedCsv(case01.expectedImportResult, 'Revolut'), case01.expectedLegacyNormalizedCsv);

  // Case 02: Negative unrelated rejection
  const case02 = JSON.parse(fs.readFileSync(path.join(casesDir, '02-negative-unrelated.json'), 'utf8'));
  for (const subCase of case02.cases) {
    assertValidSchema(SCHEMAS.detectionResult, subCase.expectedDetection, 'Case 02 expectedDetection');
    const pluginDir = path.resolve(ROOT, subCase.pluginDir);
    const loaded = await loadPlugin(pluginDir);
    const bytes = fs.readFileSync(path.join(compatDir, subCase.inputFile));
    const input = await prepareImportInput({ fileName: path.basename(subCase.inputFile), bytes });
    const detection = await runDetection(loaded, input, sdk);
    assert.equal(detection.matched, false);
    assert.equal(detection.confidence, 0);
    await assert.rejects(() => runParse(loaded, input, sdk), err => err instanceof ImporterError);
  }

  // Case 03 & 04: Duplicate identical rows + real zero running balance
  const case03 = JSON.parse(fs.readFileSync(path.join(casesDir, '03-duplicate-identical-rows.json'), 'utf8'));
  const case04 = JSON.parse(fs.readFileSync(path.join(casesDir, '04-real-zero-balance.json'), 'utf8'));
  validateImportResultSemantics(case04.expectedImportResult, SCHEMAS.importResult);
  const jsPlugin = await loadPlugin(path.resolve(ROOT, case03.pluginDir));
  const dupBytes = fs.readFileSync(path.join(compatDir, case03.inputFile));
  const dupInput = await prepareImportInput({ fileName: 'duplicates-and-zero.csv', bytes: dupBytes });
  const parsedDup = await runParse(jsPlugin, dupInput, sdk);
  assert.equal(parsedDup.transactions.length, case03.expectedTransactionCount);
  assert.deepEqual(parsedDup, case04.expectedImportResult);
  const legacyDup = toLegacyTransactions(parsedDup);
  assert.equal(legacyDup.transactions[1].balance, case04.expectedLegacyZeroBalance);
  assert.equal(legacyDup.evidenceByIndex[1].runningBalance, case04.expectedLegacyZeroBalance);

  // Case 05: Inferred year PDF + rawPdfValues compat
  const case05 = JSON.parse(fs.readFileSync(path.join(casesDir, '05-inferred-year-pdf.json'), 'utf8'));
  validateImportResultSemantics(case05.expectedImportResult, SCHEMAS.importResult);
  const rawLegacy = toLegacyTransactions(case05.expectedImportResult, { rawPdfValues: true });
  assert.deepEqual(
    rawLegacy.transactions.map(({ date, value, balance }) => ({ date, value, balance })),
    case05.expectedLegacyRawPdfValues,
  );
  assert.equal(rawLegacy.evidenceByIndex[0].yearInferred, true);
  assert.equal(rawLegacy.evidenceByIndex[0].rawDate, '12.31');
  const normLegacy = toLegacyTransactions(case05.expectedImportResult, { rawPdfValues: false });
  assert.deepEqual(
    normLegacy.transactions.map(({ date, value, balance }) => ({ date, value, balance })),
    case05.expectedLegacyNormalizedValues,
  );
  // Also extract the actual synthetic PDF via MuPDF host and verify parsePositionedTable matches Case 05
  const activoBytes = fs.readFileSync(path.join(compatDir, case05.inputFile));
  const activoInput = await prepareImportInput({ fileName: 'inferred-year-activobank.pdf', bytes: activoBytes });
  assert.equal(activoInput.pdf.pageCount, 1);
  assert.ok(activoInput.pdf.pages[0].text.includes('26/01/30 EXT. N. 2026/001'));
  const activoParsed = sdk.pdf.parsePositionedTable(activoInput.pdf, {
    headerKeywords: ['lanc.', 'valor', 'descritivo', 'debito', 'credito', 'saldo'],
    headerRegex: /data\s+lanc\.?\s+data\s+valor.*descritivo.*debito.*credito.*saldo/i,
    footerRegex: /\bsaldo\s+final\b/i,
    marginToIgnore: 50,
    decimalFormat: 'pt',
    columnsConfig: () => ({
      date1: [50, 110],
      date2: [105, 165],
      description: [165, 350],
      debit: [350, 420],
      credit: [420, 518],
      balance: [518, 600],
    }),
    extractDataFromRow: (rowWords, columns) => {
      let date = '';
      let description = '';
      let debit = '';
      let credit = '';
      let balance = '';
      for (const word of rowWords) {
        if (word.x >= columns.date1[0] && word.x < columns.date1[1]) date += word.text;
        else if (word.x >= columns.date2[1] && word.x < columns.description[1]) {
          description += (description ? ' ' : '') + word.text;
        } else if (word.x >= columns.debit[0] && word.x < columns.debit[1]) debit += word.text;
        else if (word.x >= columns.credit[0] && word.x < columns.credit[1]) credit += word.text;
        else if (word.x >= columns.balance[0] && word.x < columns.balance[1]) balance += word.text;
      }
      const value = credit || (debit ? `-${debit}` : '');
      return { date, description, value, balance, rawDate: date, rawAmount: value, yearInferred: true };
    },
    isEndOfPage: row => row.description.includes('SALDO FINAL'),
    dateNormalizer: statementText => {
      const m = statementText.match(/\b(\d{2})\/(\d{2})\/(\d{2})\s+EXT\.\s*N\.\s*(\d{4})\/\d+\b/i);
      const closingYear = Number(m[4]);
      const closingMonth = Number(m[2]);
      return raw => {
        const [, mm, dd] = /^(\d{2})\.(\d{2})$/.exec(raw);
        const month = Number(mm);
        const year = closingYear - Number(month > closingMonth);
        return { date: sdk.dates.toIsoDate(year, month, Number(dd)), yearInferred: true };
      };
    },
  });
  assert.deepEqual(
    activoParsed.transactions.map(({ date, description, amount, balance }) => ({ date, description, amount, balance })),
    case05.expectedImportResult.transactions.map(({ date, description, amount, balance }) => ({ date, description, amount, balance })),
  );

  // Case 06: Multi-currency and empty currency
  const case06 = JSON.parse(fs.readFileSync(path.join(casesDir, '06-multi-and-empty-currency.json'), 'utf8'));
  validateImportResultSemantics(case06.expectedImportResult, SCHEMAS.importResult);
  const legacy06 = toLegacyTransactions(case06.expectedImportResult);
  assert.deepEqual(legacy06.evidenceByIndex.map(e => e.currency), case06.expectedLegacyCurrencies);
  assert.equal(legacy06.transactions[0].balance, '');

  // Case 07: Structured investment evidence + sideInvestments
  const case07 = JSON.parse(fs.readFileSync(path.join(casesDir, '07-structured-investment-evidence.json'), 'utf8'));
  validateImportResultSemantics(case07.expectedImportResult, SCHEMAS.importResult);
  const legacy07 = toLegacyTransactions(case07.expectedImportResult);
  assert.equal(legacy07.transactions.length, 7);
  assert.equal(legacy07.evidenceByIndex[4].investment.kind, 'buy');
  assert.equal(legacy07.evidenceByIndex[4].investment.ticker, 'AAPL');
  assert.equal(legacy07.diagnostics.length, 1);
  assert.equal(legacy07.sideInvestments.length, 4);
  assert.equal(legacy07.sideInvestments[2].time, '04/09/2026 14:30:00');
});
