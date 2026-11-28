// "Trading Activities": the user's package trades and totals.
import mongoose from 'mongoose';
import Trade from '../models/Trade.js';
import MarketPosition from '../models/MarketPosition.js';
import CopyTrade from '../models/CopyTrade.js';
import BotSubscription from '../models/BotSubscription.js';
import User from '../models/User.js';
import { round2 } from '../utils/money.js';
import { HttpError } from '../utils/wallet.js';
import { handler } from '../services/productService.js';
import { settleTrade, tradeState } from '../services/botTradeEngine.js';
import { presentTrade } from './userTradeController.js';

/** Settle anything that has finished before showing it, so numbers are never stale. */
const settleMatured = async (userId) => {
  const due = await Trade.find({ userId, status: 'in-progress', settledAt: null, endDate: { $lte: new Date() } }).select('_id').lean();
  for (const d of due) {
    // eslint-disable-next-line no-await-in-loop
    await settleTrade(d._id, 'matured').catch(() => null);
  }
};

/** GET /api/trading/activities */
export const getTradeActivities = handler(async (req, res) => {
  await settleMatured(req.user.id);
  const user = await User.findById(req.user.id).select('currency').lean();
  const trades = await Trade.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(200);
  const now = new Date();
  const list = trades.map((t) => ({ ...presentTrade(t, now), displayCurrency: t.currency || user.currency }));
  const active = list.filter((t) => t.isActive);
  res.json({
    success: true,
    displayCurrency: user.currency,
    trades: list,
    totals: {
      amount: round2(active.reduce((s, t) => s + t.amount, 0)),
      profit: round2(list.reduce((s, t) => s + (t.isCompleted ? t.profit : t.earned), 0)),
      displayCurrency: user.currency
    }
  });
});

/** POST /api/trading/create — removed: trades are opened from a trading package. */
export const createTrade = handler(async () => {
  throw new HttpError(410, 'Open trades from a trading package instead.');
});

// Totals cover every kind of trade the user makes: package trades, live trades,
// copy trading and AI bots (all amounts are stored in the user's currency).
const oid = (id) => new mongoose.Types.ObjectId(String(id));
const sum = async (Model, match, field) => {
  const [r] = await Model.aggregate([{ $match: match }, { $group: { _id: null, t: { $sum: `$${field}` } } }]);
  return r?.t || 0;
};

/** GET /api/trading/total-profit — realised profit across all trading (plus running package trades). */
export const getTotalProfit = handler(async (req, res) => {
  await settleMatured(req.user.id);
  const uid = oid(req.user.id);
  const user = await User.findById(req.user.id).select('currency').lean();
  const trades = await Trade.find({ userId: req.user.id, status: { $in: ['in-progress', 'completed'] } });
  const now = new Date();
  const packages = round2(trades.reduce((acc, t) => acc + (t.status === 'completed' ? t.profit : tradeState(t, now).earned), 0));
  const [live, copy, bots] = await Promise.all([
    sum(MarketPosition, { user: uid, status: 'closed' }, 'pnl'),
    sum(CopyTrade, { userId: uid }, 'realizedPnl'),
    sum(BotSubscription, { user: uid, status: { $in: ['active', 'completed', 'stopped'] } }, 'totalPnl')
  ]);
  const breakdown = { packages, live: round2(live), copy: round2(copy), bots: round2(bots) };
  const totalProfit = round2(packages + live + copy + bots);
  res.json({ success: true, totalProfit, breakdown, displayCurrency: user.currency });
});

/** GET /api/trading/total-amount — everything the user has put into trades, of every kind. */
export const getTotalTradesAmount = handler(async (req, res) => {
  const uid = oid(req.user.id);
  const user = await User.findById(req.user.id).select('currency').lean();
  const [packages, live, copy, bots, activePackages, activeLive, activeCopy] = await Promise.all([
    sum(Trade, { userId: uid, status: { $in: ['in-progress', 'completed'] } }, 'amount'),
    sum(MarketPosition, { user: uid }, 'margin'),
    sum(CopyTrade, { userId: uid }, 'amount'),
    sum(BotSubscription, { user: uid, status: { $in: ['active', 'completed', 'stopped'] } }, 'allocation'),
    sum(Trade, { userId: uid, status: 'in-progress' }, 'amount'),
    sum(MarketPosition, { user: uid, status: 'open' }, 'margin'),
    sum(CopyTrade, { userId: uid, status: { $ne: 'stopped' } }, 'amount')
  ]);
  const breakdown = { packages: round2(packages), live: round2(live), copy: round2(copy), bots: round2(bots) };
  res.json({
    success: true,
    totalAmount: round2(packages + live + copy + bots),
    activeAmount: round2(activePackages + activeLive + activeCopy),
    breakdown,
    displayCurrency: user.currency
  });
});

/** GET /api/trading/active */
export const getActiveTrades = handler(async (req, res) => {
  await settleMatured(req.user.id);
  const trades = await Trade.find({ userId: req.user.id, status: 'in-progress' }).sort({ createdAt: -1 });
  const now = new Date();
  res.json({ success: true, trades: trades.map((t) => presentTrade(t, now)) });
});

/** PUT /api/trading/:id/status — trades run to completion; users can only cancel (see /user-trades/:id/cancel). */
export const updateTradeStatus = handler(async () => {
  throw new HttpError(400, 'Trades run until they finish. You can cancel within 30 minutes of starting.');
});
