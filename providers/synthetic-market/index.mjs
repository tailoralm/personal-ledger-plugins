export default {
  buildRequest(request) {
    for (const global of ['fetch', 'XMLHttpRequest', 'WebSocket', 'process', 'require', 'Deno', 'std', 'os']) {
      if (globalThis[global] !== undefined) throw new Error('Unexpected host capability');
    }
    const query = [['operation', request.operation]];
    if (request.cursor) query.push(['cursor', request.cursor]);
    if ('by' in request) query.push(['by', request.by], ['query', request.query]);
    if ('from' in request) query.push(['from', request.from], ['to', request.to]);
    if ('basis' in request) query.push(['basis', request.basis]);
    if ('symbols' in request) for (const symbol of request.symbols) query.push(['symbol', symbol]);
    if ('pairs' in request) for (const pair of request.pairs) query.push(['pair', pair.base + pair.quote]);
    return { route: request.operation === 'search' ? 'public' : 'market', query };
  },
  normalizeResponse(request, response) {
    if (response.status === 429) return { error: 'rate-limited', retryAfterSeconds: response.retryAfterSeconds };
    if (response.status !== 200) return { error: 'unavailable' };
    return JSON.parse(response.body);
  },
};
