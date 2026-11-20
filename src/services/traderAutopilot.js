// Copy-trading autopilot: trades a Trader automatically from live market data.
//
// Every run (each minute, from the periodic jobs), for each trader with autopilot on:
//   1. Open trades are checked against the LIVE price and closed on take-profit,
//      stop-loss, maximum hold time, or when the strategy's signal turns against them.
//   2. If there is room for more trades, each configured symbol is scanned on real
//      Binance candles (EMA 9/21 and RSI 14) and a trade is opened at the LIVE price
//      when the strategy gives a signal.
// Trades go through the normal copy-trading engine, so they are mirrored to every
// copier, settled at the same exit price, and the trader's statistics (ROI, win rate,
// closed trades, drawdown, profit) are recomputed from the real results.
import Trader from '../models/Trader.js';
import MasterTrade from '../models/MasterTrade.js';
import { binanceGet } from './binance.js';
import { getQuote } from './marketData.js';
import { openMasterTrade, closeMasterTrade, updateMarkPrice, recomputeTraderStats } from './copyTradingEngine.js';

const KLINE_TTL = 50 * 1000;
const klineCache = new Map(); // `${symbol}|${interval}` -> { at, closes }

const toBinance = (symbol) => String(symbol).toUpperCase().replace(/[/_-]/g, '').replace(/USD$/, 'USDT');
export const normalizeSymbol = (raw) => {
  const s = String(raw || '').toUpperCase().replace(/\s+/g, '');
  const m = s.match(/^([A-Z0-9]{2,10})[/_-]?(USDT|USDC|USD)$/);
  return m ? `${m[1]}/USDT` : null;
};

async function closes(symbol, interval) {
  const key = `${symbol}|${interval}`;
  const hit = klineCache.get(key);
  if (hit && Date.now() - hit.at < KLINE_TTL) return hit.closes;
  const data = await binanceGet('/api/v3/klines', { symbol: toBinance(symbol), interval, limit: 120 }, { timeout: 8000 });
  const list = (Array.isArray(data) ? data : []).map((k) => Number(k[4])).filter((n) => n > 0);
  if (list.length < 30) throw new Error(`Not enough market data for ${symbol}`);
  klineCache.set(key, { at: Date.now(), closes: list });
  return list;
}

const ema = (values, period) => {
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i += 1) e = values[i] * k + e * (1 - k);
  return e;
};

const rsi = (values, period = 14) => {
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < values.length; i += 1) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
};

/** Indicators on real candles plus the strategy's view: 'buy', 'sell' or null. */
export async function analyse(symbol, { strategy = 'trend', timeframe = '15m' } = {}) {
  const c = await closes(symbol, timeframe);
  const last = c[c.length - 1];
  const fast = ema(c, 9);
  const slow = ema(c, 21);
  const r = rsi(c, 14);
  let signal = null;
  if (strategy === 'reversal') {
    if (r < 30) signal = 'buy';
    else if (r > 70) signal = 'sell';
  } else {
    if (fast > slow && last > fast && r >= 50 && r <= 70) signal = 'buy';
    else if (fast < slow && last < fast && r >= 30 && r <= 50) signal = 'sell';
  }
  // Signal against an open trade (used to exit early).
  const against = (side) => (strategy === 'reversal'
    ? (side === 'buy' ? r > 60 : r < 40)
    : (side === 'buy' ? fast < slow : fast > slow));
  return { last, fast, slow, rsi: r, signal, against };
}

const fmt = (n) => (n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toPrecision(4));

/** One autopilot pass for one trader. Returns what it did. */
export async function runTrader(trader) {
  const cfg = trader.autoTrading || {};
  const actions = [];
  const log = (text) => actions.push({ at: new Date(), text });
  const open = await MasterTrade.find({ traderId: trader.traderId, status: 'open' }).lean();

  // 1. Manage open trades at the live price.
  for (const t of open) {
    try {
      const q = await getQuote(t.symbol);
      const price = q.price;
      await updateMarkPrice({ masterTradeId: t._id, price });
      const dir = t.side === 'sell' ? -1 : 1;
      const movePct = ((price - t.entryPrice) / t.entryPrice) * 100 * dir;
      const heldHours = (Date.now() - new Date(t.openedAt).getTime()) / 3600e3;
      let reason = null;
      if (movePct >= cfg.takeProfitPercent) reason = 'take_profit';
      else if (movePct <= -cfg.stopLossPercent) reason = 'stop_loss';
      else if (heldHours >= cfg.maxHoldHours) reason = 'max_hold';
      else if (t.source === 'auto') {
        const a = await analyse(t.symbol, cfg).catch(() => null);
        if (a?.against(t.side)) reason = 'signal';
      }
      if (reason) {
        const { master, settled } = await closeMasterTrade(t._id, price, { reason });
        log(`Closed ${t.side.toUpperCase()} ${t.symbol} at ${fmt(price)} (${reason.replace('_', ' ')}): ${master.pnlPercent >= 0 ? '+' : ''}${master.pnlPercent.toFixed(2)}%, ${settled} copier position(s) settled`);
      }
    } catch (err) {
      log(`Could not check ${t.symbol}: ${err.message}`);
    }
  }

  // 2. Look for new entries.
  const stillOpen = await MasterTrade.find({ traderId: trader.traderId, status: 'open' }).select('symbol').lean();
  let room = (cfg.maxOpenTrades || 1) - stillOpen.length;
  const busy = new Set(stillOpen.map((t) => t.symbol));
  for (const raw of cfg.symbols || []) {
    if (room <= 0) break;
    const symbol = normalizeSymbol(raw);
    if (!symbol || busy.has(symbol)) continue;
    if (cfg.cooldownMinutes > 0) {
      const recent = await MasterTrade.exists({ traderId: trader.traderId, symbol, status: 'closed', closedAt: { $gt: new Date(Date.now() - cfg.cooldownMinutes * 60e3) } });
      if (recent) continue;
    }
    try {
      const a = await analyse(symbol, cfg);
      if (!a.signal) continue;
      const q = await getQuote(symbol);
      const master = await openMasterTrade(trader, {
        symbol, side: a.signal, entryPrice: q.price,
        allocationPercent: cfg.allocationPercent, leverage: cfg.leverage, source: 'auto',
        notes: `Autopilot (${cfg.strategy}, ${cfg.timeframe}): EMA9 ${fmt(a.fast)} / EMA21 ${fmt(a.slow)}, RSI ${a.rsi.toFixed(1)}`
      });
      busy.add(symbol);
      room -= 1;
      log(`Opened ${a.signal.toUpperCase()} ${symbol} at ${fmt(q.price)} (RSI ${a.rsi.toFixed(1)}), copied to ${master.copiedCount} copier(s)`);
    } catch (err) {
      log(`Could not scan ${symbol}: ${err.message}`);
    }
  }

  // 3. Statistics follow the real results (also rolls the daily/weekly/monthly windows).
  await recomputeTraderStats(trader.traderId);
  const nowOpen = await MasterTrade.countDocuments({ traderId: trader.traderId, status: 'open' });
  const failed = actions.length && actions.every((a) => a.text.startsWith('Could not'));
  await Trader.updateOne({ _id: trader._id }, {
    $set: {
      'autoTrading.state': failed ? 'error' : nowOpen ? 'in_trade' : 'scanning',
      'autoTrading.lastRunAt': new Date(),
      'autoTrading.lastError': failed ? actions[actions.length - 1].text : '',
      lastActive: new Date()
    },
    ...(actions.length ? { $push: { 'autoTrading.log': { $each: actions, $slice: -60 } } } : {})
  });
  return actions;
}

const RUN_EVERY_MS = 60 * 1000;
let running = null;

/** Periodic job: every trader whose autopilot is on and due. Each trader is claimed so it never runs twice at once. */
export function runTraderAutopilots({ traderId, force = false } = {}) {
  if (running && !traderId) return running;
  const job = (async () => {
    const now = new Date();
    const filter = { 'autoTrading.enabled': true, isActive: true, ...(traderId ? { traderId } : {}) };
    if (!force) filter.$or = [{ 'autoTrading.nextRunAt': null }, { 'autoTrading.nextRunAt': { $lte: now } }];
    const due = await Trader.find(filter).select('_id').limit(100).lean();
    const results = [];
    for (const { _id } of due) {
      const claimed = await Trader.findOneAndUpdate(
        { _id, 'autoTrading.enabled': true, ...(force ? {} : { $or: [{ 'autoTrading.nextRunAt': null }, { 'autoTrading.nextRunAt': { $lte: now } }] }) },
        { $set: { 'autoTrading.nextRunAt': new Date(now.getTime() + RUN_EVERY_MS - 2000) } },
        { new: true }
      ).lean();
      if (!claimed) continue;
      try {
        results.push({ traderId: claimed.traderId, actions: await runTrader(claimed) });
      } catch (err) {
        await Trader.updateOne({ _id }, { $set: { 'autoTrading.state': 'error', 'autoTrading.lastError': err.message } });
        results.push({ traderId: claimed.traderId, error: err.message });
      }
    }
    return { traders: due.length, results };
  })();
  if (!traderId) running = job.finally(() => { running = null; });
  return job;
}
