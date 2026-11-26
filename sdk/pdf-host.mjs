import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ERROR_CODES, ImporterError } from './index.mjs';

const FALLBACK_MUPDF_PATH = '/media/second/workspace/projects/statement-processor/node_modules/mupdf/dist/mupdf.js';
const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_PAGES = 200;
const DEFAULT_MAX_WORDS = 250_000;

let cachedMupdfPromise = null;
let cachedMupdfKey = null;

function toImportTarget(specifierOrPath) {
  if (/^(?:file:|https?:|data:|node:)/.test(specifierOrPath)) {
    return specifierOrPath;
  }
  if (path.isAbsolute(specifierOrPath) || specifierOrPath.startsWith('.')) {
    return pathToFileURL(path.resolve(specifierOrPath)).href;
  }
  return specifierOrPath;
}

export async function loadMupdf() {
  const override = process.env.PERSONAL_LEDGER_MUPDF_PATH;
  const cacheKey = override ? `env:${override}` : 'default';
  if (cachedMupdfPromise && cachedMupdfKey === cacheKey) {
    return cachedMupdfPromise;
  }

  cachedMupdfKey = cacheKey;
  cachedMupdfPromise = (async () => {
    if (override) {
      return await import(toImportTarget(override));
    }
    try {
      return await import('mupdf');
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND' && !/Cannot find package 'mupdf'/.test(String(error?.message))) {
        throw error;
      }
      return await import(pathToFileURL(FALLBACK_MUPDF_PATH).href);
    }
  })();

  try {
    return await cachedMupdfPromise;
  } catch (error) {
    cachedMupdfPromise = null;
    cachedMupdfKey = null;
    throw error;
  }
}

function normalizeBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new ImporterError(ERROR_CODES.PDF_EXTRACTION_FAILED, 'PDF input must be a Uint8Array or ArrayBuffer.');
}

/**
 * Trusted host-side PDF positioned-word extractor powered by MuPDF.
 * Mirrors statement-processor's PdfParserService.extractTransactionWords character-for-character.
 */
export async function extractPdfDocument(rawBytes, limits = {}) {
  const bytes = normalizeBytes(rawBytes);
  const maxFileBytes = limits.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxPages = limits.maxPages ?? DEFAULT_MAX_PAGES;
  const maxWords = limits.maxWords ?? DEFAULT_MAX_WORDS;

  if (bytes.byteLength === 0) {
    throw new ImporterError(ERROR_CODES.PDF_EXTRACTION_FAILED, 'PDF input is empty.');
  }
  if (bytes.byteLength > maxFileBytes) {
    throw new ImporterError(
      ERROR_CODES.PDF_EXTRACTION_FAILED,
      `PDF exceeds maximum allowed size (${bytes.byteLength} > ${maxFileBytes} bytes).`,
      { byteLength: bytes.byteLength, maxFileBytes },
    );
  }

  let mupdf;
  try {
    mupdf = await loadMupdf();
  } catch (error) {
    throw new ImporterError(
      ERROR_CODES.PDF_EXTRACTION_FAILED,
      `Failed to load MuPDF runtime: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let doc;
  try {
    doc = mupdf.Document.openDocument(bytes, 'application/pdf');
    const pageCount = doc.countPages();
    if (pageCount <= 0) {
      throw new ImporterError(ERROR_CODES.PDF_EXTRACTION_FAILED, 'PDF contains no pages.');
    }
    if (pageCount > maxPages) {
      throw new ImporterError(
        ERROR_CODES.PDF_EXTRACTION_FAILED,
        `PDF exceeds maximum page limit (${pageCount} > ${maxPages}).`,
        { pageCount, maxPages },
      );
    }

    const pages = [];
    let totalWords = 0;

    for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
      let page;
      let stext;
      try {
        page = doc.loadPage(pageNum - 1);
        stext = page.toStructuredText('preserve-whitespace');

        const pageWords = [];
        const pageTextParts = [];

        let wordText = '';
        let wordX = 0;
        let wordY = 0;
        let wordX1 = 0;
        let wordHeight = 0;

        const flushWord = () => {
          if (wordText) {
            totalWords++;
            if (totalWords > maxWords) {
              throw new ImporterError(
                ERROR_CODES.PDF_EXTRACTION_FAILED,
                `PDF exceeds maximum extracted word limit (${maxWords}).`,
                { maxWords },
              );
            }
            pageWords.push({
              text: wordText,
              x: wordX,
              y: wordY,
              width: wordX1 - wordX,
              height: wordHeight,
              page: pageNum,
            });
            pageTextParts.push(wordText);
            wordText = '';
          }
        };

        stext.walk({
          onChar: (c, origin, _font, size, quad, _color) => {
            if (c === ' ' || c === '\t') {
              flushWord();
              return;
            }

            const x = origin[0];
            const y = origin[1];
            const charX1 = quad[2];

            if (!wordText) {
              wordX = x;
              wordY = y;
              wordHeight = size;
            }
            wordText += c;
            wordX1 = charX1;
            wordHeight = Math.max(wordHeight, size);
          },
          endLine: () => {
            flushWord();
          },
        });

        flushWord();

        pages.push({
          page: pageNum,
          text: pageTextParts.join(' '),
          words: pageWords,
        });
      } finally {
        stext?.destroy?.();
        page?.destroy?.();
      }
    }

    return { pageCount, pages };
  } catch (error) {
    if (error instanceof ImporterError) {
      throw error;
    }
    throw new ImporterError(
      ERROR_CODES.PDF_EXTRACTION_FAILED,
      `Failed to extract PDF positioned words: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    doc?.destroy?.();
  }
}
