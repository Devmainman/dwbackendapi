// Server-side market prices for live trading.
//   Crypto  X/USDT, X/USDC, X/USD  -> Binance spot ticker (cached a few seconds)
//   Crypto  X/GBP, X/EUR, ...      -> Binance X/USDT converted at the FX rate
//   Forex   A/B                    -> open.er-api.com USD rates (cached 30 min)
// Every fill and P/L is computed from these prices; the client never sets a price.
import axios from 'axios';
import { binanceGet, coinbaseTicker } from './binance.js';

const CRYPTO_TTL = 4000;
const FX_TTL = 30 * 60 * 1000;
const STABLE = new Set(['USDT', 'USDC', 'BUSD', 'FDUSD', 'USD']);
const FIAT = new Set(['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD', 'CNY', 'NGN', 'INR', 'ZAR', 'BRL', 'TRY', 'SGD', 'HKD', 'SEK', 'NOK', 'MXN']);

const cryptoCache = new Map(); // BINANCE_SYMBOL -> { price, change, high, low, volume, at }
let fxCache = { rates: null, at: 0 };

export class MarketError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** Parse "BTC/USDT" → { symbol, base, quote, kind } */
export const parseSymbol = (raw) => {
  const s = String(raw || '').toUpperCase().replace(/\s+/g, '');
  const m = s.match(/^([A-Z0-9]{2,12})[/_-]?([A-Z]{3,5})$/);
  if (!m) throw new MarketError('Unknown market');
  const [, base, quote] = m;
  const kind = FIAT.has(base) && FIAT.has(quote) ? 'forex' : 'crypto';
  return { symbol: `${base}/${quote}`, base, quote, kind };
};

async function fxRates() {
  if (fxCache.rates && Date.now() - fxCache.at < FX_TTL) return fxCache.rates;
  try {
    const { data } = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 6000 });
    if (data?.rates?.EUR) fxCache = { rates: data.rates, at: Date.now() };
  } catch {
    // keep the last good rates
  }
  if (!fxCache.rates) throw new MarketError('Forex prices are unavailable right now', 503);
  return fxCache.rates;
}

async function binanceTickers(symbols) {
  const now = Date.now();
  const missing = symbols.filter((s) => !(cryptoCache.get(s) && now - cryptoCache.get(s).at < CRYPTO_TTL));
  if (missing.length) {
    const store = (t) => cryptoCache.set(t.symbol, {
      price: Number(t.lastPrice), change: Number(t.priceChangePercent),
      high: Number(t.highPrice), low: Number(t.lowPrice), volume: Number(t.quoteVolume), at: now
    });
    try {
      const data = await binanceGet('/api/v3/ticker/24hr', { symbols: JSON.stringify(missing) });
      for (const t of Array.isArray(data) ? data : []) store(t);
    } catch (err) {
      if (err?.response?.status === 400 && missing.length > 1) {
        // Binance rejects the whole batch if one symbol is unknown; fall back to one by one.
        await Promise.all(missing.map((s) => binanceTickers([s]).catch(() => null)));
      } else if (err?.response?.status !== 400) {
        // Binance unreachable from this server: use Coinbase so trading keeps working.
        const got = await Promise.all(missing.map((s) => coinbaseTicker(s)));
        got.filter(Boolean).forEach(store);
      }
    }
  }
  return Object.fromEntries(symbols.map((s) => [s, cryptoCache.get(s)]).filter(([, v]) => v));
}

// Fixed prices for automated tests only (ignored outside NODE_ENV=test).
const testOverrides = new Map();
export const setTestPrice = (symbol, price) => {
  if (process.env.NODE_ENV === 'test') testOverrides.set(parseSymbol(symbol).symbol, price);
};

/** Quotes for several symbols: { 'BTC/USDT': { price, change, ... } }. Unknown symbols are omitted. */
export async function getQuotes(rawSymbols) {
  const parsed = [];
  for (const r of rawSymbols.slice(0, 60)) {
    try { parsed.push(parseSymbol(r)); } catch { /* skip */ }
  }
  const out = {};
  if (process.env.NODE_ENV === 'test' && testOverrides.size) {
    for (const p of parsed) {
      if (testOverrides.has(p.symbol)) out[p.symbol] = { ...p, price: testOverrides.get(p.symbol), change: 0, source: 'test', at: Date.now() };
    }
    return out;
  }
  const needFx = parsed.some((p) => p.kind === 'forex' || !STABLE.has(p.quote));
  const rates = needFx ? await fxRates().catch(() => null) : null;

  const binanceWanted = [...new Set(parsed.filter((p) => p.kind === 'crypto').map((p) => `${p.base}USDT`))];
  const tickers = binanceWanted.length ? await binanceTickers(binanceWanted) : {};

  for (const p of parsed) {
    if (p.kind === 'forex') {
      if (!rates || !rates[p.base] || !rates[p.quote]) continue;
      const price = rates[p.quote] / rates[p.base];
      out[p.symbol] = { ...p, price, change: null, source: 'fx', at: fxCache.at };
    } else {
      const t = tickers[`${p.base}USDT`];
      if (!t) continue;
      let price = t.price;
      if (!STABLE.has(p.quote)) {
        if (!rates?.[p.quote]) continue;
        price *= rates[p.quote];
      }
      out[p.symbol] = { ...p, price, change: t.change, high: t.high, low: t.low, volume: t.volume, source: 'binance', at: t.at };
    }
  }
  return out;
}

export async function getQuote(raw) {
  const p = parseSymbol(raw);
  const q = (await getQuotes([p.symbol]))[p.symbol];
  if (!q || !(q.price > 0)) throw new MarketError(`No live price for ${p.symbol} right now`, 503);
  return q;
}
