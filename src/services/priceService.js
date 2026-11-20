// USD prices for crypto assets, from Binance's public ticker with a short cache.
// Falls back to an admin-set price when an asset isn't listed or the API is unreachable.
import { binanceGet } from './binance.js';
import { safeRateBetween } from './fx.js';
import { round2 } from '../utils/money.js';

const STABLE = new Set(['USD', 'USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'FDUSD']);
const TTL_MS = 60 * 1000;
const cache = new Map(); // asset -> { price, at }

/** Live USD price for one asset, or `fallback` (may be null) when unavailable. */
export const getUsdPrice = async (asset, fallback = null) => {
  const sym = String(asset || '').toUpperCase();
  if (STABLE.has(sym)) return 1;
  if (process.env.PRICE_FEED === 'off') return fallback;
  const hit = cache.get(sym);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.price;
  try {
    const data = await binanceGet('/api/v3/ticker/price', { symbol: `${sym}USDT` }, { timeout: 5000 });
    const price = Number(data?.price);
    if (price > 0) {
      cache.set(sym, { price, at: Date.now() });
      return price;
    }
  } catch {
    // fall through to the fallback / last known price
  }
  return hit?.price ?? fallback;
};

/** Prices for several assets at once: { AVAX: 24.1, ... } (null where unknown). */
export const getUsdPrices = async (assets, fallbacks = {}) => {
  const out = {};
  await Promise.all([...new Set(assets.map((a) => String(a).toUpperCase()))].map(async (a) => {
    out[a] = await getUsdPrice(a, fallbacks[a] ?? null);
  }));
  return out;
};

/** Convert a USD amount into the user's currency using the shared FX table. */
export const usdToCurrency = async (usd, currency) => {
  const rate = await safeRateBetween("USD", currency || "USD");
  return { amount: round2(usd * rate), rate };
};
