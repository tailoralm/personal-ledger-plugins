export type Operation = 'search' | 'metadata' | 'quote' | 'history' | 'fx' | 'corporate-actions';
export type PriceBasis = 'raw' | 'split-adjusted' | 'total-return-adjusted';
export type InstrumentKind = 'equity' | 'etf' | 'fund' | 'bond' | 'index' | 'crypto' | 'other';
export interface Capability { batchSize: number; pagination: boolean; creditCost: number }
export interface Route { id: string; url: string; credential?: string }
export type Credential =
  | { id: string; label: string; type: 'bearer' }
  | { id: string; label: string; type: 'api-key'; header: string };
export interface ProviderManifest {
  pluginApiVersion: '1';
  type: 'market-data-provider' | 'exchange-rate-provider';
  id: string;
  name: string;
  version: string;
  entrypoint: string;
  capabilities: Partial<Record<Operation, Capability>>;
  markets: string[];
  routes: Route[];
  authentication: Credential[];
  recommended: { requestsPerMinute: number; creditsPerDay: number; intervalMinutes: number };
}

type DateRange = { from: string; to: string };
export type CurrencyPair = { base: string; quote: string };
export type ProviderRequest = { cursor?: string } & (
  | { operation: 'search'; by: 'ticker' | 'name' | 'isin'; query: string }
  | { operation: 'metadata' | 'quote'; symbols: string[] }
  | ({ operation: 'history'; symbols: string[]; basis: PriceBasis } & DateRange)
  | ({ operation: 'corporate-actions'; symbols: string[] } & DateRange)
  | ({ operation: 'fx'; pairs: CurrencyPair[] } & DateRange)
);
export interface HttpPlan { route: string; query: [string, string][] }
export interface HttpResult { status: number; body: string; retryAfterSeconds?: number }

export interface Instrument {
  symbol: string;
  ticker: string;
  name: string;
  isin?: string;
  mic?: string;
  currency: string;
  kind: InstrumentKind;
  timezone: string;
}
type MarketTime = { date: string; timezone: string; timestamp: string };
type Price = MarketTime & { symbol: string; currency: string; unit: 'per-share'; basis: PriceBasis };
export type Quote = Price & { price: string };
export type Candle = Price & { open: string; high: string; low: string; close: string; volume?: string };
export type FxRate = MarketTime & CurrencyPair & { rate: string };
export type CorporateAction = MarketTime & { symbol: string; actionId: string } & (
  | { kind: 'split'; ratio: string } | { kind: 'dividend'; amount: string; currency: string }
);
type Rows = { search: Instrument; metadata: Instrument; quote: Quote; history: Candle; fx: FxRate;
  'corporate-actions': CorporateAction };
export type ProviderError = {
  error: 'rate-limited' | 'authentication' | 'unavailable' | 'invalid-request' | 'invalid-data';
  retryAfterSeconds?: number;
};
export type ProviderPage = { [K in Operation]: { operation: K; items: Rows[K][]; nextCursor?: string } }[Operation];
export type ProviderResponse = ProviderPage | ProviderError;

/** Default export of the packaged ESM entrypoint. */
export interface ProviderPlugin {
  buildRequest(request: ProviderRequest): HttpPlan;
  normalizeResponse(request: ProviderRequest, response: HttpResult): ProviderResponse;
}
