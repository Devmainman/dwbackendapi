// Crypto catalog and live prices for the crypto wallets.
//   Catalog: 83 popular coins, installed once (the admin sets addresses and turns them on).
//   Prices:  Binance 24h tickers (USDT pairs), cached 20 s; Coinbase as a fallback per coin.
//            USDT is 1 USD. Prices are USD and converted to the user's currency with live FX.
import { CryptoAsset } from '../models/Crypto.js';
import Setting from '../models/Setting.js';
import { binanceGet, coinbaseTicker } from './binance.js';
import { rateBetween } from './fx.js';

const ICON = (s) => `https://assets.coincap.io/assets/icons/${s.toLowerCase()}@2x.png`;
const NO_COINCAP_ICON = new Set(['S', 'GMX', 'IOTA']);

/** [symbol, name, network] — the usual deposit network for each coin. */
export const CRYPTO_CATALOG = [
  ['BTC', 'Bitcoin', 'Bitcoin'], ['ETH', 'Ethereum', 'ERC-20'], ['USDT', 'Tether', 'TRC-20'], ['BNB', 'BNB', 'BEP-20'],
  ['SOL', 'Solana', 'Solana'], ['XRP', 'XRP', 'XRP Ledger'], ['USDC', 'USD Coin', 'ERC-20'], ['ADA', 'Cardano', 'Cardano'],
  ['DOGE', 'Dogecoin', 'Dogecoin'], ['TRX', 'TRON', 'TRC-20'], ['TON', 'Toncoin', 'TON'], ['AVAX', 'Avalanche', 'C-Chain'],
  ['SHIB', 'Shiba Inu', 'ERC-20'], ['DOT', 'Polkadot', 'Polkadot'], ['LINK', 'Chainlink', 'ERC-20'], ['BCH', 'Bitcoin Cash', 'Bitcoin Cash'],
  ['LTC', 'Litecoin', 'Litecoin'], ['POL', 'Polygon', 'Polygon'], ['NEAR', 'NEAR Protocol', 'NEAR'], ['UNI', 'Uniswap', 'ERC-20'],
  ['ICP', 'Internet Computer', 'ICP'], ['APT', 'Aptos', 'Aptos'], ['ETC', 'Ethereum Classic', 'Ethereum Classic'], ['XLM', 'Stellar', 'Stellar'],
  ['FIL', 'Filecoin', 'Filecoin'], ['ATOM', 'Cosmos', 'Cosmos'], ['HBAR', 'Hedera', 'Hedera'], ['ARB', 'Arbitrum', 'Arbitrum One'],
  ['OP', 'Optimism', 'Optimism'], ['IMX', 'Immutable', 'ERC-20'], ['INJ', 'Injective', 'Injective'], ['VET', 'VeChain', 'VeChain'],
  ['AAVE', 'Aave', 'ERC-20'], ['GRT', 'The Graph', 'ERC-20'], ['RENDER', 'Render', 'Solana'], ['ALGO', 'Algorand', 'Algorand'],
  ['SAND', 'The Sandbox', 'ERC-20'], ['MANA', 'Decentraland', 'ERC-20'], ['AXS', 'Axie Infinity', 'ERC-20'], ['THETA', 'Theta Network', 'Theta'],
  ['S', 'Sonic', 'Sonic'], ['EGLD', 'MultiversX', 'MultiversX'], ['XTZ', 'Tezos', 'Tezos'], ['EOS', 'EOS', 'EOS'],
  ['CHZ', 'Chiliz', 'Chiliz'], ['KAVA', 'Kava', 'Kava'], ['ZEC', 'Zcash', 'Zcash'], ['DASH', 'Dash', 'Dash'],
  ['NEO', 'NEO', 'NEO N3'], ['CAKE', 'PancakeSwap', 'BEP-20'], ['CRV', 'Curve DAO', 'ERC-20'], ['LDO', 'Lido DAO', 'ERC-20'],
  ['SUI', 'Sui', 'Sui'], ['PEPE', 'Pepe', 'ERC-20'], ['FET', 'Artificial Superintelligence Alliance', 'ERC-20'], ['QNT', 'Quant', 'ERC-20'],
  ['SEI', 'Sei', 'Sei'], ['TIA', 'Celestia', 'Celestia'], ['JUP', 'Jupiter', 'Solana'], ['WIF', 'dogwifhat', 'Solana'],
  ['BONK', 'Bonk', 'Solana'], ['FLOKI', 'Floki', 'BEP-20'], ['STX', 'Stacks', 'Stacks'], ['RUNE', 'THORChain', 'THORChain'],
  ['MKR', 'Maker', 'ERC-20'], ['GALA', 'Gala', 'ERC-20'], ['ENS', 'Ethereum Name Service', 'ERC-20'], ['SNX', 'Synthetix', 'ERC-20'],
  ['1INCH', '1inch', 'ERC-20'], ['COMP', 'Compound', 'ERC-20'], ['ZIL', 'Zilliqa', 'Zilliqa'], ['ONE', 'Harmony', 'Harmony'],
  ['KSM', 'Kusama', 'Kusama'], ['DYDX', 'dYdX', 'dYdX Chain'], ['GMX', 'GMX', 'Arbitrum One'], ['FLOW', 'Flow', 'Flow'],
  ['MINA', 'Mina', 'Mina'], ['ROSE', 'Oasis', 'Oasis'], ['IOTA', 'IOTA', 'IOTA'], ['XMR', 'Monero', 'Monero'],
  ['WLD', 'Worldcoin', 'Optimism'], ['PENDLE', 'Pendle', 'ERC-20'], ['JASMY', 'JasmyCoin', 'ERC-20']
];

/** Install any catalog coin that isn't in the database yet (runs on every start; cheap). */
let installed = false;
export async function ensureCryptoCatalog() {
  if (installed) return;
  const existing = new Set((await CryptoAsset.find().select('symbol').lean()).map((a) => a.symbol));
  const missing = CRYPTO_CATALOG.filter(([s]) => !existing.has(s));
  if (missing.length) {
    await CryptoAsset.insertMany(missing.map(([symbol, name, network]) => ({
      symbol, name, network,
      icon: NO_COINCAP_ICON.has(symbol) ? '' : ICON(symbol),
      sortOrder: CRYPTO_CATALOG.findIndex(([s]) => s === symbol),
      enabled: false
    })), { ordered: false }).catch(() => {});
  }
  installed = true;
}

/* ------------------------------ prices ------------------------------ */

const TTL = 20 * 1000;
let cache = { at: 0, prices: {} };   // symbol -> { usd, change24h, at }
let pending = null;

/** Live USD prices for every catalog coin: { BTC: { usd, change24h, at }, ... }. */
export async function getCryptoPrices() {
  if (Date.now() - cache.at < TTL && Object.keys(cache.prices).length) return cache.prices;
  if (pending) return pending;
  pending = (async () => {
    const pairs = CRYPTO_CATALOG.map(([s]) => s).filter((s) => s !== 'USDT').map((s) => `${s}USDT`);
    const prices = { USDT: { usd: 1, change24h: 0, at: Date.now() } };
    try {
      const data = await binanceGet('/api/v3/ticker/24hr', { symbols: JSON.stringify(pairs) }, { timeout: 8000 });
      for (const t of Array.isArray(data) ? data : []) {
        const sym = t.symbol.replace(/USDT$/, '');
        const usd = Number(t.lastPrice);
        if (usd > 0) prices[sym] = { usd, change24h: Number(t.priceChangePercent) || 0, volume: Number(t.quoteVolume) || 0, at: Date.now() };
      }
    } catch (err) {
      console.warn('[crypto] Binance prices failed:', err.message);
    }
    // Anything Binance didn't give us: try Coinbase, then keep the last known price.
    const missing = pairs.map((p) => p.replace(/USDT$/, '')).filter((s) => !prices[s]);
    await Promise.all(missing.map(async (s) => {
      const t = await coinbaseTicker(`${s}USDT`);
      if (t) prices[s] = { usd: t.lastPrice, change24h: t.priceChangePercent, at: Date.now() };
      else if (cache.prices[s]) prices[s] = cache.prices[s];
    }));
    cache = { at: Date.now(), prices };
    return prices;
  })().finally(() => { pending = null; });
  return pending;
}

/** Price of one coin in `currency` (per coin). Throws when no live price is available. */
export async function priceIn(symbol, currency) {
  const prices = await getCryptoPrices();
  const p = prices[String(symbol).toUpperCase()];
  if (!p || !(p.usd > 0)) {
    const err = new Error(`No live price for ${symbol} right now. Please try again shortly.`);
    err.status = 503;
    throw err;
  }
  const fx = currency && currency !== 'USD' ? await rateBetween('USD', currency) : 1;
  return { price: p.usd * fx, usd: p.usd, change24h: p.change24h, at: p.at, fx };
}

/* ------------------------------ settings ------------------------------ */

export async function cryptoSettings() {
  const s = await Setting.findOne().select('cryptoDeposits').lean();
  const c = s?.cryptoDeposits || {};
  return { enabled: c.enabled !== false, convertEnabled: c.convertEnabled !== false, convertFeePercent: Number(c.convertFeePercent) || 0 };
}

/* ------------------------------ 7-day sparklines ------------------------------ */

const SPARK_TTL = 10 * 60 * 1000;
const sparkCache = new Map(); // symbol -> { at, points }

/** Last 7 days of closing prices (USD, every 4 h) for up to 30 catalog coins. */
export async function getSparklines(symbols) {
  const known = new Set(CRYPTO_CATALOG.map(([s]) => s));
  const list = [...new Set(symbols.map((s) => String(s).toUpperCase()))].filter((s) => known.has(s)).slice(0, 30);
  const out = {};
  await Promise.all(list.map(async (s) => {
    if (s === 'USDT') { out[s] = Array(42).fill(1); return; }
    const hit = sparkCache.get(s);
    if (hit && Date.now() - hit.at < SPARK_TTL) { out[s] = hit.points; return; }
    try {
      const rows = await binanceGet('/api/v3/klines', { symbol: `${s}USDT`, interval: '4h', limit: 42 }, { timeout: 8000 });
      const points = (Array.isArray(rows) ? rows : []).map((r) => Number(r[4])).filter((n) => n > 0);
      if (points.length > 1) { sparkCache.set(s, { at: Date.now(), points }); out[s] = points; }
    } catch {
      if (hit) out[s] = hit.points; // keep the last good line rather than none
    }
  }));
  return out;
}

/* ------------------------------ price history by range ------------------------------ */

const RANGES = { '1d': ['15m', 96, 2 * 60 * 1000], '1w': ['1h', 168, 5 * 60 * 1000], '1m': ['4h', 180, 15 * 60 * 1000], '1y': ['1d', 365, 60 * 60 * 1000] };
const histCache = new Map(); // `${symbol}:${range}` -> { at, points: [[time, close], ...] }

/** Closing prices (USD) for up to 12 catalog coins over 1d / 1w / 1m / 1y. */
export async function getHistory(symbols, range = '1w') {
  const [interval, limit, ttl] = RANGES[range] || RANGES['1w'];
  const known = new Set(CRYPTO_CATALOG.map(([s]) => s));
  const list = [...new Set(symbols.map((s) => String(s).toUpperCase()))].filter((s) => known.has(s)).slice(0, 12);
  const out = {};
  await Promise.all(list.map(async (s) => {
    const key = `${s}:${range}`;
    const hit = histCache.get(key);
    if (hit && Date.now() - hit.at < ttl) { out[s] = hit.points; return; }
    if (s === 'USDT') {
      const step = { '15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5 }[interval];
      const now = Date.now();
      out[s] = Array.from({ length: limit }, (_, i) => [now - (limit - 1 - i) * step, 1]);
      return;
    }
    try {
      const rows = await binanceGet('/api/v3/klines', { symbol: `${s}USDT`, interval, limit }, { timeout: 8000 });
      const points = (Array.isArray(rows) ? rows : []).map((r) => [Number(r[6]), Number(r[4])]).filter(([, c]) => c > 0);
      if (points.length > 1) { histCache.set(key, { at: Date.now(), points }); out[s] = points; }
    } catch {
      if (hit) out[s] = hit.points;
    }
  }));
  return { range: RANGES[range] ? range : '1w', interval, series: out };
}
