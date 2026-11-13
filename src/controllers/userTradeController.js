// Trading packages for users: list packages, open a trade, follow progress, cancel.
import mongoose from 'mongoose';
import Trade from '../models/Trade.js';
import TradePackage from '../models/TradePackage.js';
import User from '../models/User.js';
import { parseAmount, round2 } from '../utils/money.js';
import { convertFromBase, HttpError } from '../utils/wallet.js';
import { handler, paging } from '../services/productService.js';
import {
  openPackageTrade, cancelPackageTrade, tradeState, settleTrade, INTERVAL_MINUTES, INTERVAL_LABEL
} from '../services/botTradeEngine.js';

const presentPackage = (pkg, fx, currency) => {
  const totalIntervals = Math.max(1, Math.floor((pkg.duration * 60) / (INTERVAL_MINUTES[pkg.profitInterval] || 1)));
  const totalReturnPercent = round2(pkg.profitRate * totalIntervals);
  const min = round2(pkg.minAmount * fx);
  return {
    id: pkg._id,
    name: pkg.name,
    description: pkg.description || '',
    minAmount: min,
    maxAmount: round2(pkg.maxAmount * fx),
    rate: pkg.profitRate,
    interval: pkg.profitInterval,
    duration: pkg.duration,
    currency,
    totalReturnPercent,
    estimatedProfit: round2((min * totalReturnPercent) / 100),
    features: [
      `${pkg.profitRate}% every ${INTERVAL_LABEL[pkg.profitInterval] || pkg.profitInterval}`,
      `${totalReturnPercent}% over ${pkg.duration} hour${pkg.duration === 1 ? '' : 's'}`,
      `Stake returned at the end`
    ]
  };
};

/** Live view of one trade for the client. */
export const presentTrade = (t, now = new Date()) => {
  const s = tradeState(t, now);
  return {
    id: t._id,
    name: t.name,
    amount: t.amount,
    currency: t.currency,
    profit: s.expected,
    earned: s.earned,
    totalReturn: round2(t.amount + s.expected),
    rate: t.rate,
    interval: t.interval,
    status: t.status,
    progress: s.progress,
    active: t.status === 'in-progress',
    isActive: t.status === 'in-progress',
    isCompleted: t.status === 'completed',
    cancellable: s.cancellable,
    nextPayoutAt: s.nextPayoutAt,
    payout: t.payout || 0,
    startDate: t.startDate,
    endDate: t.endDate,
    date: t.createdAt,
    createdAt: t.createdAt
  };
};

/** GET /api/user-trades/packages */
export const getAvailablePackages = handler(async (req, res) => {
  const user = await User.findById(req.user.id).select('currency');
  const [packages, { rate }] = await Promise.all([
    TradePackage.find({ status: 'active' }).sort({ minAmount: 1 }).lean(),
    convertFromBase(1, user.currency)
  ]);
  const list = packages.map((p) => presentPackage(p, rate, user.currency));
  res.json({ success: true, packages: list, count: list.length });
});

/** GET /api/user-trades/packages/:id */
export const getPackageDetails = handler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw new HttpError(400, 'Invalid package');
  const user = await User.findById(req.user.id).select('currency');
  const pkg = await TradePackage.findOne({ _id: req.params.id, status: 'active' }).lean();
  if (!pkg) throw new HttpError(404, 'Package not found');
  const { rate } = await convertFromBase(1, user.currency);
  res.json({ success: true, package: presentPackage(pkg, rate, user.currency) });
});

/** POST /api/user-trades/create  { packageId, amount } */
export const createUserTrade = handler(async (req, res) => {
  const amount = parseAmount(req.body.amount);
  if (amount === null) throw new HttpError(400, 'Enter a valid amount');
  const trade = await openPackageTrade(req.user.id, req.body.packageId, amount);
  const user = await User.findById(req.user.id).select('balance');
  res.status(201).json({
    success: true,
    message: `${trade.name} started`,
    trade: presentTrade(trade),
    newBalance: user.balance
  });
});

/** GET /api/user-trades?status=&page=&limit= */
export const getUserTrades = handler(async (req, res) => {
  const { page, limit, skip } = paging(req.query, 20);
  const filter = { userId: req.user.id };
  if (['in-progress', 'completed', 'terminated'].includes(req.query.status)) filter.status = req.query.status;
  const [items, total] = await Promise.all([
    Trade.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Trade.countDocuments(filter)
  ]);
  const now = new Date();
  const trades = items.map((t) => presentTrade(t, now));
  res.json({
    success: true,
    trades,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  });
});

/** GET /api/user-trades/statistics */
export const getUserTradeStatistics = handler(async (req, res) => {
  const trades = await Trade.find({ userId: req.user.id });
  const now = new Date();
  const live = trades.map((t) => presentTrade(t, now));
  const active = live.filter((t) => t.isActive);
  const done = live.filter((t) => t.isCompleted);
  res.json({
    success: true,
    statistics: {
      totalTrades: live.length,
      activeTrades: active.length,
      completedTrades: done.length,
      invested: round2(active.reduce((s, t) => s + t.amount, 0)),
      earnedSoFar: round2(active.reduce((s, t) => s + t.earned, 0)),
      realizedProfit: round2(done.reduce((s, t) => s + t.profit, 0))
    }
  });
});

/** POST /api/user-trades/:id/cancel — within the first 30 minutes; stake is returned */
export const cancelTrade = handler(async (req, res) => {
  const t = await cancelPackageTrade(req.user.id, req.params.id);
  const user = await User.findById(req.user.id).select('balance');
  res.json({ success: true, message: 'Trade cancelled and stake returned', refundedAmount: t.payout, newBalance: user.balance });
});

/** GET /api/user-trades/:id */
export const getTradeDetails = handler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw new HttpError(400, 'Invalid trade');
  let t = await Trade.findOne({ _id: req.params.id, userId: req.user.id });
  if (!t) throw new HttpError(404, 'Trade not found');
  if (t.status === 'in-progress' && tradeState(t).matured) {
    await settleTrade(t._id, 'matured');
    t = await Trade.findById(t._id);
  }
  res.json({ success: true, trade: presentTrade(t) });
});
