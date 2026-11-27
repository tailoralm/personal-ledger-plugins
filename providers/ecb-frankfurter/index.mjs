const maxDays = 166;
const currencies = new Set(['EUR', 'GBP', 'USD']);
const scale = 10n ** 18n;
const dayMs = 86_400_000;

function reverseDate(date, separator, outputSeparator) {
  return date.split(separator).reverse().join(outputSeparator);
}

function requestRange(request) {
  // The host validates calendar dates and distinct uppercase currencies.
  const from = reverseDate(request.from, '/', '-');
  const to = reverseDate(request.to, '/', '-');
  const span = (Date.parse(to) - Date.parse(from)) / dayMs + 1;
  if (span < 1 || span > maxDays) throw new Error('ECB FX requires at most 166 inclusive calendar days.');
  return { from, to };
}

function canonical(scaled) {
  const digits = scaled.toString().padStart(19, '0');
  const fraction = digits.slice(-18).replace(/0+$/, '');
  return fraction ? digits.slice(0, -18) + '.' + fraction : digits.slice(0, -18);
}

function parseRate(token) {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) throw new Error('Expected a positive JSON decimal.');
  const [, whole, fraction = '', exponent = '0'] = match;
  const coefficient = (whole + fraction).replace(/^0+/, '');
  const digits = coefficient.replace(/0+$/, '');
  const trailingZeros = coefficient.length - digits.length;
  const shift = 18 + Number(exponent) - fraction.length + trailingZeros;
  if (!digits || !Number.isSafeInteger(shift) || shift < 0 || digits.length + shift > 36) {
    throw new Error('ECB decimal is outside the v1 precision bounds.');
  }
  return BigInt(digits + '0'.repeat(shift));
}

function observations(body, from, to) {
  const rows = JSON.parse(body);
  if (!Array.isArray(rows)) throw new Error('Expected an ECB rate array.');
  // Pinned QuickJS lacks JSON.parse reviver source. The first parse verifies JSON
  // and types. The second exposes the exact number tokens, skipping JSON strings.
  const lexical = JSON.parse(body.replace(
    /"(?:[^"\\]|\\[\s\S])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    token => token[0] === '"' ? token : '"' + token + '"',
  ));

  const days = new Map();
  for (const [index, row] of rows.entries()) {
    if (!row || row.base !== 'EUR' || (row.quote !== 'GBP' && row.quote !== 'USD') ||
        typeof row.rate !== 'number' || typeof row.date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
      throw new Error('Unexpected ECB rate row.');
    }
    const { date, quote } = row;
    const instant = new Date(date);
    if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== date) {
      throw new Error('Invalid ECB rate date.');
    }
    const rate = parseRate(lexical[index].rate);
    // Frankfurter can return the prior fixing for an empty window.
    const weekday = instant.getUTCDay();
    if (date < from || date > to || weekday === 0 || weekday === 6) continue;
    const legs = days.get(date) ?? new Map([['EUR', scale]]);
    if (legs.has(quote) && legs.get(quote) !== rate) throw new Error('Conflicting ECB rate rows.');
    legs.set(quote, rate);
    days.set(date, legs);
  }
  return days;
}

function convert(base, quote, legs) {
  if (base === 'EUR') return canonical(legs.get(quote));
  const denominator = legs.get(base);
  const numerator = legs.get(quote) * scale;
  // Round the positive quotient half-up at 18 fractional digits.
  const rate = (numerator + denominator / 2n) / denominator;
  if (rate === 0n || rate >= scale * scale) throw new Error('Derived FX rate is outside the v1 precision bounds.');
  return canonical(rate);
}

export default {
  buildRequest(request) {
    const { from, to } = requestRange(request);
    return { route: 'ecb', query: [['from', from], ['to', to], ['base', 'EUR'], ['quotes', 'GBP,USD']] };
  },

  normalizeResponse(request, { status, body, retryAfterSeconds }) {
    if (status === 429 || status === 408 || status >= 500) {
      const error = status === 429 ? 'rate-limited' : 'unavailable';
      return retryAfterSeconds === undefined ? { error } : { error, retryAfterSeconds };
    }
    if (status === 401 || status === 403) return { error: 'authentication' };
    if (status !== 200) return { error: status >= 400 ? 'invalid-request' : 'invalid-data' };

    try {
      const { from, to } = requestRange(request);
      const days = observations(body, from, to);
      const supported = request.pairs.filter(({ base, quote }) => currencies.has(base) && currencies.has(quote));
      const items = [];
      for (const publicationDate of [...days.keys()].sort()) {
        const legs = days.get(publicationDate);
        const date = reverseDate(publicationDate, '-', '/');
        const timestamp = publicationDate + 'T00:00:00.000Z';
        for (const { base, quote } of supported) {
          if (!legs.has(base) || !legs.has(quote)) continue;
          items.push({ base, quote, date, timezone: 'UTC', timestamp, rate: convert(base, quote, legs) });
        }
      }
      return { operation: 'fx', items };
    } catch {
      return { error: 'invalid-data' };
    }
  },
};
