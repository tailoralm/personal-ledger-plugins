export declare const PLUGIN_API_VERSION = '1';

export type ImporterErrorCode =
  | 'EMPTY_INPUT'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_FORMAT'
  | 'HEADER_NOT_FOUND'
  | 'UNRECOGNIZED_STATEMENT'
  | 'NO_TRANSACTIONS'
  | 'PDF_EXTRACTION_FAILED'
  | 'INVALID_STATEMENT';

export declare const ERROR_CODES: Readonly<Record<ImporterErrorCode, ImporterErrorCode>>;

export declare class ImporterError extends Error {
  readonly code: ImporterErrorCode;
  readonly details?: unknown;
  constructor(code: ImporterErrorCode, message: string, details?: unknown);
}

export type StatementFormat = 'pdf' | 'csv' | 'xlsx';
export type AccountType = 'bank' | 'savings' | 'spend' | 'invest' | 'manual' | 'coverflex';

export interface PdfWord {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly page: number;
}

export interface PdfPage {
  readonly page: number;
  readonly text: string;
  readonly words: readonly PdfWord[];
}

export interface PdfDocument {
  readonly pageCount: number;
  readonly pages: readonly PdfPage[];
}

export interface ImportInput {
  readonly fileName: string;
  readonly format: StatementFormat | 'unknown';
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly text?: string;
  readonly pdf?: PdfDocument;
  readonly options: Readonly<Record<string, boolean | string | number | undefined>>;
}

export interface DetectionResult {
  matched: boolean;
  confidence: number;
  reason: string;
  format?: StatementFormat;
  institutionId?: string;
  ambiguity?: {
    possibleOverlap: boolean;
    notes?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface InvestmentEvidence {
  kind: 'buy' | 'sell' | 'dividend';
  action: string;
  timestamp: string;
  isin: string;
  ticker: string;
  instrumentName: string;
  shares: string;
  pricePerShare: string;
  priceCurrency: string;
  exchangeRate: string;
  conversionFee: string;
  feeCurrency: string;
  withholdingTax: string;
  taxCurrency: string;
}

export interface TransactionEvidence {
  row: number;
  page?: number;
  locator: string;
  rawDate?: string;
  rawAmount?: string;
  runningBalance?: string;
  yearInferred?: boolean;
  action?: string;
  investment?: InvestmentEvidence;
}

export interface NormalizedTransaction {
  date: string;
  description: string;
  amount: string;
  currency: string;
  balance?: string;
  sourceId?: string;
  accountReference?: string;
  evidence: TransactionEvidence;
}

export interface ImportDiagnostic {
  locator: string;
  reason: string;
  code?: string;
  severity?: 'info' | 'warning' | 'error';
  date?: string;
  rawDate?: string;
  description?: string;
  value?: string;
}

export interface SideInvestment {
  action: string;
  time: string;
  ticker: string;
  name: string;
  shares: string;
  pricePerShare: string;
  currencyPricePerShare: string;
  exchangeRate: string;
  total: string;
  currencyTotal: string;
  conversionFee: string;
  currencyConversionFee: string;
}

export interface ImportResult {
  pluginApiVersion: '1';
  pluginId: string;
  institutionId: string;
  transactions: NormalizedTransaction[];
  diagnostics: ImportDiagnostic[];
  sideInvestments?: SideInvestment[];
  metadata?: Record<string, unknown>;
}

export interface PdfColumnConfig {
  date1?: [number, number];
  date2?: [number, number];
  description?: [number, number];
  debit?: [number, number];
  credit?: [number, number];
  balance?: [number, number];
  [key: string]: [number, number] | undefined;
}

export interface ExtractedPdfRow {
  date: string;
  description: string;
  value: string;
  balance: string;
  rawDate?: string;
  rawAmount?: string;
  yearInferred?: boolean;
  currency?: string;
  sourceId?: string;
  accountReference?: string;
  action?: string;
}

export interface PositionedTableConfig<TColumns extends PdfColumnConfig = PdfColumnConfig> {
  headerKeywords: readonly string[];
  headerRegex: RegExp;
  footerRegex?: RegExp;
  marginToIgnore?: number;
  tolerance?: number;
  pageOffset?: number;
  decimalFormat?: 'auto' | 'pt';
  requireBalance?: boolean;
  dateSeparator?: string;
  normalizeAmount?: (raw: string) => string | null;
  columnsConfig: (headerWords: readonly PdfWord[]) => TColumns;
  extractDataFromRow: (rowWords: readonly PdfWord[], columns: TColumns) => ExtractedPdfRow;
  isEndOfPage?: (row: ExtractedPdfRow, rowWords: readonly PdfWord[]) => boolean;
  dateNormalizer?: (
    statementText: string,
  ) => (rawDate: string, row: ExtractedPdfRow, statementText: string) => string | { date: string; yearInferred?: boolean };
  isValid?: (
    transactions: readonly NormalizedTransaction[],
    context: { statementText: string; diagnostics: readonly ImportDiagnostic[] },
  ) => boolean;
}

export interface ImporterSdk {
  readonly apiVersion: '1';
  readonly ERROR_CODES: Readonly<Record<ImporterErrorCode, ImporterErrorCode>>;
  readonly ImporterError: typeof ImporterError;
  readonly dates: {
    readonly isValidYmd: (year: number, month: number, day: number) => boolean;
    readonly isValidIsoDate: (str: string) => boolean;
    readonly isValidDisplayDate: (str: string, sep?: string) => boolean;
    readonly toIsoDate: (year: number, month: number, day: number) => string | null;
    readonly parseDisplayDate: (ddmmyyyy: string, sep?: string) => string | null;
    readonly parseIsoDatePrefix: (raw: string) => string | null;
    readonly isoToDisplayDate: (iso: string) => string;
    readonly formatUtcTimestampToDisplay: (raw: string) => string;
  };
  readonly money: {
    readonly normalizeDecimal: (raw: string, options?: { decimalSeparator?: '.' | ',' | 'auto' }) => string | null;
    readonly normalizePortugueseDecimal: (raw: string) => string | null;
    readonly withSign: (decimal: string, sign: 'positive' | 'negative') => string;
  };
  readonly csv: {
    readonly decodeBytes: (bytes: Uint8Array | ArrayBuffer) => string;
    readonly detectDelimiter: (text: string, candidates?: readonly string[]) => string;
    readonly parseRows: (text: string, options?: { delimiter?: string | 'auto'; skipEmptyRows?: boolean }) => string[][];
    readonly normalizeHeader: (cell: string) => string;
  };
  readonly pdf: {
    readonly extractTableWords: (
      pdfDoc: PdfDocument,
      options: { headerRegex: RegExp; footerRegex?: RegExp },
    ) => { words: PdfWord[]; statementText: string };
    readonly groupRows: (
      words: readonly PdfWord[],
      options?: { marginToIgnore?: number; tolerance?: number; pageOffset?: number },
    ) => Map<number, PdfWord[]>;
    readonly parsePositionedTable: <TColumns extends PdfColumnConfig = PdfColumnConfig>(
      pdfDoc: PdfDocument,
      config: PositionedTableConfig<TColumns>,
    ) => {
      transactions: NormalizedTransaction[];
      diagnostics: ImportDiagnostic[];
      statementText: string;
    };
  };
  readonly options: {
    readonly resolveOption: <T extends boolean | string | number>(
      input: ImportInput,
      manifestOptionId: string,
      fallback: T,
    ) => T;
    readonly isStatementOnlyMode: (input: ImportInput) => boolean;
  };
}

export interface ImporterPlugin {
  detect(input: ImportInput, sdk: ImporterSdk): DetectionResult | Promise<DetectionResult>;
  parse(input: ImportInput, sdk: ImporterSdk): ImportResult | Promise<ImportResult>;
}

export declare function createImporterSdk(): ImporterSdk;
