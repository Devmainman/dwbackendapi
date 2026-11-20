// Binance public market data, reachable from any server region.
// api.binance.com answers HTTP 451 to US servers (Vercel's default region), so
// data-api.binance.vision (Binance's market-data-only host, same API) goes first.
// The host that last worked is tried first next time. BINANCE_API_BASE overrides.
import axios from 'axios';

const HOSTS = [
  process.env.BINANCE_API_BASE,
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api-gcp.binance.com',
  'https://api1.binance.com'
].filter(Boolean);

let preferred = 0;

/** GET a Binance public endpoint, e.g. binanceGet('/api/v3/ticker/price', { symbol: 'BTCUSDT' }). */
export async function binanceGet(path, params, { timeout = 6000 } = {}) {
  let lastErr;
  for (let i = 0; i < HOSTS.length; i += 1) {
    const idx = (preferred + i) % HOSTS.length;
    try {
      // eslint-disable-next-line no-await-in-loop
      const { data } = await axios.get(`${HOSTS[idx]}${path}`, { params, timeout });
      preferred = idx;
      return data;
    } catch (err) {
      lastErr = err;
      // A 400 means Binance answered (e.g. unknown symbol): another host won't help.
      if (err?.response?.status === 400) throw err;
    }
  }
  throw lastErr;
}

/**
 * Last-resort 24h ticker from Coinbase for one Binance-style symbol ("BTCUSDT"),
 * shaped like Binance's /ticker/24hr. Returns null when Coinbase has no such market.
 */
export async function coinbaseTicker(binanceSymbol) {
  const base = String(binanceSymbol).replace(/USDT$/, '');
  try {
    const { data } = await axios.get(`https://api.exchange.coinbase.com/products/${base}-USD/stats`, { timeout: 6000 });
    const last = Number(data?.last);
    const open = Number(data?.open);
    if (!(last > 0)) return null;
    return {
      symbol: binanceSymbol,
      lastPrice: last,
      priceChangePercent: open > 0 ? ((last - open) / open) * 100 : 0,
      highPrice: Number(data.high),
      lowPrice: Number(data.low),
      quoteVolume: Number(data.volume) * last
    };
  } catch {
    return null;
  }
}
