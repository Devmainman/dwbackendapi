// Trading-package positions: accrual, settlement and cancellation.
import mongoose from 'mongoose';
import Trade from '../models/Trade.js';
import TradePackage from '../models/TradePackage.js';
import { round2 } from '../utils/money.js';
import { withTransaction, debitUser, creditUser, recordTransaction, convertFromBase, HttpError } from '../utils/wallet.js';
import { loadActiveUser } from './productService.js';
import { notifyUser } from './notificationService.js';

export const INTERVAL_MINUTES = { minute: 1, '5-minutes': 5, '15-minutes': 15, '30-minutes': 30, hour: 60, daily: 1440 };
export const INTERVAL_LABEL = { minute: 'minute', '5-minutes': '5 minutes', '15-minutes': '15 minutes', '30-minutes': '30 minutes', hour: 'hour', daily: 'day' };
const CANCEL_WINDOW_MIN = 30;

/** Live figures for a trade at `now`. */
export const tradeState = (t, now = new Date()) => {
  const start = new Date(t.startDate).getTime();
  const end = t.endDate ? new Date(t.endDate).getTime() : start;
  const intervalMs = (INTERVAL_MINUTES[t.interval] || 60) * 60 * 1000;
  const totalIntervals = Math.max(1, Math.floor((end - start) / intervalMs));
  const until = Math.min(now.getTime(), end);
  const done = Math.min(totalIntervals, Math.max(0, Math.floor((until - start) / intervalMs)));
  const perInterval = (t.amount * (t.rate || 0)) / 100;
  const running = t.status === 'in-progress';
  return {
    earned: running ? round2(perInterval * done) : round2(t.status === 'completed' ? t.profit : t.earned || 0),
    expected: round2(t.profit),
    intervalsDone: done,
    totalIntervals,
    progress: t.status === 'completed' ? 100 : Math.min(100, Math.max(0, Math.round(((until - start) / Math.max(1, end - start)) * 100))),
    matured: now.getTime() >= end,
    nextPayoutAt: running && done < totalIntervals ? new Date(start + (done + 1) * intervalMs) : null,
    cancellable: running && (now.getTime() - start) / 60000 <= CANCEL_WINDOW_MIN
  };
};

/** Open a package trade. `amount` is in the user's currency. */
export const openPackageTrade = async (userId, packageId, amount) => {
  if (!mongoose.Types.ObjectId.isValid(packageId)) throw new HttpError(400, 'Invalid package');
  const user = await loadActiveUser(userId);
  const pkg = await TradePackage.findOne({ _id: packageId, status: 'active' });
  if (!pkg) throw new HttpError(404, 'This package is not available');

  const { rate: fx } = await convertFromBase(1, user.currency);
  const min = round2(pkg.minAmount * fx);
  const max = round2(pkg.maxAmount * fx);
  if (amount < min) throw new HttpError(400, `Minimum amount is ${min} ${user.currency}`);
  if (amount > max) throw new HttpError(400, `Maximum amount is ${max} ${user.currency}`);

  const intervalMs = (INTERVAL_MINUTES[pkg.profitInterval] || 1) * 60 * 1000;
  const durationMs = pkg.duration * 60 * 60 * 1000;
  const totalIntervals = Math.max(1, Math.floor(durationMs / intervalMs));
  const expectedProfit = round2(((amount * pkg.profitRate) / 100) * totalIntervals);
  const now = new Date();

  return withTransaction(async (session) => {
    await debitUser(user._id, amount, { session });
    const [trade] = await Trade.create([{
      userId: user._id,
      packageId: pkg._id,
      name: pkg.name,
      amount: round2(amount),
      currency: user.currency,
      rate: pkg.profitRate,
      interval: pkg.profitInterval,
      durationHours: pkg.duration,
      profit: expectedProfit,
      status: 'in-progress',
      active: true,
      startDate: now,
      endDate: new Date(now.getTime() + durationMs)
    }], { session });
    await recordTransaction({
      userId: user._id, amount, currency: user.currency, type: 'trade',
      metadata: { action: 'open', package: pkg.name, tradeId: trade._id }, session, prefix: 'TRD'
    });
    return trade;
  });
};

/**
 * Pay out a trade exactly once.
 * mode: 'matured' (stake + full profit), 'admin_completed' (same, early),
 *       'cancelled' / 'admin_terminated' (stake only).
 */
export const settleTrade = async (tradeId, mode = 'matured') => {
  const full = mode === 'matured' || mode === 'admin_completed';
  const result = await withTransaction(async (session) => {
    const t = await Trade.findOneAndUpdate(
      { _id: tradeId, status: { $in: ['in-progress', 'paused', 'pending'] }, settledAt: null },
      { $set: { settledAt: new Date() } },
      { new: true, session }
    );
    if (!t) return null;
    const payout = round2(t.amount + (full ? t.profit : 0));
    t.status = full ? 'completed' : 'terminated';
    t.active = false;
    t.progress = full ? 100 : t.progress;
    t.earned = full ? t.profit : 0;
    t.payout = payout;
    t.closeReason = mode;
    if (!full) t.profit = 0;
    if (mode !== 'matured') t.endDate = new Date();
    await t.save({ session });
    await creditUser(t.userId, payout, { session });
    await recordTransaction({
      userId: t.userId, amount: payout, currency: t.currency, type: 'trade',
      metadata: { action: full ? 'payout' : 'refund', reason: mode, tradeId: t._id }, session, prefix: 'TRD'
    });
    return t;
  });

  if (result) {
    await notifyUser(result.userId, full
      ? { type: 'trading', title: `${result.name} completed`, content: `${result.payout} ${result.currency} (stake + ${result.earned} profit) has been added to your balance.`, link: '/trade', dedupeKey: `trade-settled:${result._id}` }
      : { type: 'trading', title: `${result.name} cancelled`, content: `Your stake of ${result.payout} ${result.currency} has been returned to your balance.`, link: '/trade', dedupeKey: `trade-settled:${result._id}` });
  }
  return result;
};

/** User cancels within the cancellation window: stake back, no profit. */
export const cancelPackageTrade = async (userId, tradeId) => {
  if (!mongoose.Types.ObjectId.isValid(tradeId)) throw new HttpError(400, 'Invalid trade');
  const t = await Trade.findOne({ _id: tradeId, userId });
  if (!t) throw new HttpError(404, 'Trade not found');
  if (!tradeState(t).cancellable) {
    throw new HttpError(400, `Trades can only be cancelled within ${CANCEL_WINDOW_MIN} minutes of starting`);
  }
  const settled = await settleTrade(t._id, 'cancelled');
  if (!settled) throw new HttpError(409, 'This trade has already finished');
  return settled;
};

/** Settle every trade whose term has ended. Safe to run repeatedly. */
export const settleDueTrades = async () => {
  const due = await Trade.find({ status: 'in-progress', settledAt: null, endDate: { $lte: new Date() } }).select('_id').limit(500).lean();
  let n = 0;
  for (const d of due) {
    // eslint-disable-next-line no-await-in-loop
    if (await settleTrade(d._id, 'matured').catch((err) => { console.error('Trade settlement failed:', err.message); return null; })) n += 1;
  }
  return n;
};

/**
 * Trades created by the old code had their stake debited but could never settle
 * (and some carried a user-chosen "profit"). Return their stake once; the old
 * profit figures are not honoured because they were never actually earned.
 */
export const migrateLegacyTrades = async () => {
  const legacy = await Trade.find({
    status: { $in: ['pending', 'in-progress', 'paused'] },
    settledAt: null,
    rate: { $exists: false }
  }).select('_id').lean();
  let n = 0;
  for (const l of legacy) {
    // eslint-disable-next-line no-await-in-loop
    await Trade.updateOne({ _id: l._id }, { $set: { rate: 0, interval: 'hour' } });
    // eslint-disable-next-line no-await-in-loop
    if (await settleTrade(l._id, 'admin_terminated').catch(() => null)) n += 1;
  }
  if (n) console.log(`Trading: returned the stake on ${n} legacy trade(s) that could not settle`);
  return n;
};

export const startTradeSettlementJob = () => {
  const tick = () => settleDueTrades().catch((err) => console.error('Trade settlement job:', err.message));
  setTimeout(tick, 3000);
  return setInterval(tick, 30 * 1000);
};
