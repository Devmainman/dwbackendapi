// "Trading Activities": the user's package trades and totals.
import mongoose from 'mongoose';
import Trade from '../models/Trade.js';
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

/** GET /api/trading/total-profit — realised profit plus profit earned so far on running trades */
export const getTotalProfit = handler(async (req, res) => {
  await settleMatured(req.user.id);
  const user = await User.findById(req.user.id).select('currency').lean();
  const trades = await Trade.find({ userId: req.user.id, status: { $in: ['in-progress', 'completed'] } });
  const now = new Date();
  const totalProfit = round2(trades.reduce((s, t) => s + (t.status === 'completed' ? t.profit : tradeState(t, now).earned), 0));
  res.json({ success: true, totalProfit, displayCurrency: user.currency });
});

/** GET /api/trading/total-amount — stake currently working in running trades */
export const getTotalTradesAmount = handler(async (req, res) => {
  const user = await User.findById(req.user.id).select('currency').lean();
  const [agg] = await Trade.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(req.user.id), status: 'in-progress' } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);
  res.json({ success: true, totalAmount: round2(agg?.total || 0), displayCurrency: user.currency });
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
