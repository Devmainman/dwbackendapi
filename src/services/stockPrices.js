// Live stock prices for Investing.
//   Quotes:  Yahoo Finance chart API (two hosts), then Nasdaq as a fallback. No API key.
//   History: one year of real daily closes from Yahoo, kept up to date day by day.
// Stocks with priceSource 'live' are refreshed by the periodic jobs (and when a
// user opens Investing). Prices are stored in the platform base currency.
import axios from 'axios';
import { StockAsset } from '../models/Stock.js';
import Setting from '../models/Setting.js';
import { getBaseCurrency, rateBetween } from './fx.js';

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', Accept: 'application/json' };
const YAHOO = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const FRESH_MS = 60 * 1000;          // a live price is refreshed at most once a minute
const HISTORY_DAYS = 365;

const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

async function yahooChart(symbol, params) {
  let lastErr;
  for (const host of YAHOO) {
    try {
      const { data } = await axios.get(`${host}/v8/finance/chart/${encodeURIComponent(symbol)}`, { params, headers: UA, timeout: 8000 });
      const r = data?.chart?.result?.[0];
      if (r?.meta?.regularMarketPrice > 0) return r;
      lastErr = new Error(data?.chart?.error?.description || 'No price');
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function nasdaqQuote(symbol) {
  const { data } = await axios.get(`https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/info`, { params: { assetclass: 'stocks' }, headers: UA, timeout: 8000 });
  const p = data?.data?.primaryData;
  const num = (v) => Number(String(v || '').replace(/[$,%+]/g, ''));
  const price = num(p?.lastSalePrice);
  if (!(price > 0)) throw new Error('No price from Nasdaq');
  const change = num(p?.netChange);
  return { price, previousClose: Number.isFinite(change) ? price - change : price, currency: 'USD', name: data?.data?.companyName || '', dayHigh: 0, dayLow: 0, source: 'nasdaq' };
}

/** Current quote for one symbol, in the quote's own currency. */
export async function fetchQuote(symbol) {
  try {
    const r = await yahooChart(symbol, { interval: '5m', range: '1d' });
    const m = r.meta;
    return {
      price: m.regularMarketPrice,
      previousClose: m.chartPreviousClose || m.previousClose || m.regularMarketPrice,
      currency: m.currency || 'USD',
      name: m.longName || m.shortName || '',
      exchange: m.fullExchangeName || m.exchangeName || '',
      dayHigh: m.regularMarketDayHigh || 0,
      dayLow: m.regularMarketDayLow || 0,
      source: 'yahoo'
    };
  } catch (yahooErr) {
    try {
      return await nasdaqQuote(symbol);
    } catch {
      throw new Error(`No live price for ${symbol} (${yahooErr.message || 'unavailable'})`);
    }
  }
}

/** One year of daily closes: [{ price, at }]. */
export async function fetchHistory(symbol) {
  const r = await yahooChart(symbol, { interval: '1d', range: '1y' });
  const ts = r.timestamp || [];
  const closes = r.indicators?.quote?.[0]?.close || [];
  return ts.map((t, i) => ({ price: closes[i], at: new Date(t * 1000) })).filter((p) => p.price > 0).slice(-HISTORY_DAYS);
}

const sameDay = (a, b) => new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10);

/** Fetch and store the live price of one stock document. Returns true when updated. */
export async function refreshStock(stock, base) {
  try {
    const q = await fetchQuote(stock.symbol);
    const rate = await rateBetween(q.currency || 'USD', base);
    const price = round(q.price * rate);
    const set = {
      price,
      previousClose: round(q.previousClose * rate),
      dayHigh: round((q.dayHigh || 0) * rate),
      dayLow: round((q.dayLow || 0) * rate),
      quoteCurrency: q.currency || 'USD',
      lastPriceAt: new Date(),
      priceError: ''
    };
    // Daily history: today's point follows the live price; a new day adds a point.
    const hist = stock.priceHistory || [];
    const last = hist[hist.length - 1];
    const update = last && sameDay(last.at, new Date())
      ? { $set: { ...set, [`priceHistory.${hist.length - 1}`]: { price, at: new Date() } } }
      : { $set: set, $push: { priceHistory: { $each: [{ price, at: new Date() }], $slice: -HISTORY_DAYS } } };
    // First live update of a stock that had typed-in prices: replace its history with the real one.
    if (!stock.lastPriceAt) {
      const history = await fetchHistory(stock.symbol).catch(() => []);
      if (history.length) {
        await StockAsset.updateOne({ _id: stock._id, priceSource: { $ne: 'manual' } }, { $set: { ...set, priceSource: 'live', priceHistory: history.map((h) => ({ price: round(h.price * rate), at: h.at })) } });
        return true;
      }
    }
    await StockAsset.updateOne({ _id: stock._id, priceSource: { $ne: 'manual' } }, { ...update, $set: { ...update.$set, priceSource: 'live' } });
    return true;
  } catch (err) {
    await StockAsset.updateOne({ _id: stock._id }, { $set: { priceError: String(err.message).slice(0, 200) } });
    return false;
  }
}

let refreshing = null;
/** Refresh every live stock whose price is older than a minute (or all, with force). */
export function refreshStockPrices({ force = false } = {}) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const cutoff = new Date(Date.now() - FRESH_MS);
    const filter = { priceSource: { $ne: 'manual' }, isActive: true, ...(force ? {} : { $or: [{ lastPriceAt: null }, { lastPriceAt: { $lt: cutoff } }] }) };
    const stocks = await StockAsset.find(filter).select('symbol priceHistory lastPriceAt').lean();
    if (!stocks.length) return { checked: 0, updated: 0 };
    const base = await getBaseCurrency();
    let updated = 0;
    for (let i = 0; i < stocks.length; i += 5) {
      // eslint-disable-next-line no-await-in-loop
      const r = await Promise.all(stocks.slice(i, i + 5).map((s) => refreshStock(s, base)));
      updated += r.filter(Boolean).length;
    }
    return { checked: stocks.length, updated };
  })().finally(() => { refreshing = null; });
  return refreshing;
}

/** Popular US stocks installed once on a new platform. Prices and history come from the market. */
export const POPULAR_STOCKS = [
  ['AAPL', 'Technology'], ['MSFT', 'Technology'], ['NVDA', 'Technology'], ['GOOGL', 'Communication'], ['AMZN', 'Consumer'],
  ['META', 'Communication'], ['TSLA', 'Automotive'], ['AVGO', 'Technology'], ['AMD', 'Technology'], ['NFLX', 'Communication'],
  ['JPM', 'Financials'], ['V', 'Financials'], ['MA', 'Financials'], ['WMT', 'Consumer'], ['KO', 'Consumer'],
  ['DIS', 'Communication'], ['NKE', 'Consumer'], ['INTC', 'Technology'], ['PYPL', 'Financials'], ['BA', 'Industrials']
];

/** Add one stock from the market by symbol (real name, price and one-year history). */
export async function installStock(symbol, sector = '') {
  const sym = String(symbol).toUpperCase();
  if (await StockAsset.exists({ symbol: sym })) return { symbol: sym, status: 'exists' };
  const [q, history, base] = await Promise.all([fetchQuote(sym), fetchHistory(sym).catch(() => []), getBaseCurrency()]);
  const rate = await rateBetween(q.currency || 'USD', base);
  await StockAsset.create({
    symbol: sym,
    name: q.name || sym,
    exchange: (q.exchange || 'NASDAQ').replace(/GS$|GM$|CM$/, ''),
    sector: sector || 'Other',
    price: round(q.price * rate),
    previousClose: round(q.previousClose * rate),
    dayHigh: round((q.dayHigh || 0) * rate),
    dayLow: round((q.dayLow || 0) * rate),
    quoteCurrency: q.currency || 'USD',
    priceSource: 'live',
    lastPriceAt: new Date(),
    priceHistory: history.length ? history.map((h) => ({ price: round(h.price * rate), at: h.at })) : [{ price: round(q.price * rate), at: new Date() }]
  });
  return { symbol: sym, status: 'installed' };
}

/** Install the popular list once per platform (later runs skip it, so admin removals stick). */
let seeded = false;
export async function ensureDefaultStocks({ force = false } = {}) {
  if (seeded && !force) return null;
  const s = await Setting.findOne().select('flags').lean();
  if (s?.flags?.stocksSeeded && !force) { seeded = true; return null; }
  const results = [];
  for (const [sym, sector] of POPULAR_STOCKS) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await installStock(sym, sector).catch((err) => ({ symbol: sym, status: 'failed', error: err.message })));
  }
  if (results.some((r) => r.status !== 'failed')) {
    await Setting.updateOne({}, { $set: { 'flags.stocksSeeded': true } }, { upsert: true });
    seeded = true;
  }
  return results;
}
