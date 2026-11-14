// Live market trading: open long/short positions with your balance at the server's
// market price, optional leverage, take-profit and stop-loss.
import mongoose from 'mongoose';
import MarketPosition from '../models/MarketPosition.js';
import User from '../models/User.js';
import Setting from '../models/Setting.js';
import { parseAmount, round2 } from '../utils/money.js';
import { withTransaction, debitUser, creditUser, recordTransaction, HttpError } from '../utils/wallet.js';
import { handler, loadActiveUser, paging } from '../services/productService.js';
import { notifyUser } from '../services/notificationService.js';
import { getQuote, getQuotes, parseSymbol } from '../services/marketData.js';
import { usdToCurrency } from '../services/priceService.js';

const MAX_LEVERAGE = 20;
const MAX_OPEN = 50;

/** Leveraged return on margin in % at `price`, floored at -100. */
export const pnlPercentAt = (p, price) => {
  const dir = p.side === 'short' ? -1 : 1;
  const pct = ((price - p.entryPrice) / p.entryPrice) * dir * p.leverage * 100;
  return Math.max(-100, pct);
};

const live = (p, price) => {
  const pct = pnlPercentAt(p, price);
  return {
    ...(p.toObject ? p.toObject() : p),
    id: p._id,
    currentPrice: price,
    unrealizedPnl: round2((p.margin * pct) / 100),
    unrealizedPercent: round2(pct),
    value: round2(p.margin + (p.margin * pct) / 100)
  };
};

/** Trading signal rule kept from the platform: admin sets a per-trade signal cost. */
const takeSignal = async (user, session) => {
  const settings = await Setting.findOne().select('signalStrength').lean();
  if (!settings) return 0;
  const cost = Number(settings.signalStrength?.trading) || 0;
  if (cost <= 0) throw new HttpError(403, 'Trading is currently disabled');
  const ok = await User.updateOne(
    { _id: user._id, tradingSignalStrength: { $gte: cost } },
    { $inc: { tradingSignalStrength: -cost }, $set: { tradingSignalUpdatedAt: new Date() } },
    { session }
  );
  if (ok.modifiedCount !== 1) throw new HttpError(400, `Not enough signal strength (needs ${cost}%)`);
  return cost;
};

/** GET /api/trading/market/quotes?symbols=BTC/USDT,EUR/USD */
export const quotes = handler(async (req, res) => {
  const symbols = String(req.query.symbols || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!symbols.length) throw new HttpError(400, 'symbols is required');
  const user = await User.findById(req.user.id).select('currency').lean();
  const [q, fx] = await Promise.all([getQuotes(symbols), usdToCurrency(1, user?.currency || 'USD')]);
  res.json({ success: true, data: { quotes: q, currency: user?.currency || 'USD', usdRate: fx.rate, at: Date.now() } });
});

/** POST /api/trading/market/open  { symbol, side: 'buy'|'sell', amount, leverage?, takeProfit?, stopLoss? } */
export const openPosition = handler(async (req, res) => {
  const margin = parseAmount(req.body.amount);
  if (margin === null) throw new HttpError(400, 'Enter an amount to trade');
  const side = req.body.side === 'sell' || req.body.side === 'short' ? 'short' : 'long';
  const leverage = req.body.leverage === undefined ? 1 : Math.floor(Number(req.body.leverage));
  if (!(leverage >= 1 && leverage <= MAX_LEVERAGE)) throw new HttpError(400, `Leverage must be between 1x and ${MAX_LEVERAGE}x`);

  const { symbol } = parseSymbol(req.body.symbol);
  const user = await loadActiveUser(req.user.id);
  const openCount = await MarketPosition.countDocuments({ user: user._id, status: 'open' });
  if (openCount >= MAX_OPEN) throw new HttpError(400, `You can have at most ${MAX_OPEN} open positions`);

  const q = await getQuote(symbol);
  const entry = q.price;
  const tp = req.body.takeProfit ? Number(req.body.takeProfit) : null;
  const sl = req.body.stopLoss ? Number(req.body.stopLoss) : null;
  if (tp !== null && !(tp > 0 && (side === 'long' ? tp > entry : tp < entry))) {
    throw new HttpError(400, side === 'long' ? 'Take profit must be above the current price' : 'Take profit must be below the current price');
  }
  if (sl !== null && !(sl > 0 && (side === 'long' ? sl < entry : sl > entry))) {
    throw new HttpError(400, side === 'long' ? 'Stop loss must be below the current price' : 'Stop loss must be above the current price');
  }
  const liquidationPrice = side === 'long' ? entry * (1 - 1 / leverage) : entry * (1 + 1 / leverage);

  const position = await withTransaction(async (session) => {
    await takeSignal(user, session);
    await debitUser(user._id, margin, { session });
    const [p] = await MarketPosition.create([{
      user: user._id,
      symbol: q.symbol,
      base: q.base,
      quote: q.quote,
      kind: q.kind,
      side,
      margin: round2(margin),
      currency: user.currency,
      leverage,
      entryPrice: entry,
      quantity: (margin * leverage) / entry,
      takeProfit: tp,
      stopLoss: sl,
      liquidationPrice
    }], { session });
    await recordTransaction({
      userId: user._id, amount: margin, currency: user.currency, type: 'trade',
      metadata: { action: 'open_position', symbol: q.symbol, side, leverage, entryPrice: entry, positionId: p._id }, session, prefix: 'MKT'
    });
    return p;
  });

  res.status(201).json({
    success: true,
    message: `${side === 'long' ? 'Bought' : 'Sold'} ${q.symbol} at ${entry}`,
    data: live(position, entry)
  });
});

/** Close a position at `price` exactly once. */
export const closeAt = async (positionId, price, reason) => {
  const result = await withTransaction(async (session) => {
    const p = await MarketPosition.findOneAndUpdate({ _id: positionId, status: 'open' }, { $set: { status: 'closing' } }, { new: true, session });
    if (!p) return null;
    const pct = pnlPercentAt(p, price);
    const pnl = round2((p.margin * pct) / 100);
    const payout = round2(Math.max(0, p.margin + pnl));
    p.status = 'closed';
    p.exitPrice = price;
    p.pnl = pnl;
    p.pnlPercent = round2(pct);
    p.payout = payout;
    p.closeReason = reason;
    p.closedAt = new Date();
    await p.save({ session });
    if (payout > 0) {
      await creditUser(p.user, payout, { session, currency: p.currency });
    }
    await recordTransaction({
      userId: p.user, amount: payout, currency: p.currency, type: 'trade',
      metadata: { action: 'close_position', reason, symbol: p.symbol, side: p.side, exitPrice: price, pnl, positionId: p._id }, session, prefix: 'MKT'
    });
    return p;
  });
  if (result && ['take_profit', 'stop_loss', 'liquidated'].includes(reason)) {
    const label = { take_profit: 'Take profit hit', stop_loss: 'Stop loss hit', liquidated: 'Position liquidated' }[reason];
    await notifyUser(result.user, {
      type: 'trading',
      title: `${label} · ${result.symbol}`,
      content: `${result.side === 'long' ? 'Long' : 'Short'} closed at ${result.exitPrice}. P/L ${result.pnl >= 0 ? '+' : ''}${result.pnl} ${result.currency}.`,
      link: '/trademain',
      dedupeKey: `position-closed:${result._id}`
    });
  }
  return result;
};

/** POST /api/trading/market/positions/:id/close */
export const closePosition = handler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw new HttpError(400, 'Invalid position');
  const p = await MarketPosition.findOne({ _id: req.params.id, user: req.user.id, status: 'open' });
  if (!p) throw new HttpError(404, 'Open position not found');
  const q = await getQuote(p.symbol);
  const closed = await closeAt(p._id, q.price, 'manual');
  if (!closed) throw new HttpError(409, 'Position was already closed');
  res.json({
    success: true,
    message: `Closed ${closed.symbol}: ${closed.pnl >= 0 ? '+' : ''}${closed.pnl} ${closed.currency}`,
    data: closed
  });
});

/** PATCH /api/trading/market/positions/:id  { takeProfit, stopLoss }  (null clears) */
export const updateStops = handler(async (req, res) => {
  const p = await MarketPosition.findOne({ _id: req.params.id, user: req.user.id, status: 'open' });
  if (!p) throw new HttpError(404, 'Open position not found');
  const q = await getQuote(p.symbol);
  for (const key of ['takeProfit', 'stopLoss']) {
    if (req.body[key] === null || req.body[key] === '') p[key] = null;
    else if (req.body[key] !== undefined) {
      const v = Number(req.body[key]);
      const above = (key === 'takeProfit') === (p.side === 'long');
      if (!(v > 0) || (above ? v <= q.price : v >= q.price)) {
        throw new HttpError(400, `${key === 'takeProfit' ? 'Take profit' : 'Stop loss'} must be ${above ? 'above' : 'below'} the current price`);
      }
      p[key] = v;
    }
  }
  await p.save();
  res.json({ success: true, data: live(p, q.price) });
});

/** GET /api/trading/market/positions — open positions with live P/L */
export const listPositions = handler(async (req, res) => {
  const open = await MarketPosition.find({ user: req.user.id, status: 'open' }).sort({ openedAt: -1 });
  const q = open.length ? await getQuotes([...new Set(open.map((p) => p.symbol))]).catch(() => ({})) : {};
  const items = open.map((p) => live(p, q[p.symbol]?.price || p.entryPrice));
  res.json({
    success: true,
    data: {
      positions: items,
      summary: {
        count: items.length,
        margin: round2(items.reduce((s, p) => s + p.margin, 0)),
        unrealizedPnl: round2(items.reduce((s, p) => s + p.unrealizedPnl, 0))
      }
    }
  });
});

/** GET /api/trading/market/history */
export const listHistory = handler(async (req, res) => {
  const { page, limit, skip } = paging(req.query, 30);
  const filter = { user: req.user.id, status: 'closed' };
  const [items, total, agg] = await Promise.all([
    MarketPosition.find(filter).sort({ closedAt: -1 }).skip(skip).limit(limit).lean(),
    MarketPosition.countDocuments(filter),
    MarketPosition.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(req.user.id), status: 'closed' } },
      { $group: { _id: null, pnl: { $sum: '$pnl' }, wins: { $sum: { $cond: [{ $gt: ['$pnl', 0] }, 1, 0] } }, n: { $sum: 1 } } }
    ])
  ]);
  res.json({
    success: true,
    data: {
      items: items.map((i) => ({ ...i, id: i._id })),
      total, page, limit,
      stats: { realizedPnl: round2(agg[0]?.pnl || 0), winRate: agg[0]?.n ? round2((agg[0].wins / agg[0].n) * 100) : 0, trades: agg[0]?.n || 0 }
    }
  });
});

/* -------- background monitor: take-profit, stop-loss, liquidation -------- */

export const checkStops = async () => {
  const open = await MarketPosition.find({ status: 'open' }).select('_id symbol side entryPrice leverage takeProfit stopLoss liquidationPrice').lean();
  if (!open.length) return 0;
  const q = await getQuotes([...new Set(open.map((p) => p.symbol))]).catch(() => ({}));
  let closed = 0;
  for (const p of open) {
    const price = q[p.symbol]?.price;
    if (!(price > 0)) continue;
    const long = p.side === 'long';
    let reason = null;
    if (p.leverage > 1 && (long ? price <= p.liquidationPrice : price >= p.liquidationPrice)) reason = 'liquidated';
    else if (p.stopLoss && (long ? price <= p.stopLoss : price >= p.stopLoss)) reason = 'stop_loss';
    else if (p.takeProfit && (long ? price >= p.takeProfit : price <= p.takeProfit)) reason = 'take_profit';
    if (reason) {
      // eslint-disable-next-line no-await-in-loop
      if (await closeAt(p._id, price, reason).catch((err) => { console.error('Auto-close failed:', err.message); return null; })) closed += 1;
    }
  }
  return closed;
};

export const startStopMonitor = () => {
  const tick = () => checkStops().catch((err) => console.error('Stop monitor:', err.message));
  return setInterval(tick, 10 * 1000);
};

/**
 * The old simulator debited the balance on "buy" but its "sell" never paid
 * anything back. Return the amount of any position still open from that code.
 */
export const migrateLegacySimTrades = async () => {
  const SimulatedTrade = (await import('../models/SimulatedTrade.js')).default;
  const open = await SimulatedTrade.find({ status: 'open' }).select('_id user amount currency').lean();
  let n = 0;
  for (const t of open) {
    // eslint-disable-next-line no-await-in-loop
    await withTransaction(async (session) => {
      const r = await SimulatedTrade.updateOne({ _id: t._id, status: 'open' }, { $set: { status: 'closed', closedAt: new Date(), 'metadata.refunded': true } }, { session });
      if (r.modifiedCount !== 1 || !(t.amount > 0)) return;
      await creditUser(t.user, t.amount, { session, currency: t.currency });
      await recordTransaction({ userId: t.user, amount: t.amount, currency: undefined, type: 'trade', metadata: { action: 'legacy_refund', simulatedTradeId: t._id }, session, prefix: 'MKT' });
      n += 1;
    }).catch((err) => console.error('Legacy sim refund failed:', err.message));
  }
  if (n) console.log(`Trading: refunded ${n} open position(s) from the old simulator`);
  return n;
};
