export default {
  buildRequest({ pairs, from, to }) {
    const query = [['from', from], ['to', to]];
    for (const { base, quote } of pairs) query.push(['pair', base + quote]);
    return { route: 'public', query };
  },
  normalizeResponse(request, response) {
    return response.status === 200 ? JSON.parse(response.body) : { error: 'unavailable' };
  },
};
