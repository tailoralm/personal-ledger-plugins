const WINANSI_SPECIAL = new Map([
  [0x20ac, 0x80], // €
  [0x201a, 0x82], // ‚
  [0x0192, 0x83], // ƒ
  [0x201e, 0x84], // „
  [0x2026, 0x85], // …
  [0x2020, 0x86], // †
  [0x2021, 0x87], // ‡
  [0x02c6, 0x88], // ˆ
  [0x2030, 0x89], // ‰
  [0x0160, 0x8a], // Š
  [0x2039, 0x8b], // ‹
  [0x0152, 0x8c], // Œ
  [0x017d, 0x8e], // Ž
  [0x2018, 0x91], // ‘
  [0x2019, 0x92], // ’
  [0x201c, 0x93], // “
  [0x201d, 0x94], // ”
  [0x2022, 0x95], // •
  [0x2013, 0x96], // –
  [0x2014, 0x97], // —
  [0x02dc, 0x98], // ˜
  [0x2122, 0x99], // ™
  [0x0161, 0x9a], // š
  [0x203a, 0x9b], // ›
  [0x0153, 0x9c], // œ
  [0x017e, 0x9e], // ž
  [0x0178, 0x9f], // Ÿ
]);

const textEncoder = new TextEncoder();

export function encodeWinAnsiHex(text) {
  let hex = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    let byte;
    if (code <= 0xff) {
      byte = code;
    } else if (WINANSI_SPECIAL.has(code)) {
      byte = WINANSI_SPECIAL.get(code);
    } else {
      byte = 0x3f; // '?'
    }
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

function normalizePageSpec(pageSpec, defaultMediaBox) {
  if (Array.isArray(pageSpec)) {
    return { words: pageSpec, mediaBox: defaultMediaBox };
  }
  return {
    words: pageSpec.words ?? [],
    mediaBox: pageSpec.mediaBox ?? defaultMediaBox,
  };
}

function formatWordOp(word, defaultFontSize) {
  const [x, y, text, size] = Array.isArray(word)
    ? word
    : [word.x, word.y, word.text, word.fontSize];
  const fontSize = size ?? defaultFontSize;
  return `BT /F1 ${fontSize} Tf 1 0 0 1 ${x} ${y} Tm <${encodeWinAnsiHex(`${text} `)}> Tj ET`;
}

/**
 * Generates a synthetic multi-page %PDF-1.4 document with positioned WinAnsi words.
 */
export function buildPositionedPdf(pages, options = {}) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('buildPositionedPdf requires at least one page.');
  }

  const defaultMediaBox = options.mediaBox ?? [0, 0, 620, 800];
  const defaultFontSize = options.fontSize ?? 8;

  const objects = [];
  const pageObjectIds = [];

  // 1: Catalog, 2: Pages, 3: Font
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(''); // placeholder for Pages object
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  for (const rawPage of pages) {
    const { words, mediaBox } = normalizePageSpec(rawPage, defaultMediaBox);
    const pageObjId = objects.length + 1;
    const contentObjId = pageObjId + 1;
    pageObjectIds.push(pageObjId);

    const stream = words.map(word => formatWordOp(word, defaultFontSize)).join('\n');
    const streamLen = textEncoder.encode(stream).byteLength;

    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox.join(' ')}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjId} 0 R >>`,
    );
    objects.push(`<< /Length ${streamLen} >>\nstream\n${stream}\nendstream`);
  }

  objects[1] = `<< /Type /Pages /Kids [${pageObjectIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageObjectIds.length} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(textEncoder.encode(pdf).byteLength);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const xrefOffset = textEncoder.encode(pdf).byteLength;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return textEncoder.encode(pdf);
}

/**
 * Generates synthetic ActivoBank or BankInter statement PDFs compatible with legacy fixtures.
 */
export function statementPdf(bank, { closing, dates = ['02.02'], pages } = {}) {
  if (pages) {
    return buildPositionedPdf(pages);
  }

  const words = bank === 'ActivoBank'
    ? [
        [50, 700, 'Data'], [70, 700, 'Lanc.'], [105, 700, 'Data'], [125, 700, 'Valor'],
        [170, 700, 'Descritivo'], [380, 700, 'Debito'], [450, 700, 'Credito'], [535, 700, 'Saldo'],
      ]
    : [
        [0, 700, 'Data'], [18, 700, 'Movimento'], [68, 700, 'Data'], [84, 700, 'Valor'],
        [110, 700, 'Descrição'], [305, 700, 'Transação'], [350, 700, 'Montante'],
        [394, 700, 'Moeda'], [422, 700, 'Saldo'], [470, 700, 'Taxa'], [490, 700, 'Câmbio'],
        [0, 680, '03-02-2026'], [68, 680, '03-02-2026'], [110, 680, 'Cafe'],
        [350, 680, '-12,50'], [422, 680, '100,00'],
      ];

  if (bank === 'ActivoBank') {
    if (closing) {
      words.unshift([50, 760, closing]);
    }
    dates.forEach((date, index) => {
      const y = 680 - index * 20;
      words.push([70, y, date], [125, y, date], [170, y, 'Cafe'], [380, y, '12,50'], [535, y, '100,00']);
    });
  }

  return buildPositionedPdf([words]);
}
