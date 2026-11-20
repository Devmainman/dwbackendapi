// src/services/copyTradingEngine.js
//
// Single source of truth for copy-trading money movements.
//
//   user balance --start/add funds--> CopyTrade.cash --open master trade--> CopiedTrade.margin
//   CopiedTrade --master closes--> margin + P/L - commission --> CopyTrade.cash --stop--> user balance
//
// Every step that moves funds is a conditional update inside a MongoDB
// transaction, so concurrent requests can't double-spend or double-settle.
import mongoose from 'mongoose';
import Trader from '../models/Trader.js';
import MasterTrade from '../models/MasterTrade.js';
import CopyTrade from '../models/CopyTrade.js';
import CopiedTrade from '../models/CopiedTrade.js';
import User from '../models/User.js';
import Setting from '../models/Setting.js';
import { round2, round8 } from '../utils/money.js';
import {
  withTransaction, debitUser, creditUser, recordTransaction, convertFromBase, HttpError
} from '../utils/wallet.js';
import { notify } from './productService.js';
import { sendNotification } from './realtime.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_COPY = ['active', 'paused'];

/** Pipeline update that adds `delta` to `field` and rounds to cents. */
const addTo = (field, delta) => ({ [field]: { $round: [{ $add: [{ $ifNull: [`$${field}`, 0] }, delta] }, 2] } });

/** Leveraged return on margin, in %, floored at -100 (a position can't lose more than its margin). */
export const pnlPercentAt = (trade, price) => {
  if (!trade.entryPrice || !price) return 0;
  const dir = trade.side === 'sell' ? -1 : 1;
  const pct = ((price - trade.entryPrice) / trade.entryPrice) * dir * (trade.leverage || 1) * 100;
  return Math.max(-100, Math.round(pct * 10000) / 10000);
};

const emit = (userId, payload) => {
  try { sendNotification(String(userId), { type: 'copy_trading', ...payload }); } catch { /* best effort */ }
};

/* ------------------------------------------------------------------ */
/* Legacy data                                                        */
/* ------------------------------------------------------------------ */

/**
 * One-time, idempotent upgrade of copies created by the previous implementation:
 * gives them a cash balance equal to their principal and retires their
 * unsettled legacy positions (which never reserved funds of their own).
 */
export const migrateLegacyCopyData = async () => {
  const copies = await CopyTrade.updateMany(
    { cash: { $exists: false } },
    [{
      $set: {
        cash: { $max: [0, { $round: [{ $add: ['$amount', { $ifNull: ['$performance.netProfit', 0] }] }, 2] }] },
        isOpen: { $in: ['$status', OPEN_COPY] },
        realizedPnl: { $ifNull: ['$performance.netProfit', 0] }
      }
    }]
  );
  const positions = await CopiedTrade.updateMany(
    { status: 'open', masterTradeId: { $exists: false } },
    { $set: { status: 'cancelled', closedReason: 'legacy', closedAt: new Date() } }
  );
  // Every trader must have a minimum copy amount.
  const mins = await Trader.updateMany(
    { $or: [{ 'settings.minCopyAmount': { $exists: false } }, { 'settings.minCopyAmount': { $lt: 1 } }] },
    { $set: { 'settings.minCopyAmount': 50 } }
  );
  if (mins.modifiedCount) console.log(`Copy trading: set the default minimum copy amount on ${mins.modifiedCount} trader(s)`);
  if (copies.modifiedCount || positions.modifiedCount) {
    console.log(`Copy trading: migrated ${copies.modifiedCount} legacy copies, retired ${positions.modifiedCount} legacy positions`);
  }
};

/* ------------------------------------------------------------------ */
/* Stats                                                               */
/* ------------------------------------------------------------------ */

/** Recompute a trader's public performance from their closed master trades. */
export const recomputeTraderStats = async (traderId) => {
  const trades = await MasterTrade.find({ traderId, status: 'closed' }).sort({ closedAt: 1 }).lean();
  const now = Date.now();
  let equity = 100;
  let peak = 100;
  let maxDrawdown = 0;
  let wins = 0;
  let holdMs = 0;
  const curve = [];
  const windowFactor = { day: 1, week: 1, month: 1 };

  for (const t of trades) {
    const factor = 1 + (t.pnlPercent / 100) * (t.allocationPercent / 100);
    equity *= factor;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, ((peak - equity) / peak) * 100);
    if (t.pnlPercent > 0) wins += 1;
    holdMs += new Date(t.closedAt) - new Date(t.openedAt);
    curve.push({ at: t.closedAt, value: Math.round(equity * 100) / 100 });
    const age = now - new Date(t.closedAt).getTime();
    if (age <= DAY_MS) windowFactor.day *= factor;
    if (age <= 7 * DAY_MS) windowFactor.week *= factor;
    if (age <= 30 * DAY_MS) windowFactor.month *= factor;
  }

  const [paid] = await CopiedTrade.aggregate([
    { $match: { traderId, status: 'closed', masterTradeId: { $exists: true } } },
    { $group: { _id: null, net: { $sum: { $subtract: ['$profitLoss', '$commission'] } } } }
  ]);
  const [copiers] = await CopyTrade.aggregate([
    { $match: { traderId, isOpen: true } },
    { $group: { _id: null, count: { $sum: 1 }, aum: { $sum: '$amount' } } }
  ]);

  const pct = (f) => round2((f - 1) * 100);
  await Trader.updateOne({ traderId }, {
    $set: {
      'performance.roi': round2(equity - 100),
      'performance.winRate': trades.length ? round2((wins / trades.length) * 100) : 0,
      'performance.totalTrades': trades.length,
      'performance.successfulTrades': wins,
      'performance.maxDrawdown': round2(maxDrawdown),
      'performance.dailyProfit': pct(windowFactor.day),
      'performance.weeklyProfit': pct(windowFactor.week),
      'performance.monthlyProfit': pct(windowFactor.month),
      'performance.netProfit': round2(paid?.net || 0),
      'performance.averageHoldHours': trades.length ? round2(holdMs / trades.length / 3600000) : 0,
      'performance.equityCurve': curve.slice(-120),
      'performance.lastTradeAt': trades.length ? trades[trades.length - 1].closedAt : null,
      'socialStats.activeCopiers': copiers?.count || 0
    }
  });
};

/** Live value of a copy: cash + margins + unrealised P/L at current mark prices. */
export const valueCopies = async (copies) => {
  const ids = copies.map((c) => c._id);
  const positions = await CopiedTrade.find({ copyTradeId: { $in: ids }, status: 'open' }).lean();
  const masters = await MasterTrade.find({ _id: { $in: positions.map((p) => p.masterTradeId).filter(Boolean) } }).lean();
  const masterById = new Map(masters.map((m) => [String(m._id), m]));

  const byCopy = new Map();
  for (const p of positions) {
    const m = masterById.get(String(p.masterTradeId));
    const mark = m?.markPrice || p.entryPrice;
    const unrealized = round2(Math.max(-p.margin, (p.margin * pnlPercentAt({ ...p, leverage: p.leverage }, mark)) / 100));
    const list = byCopy.get(String(p.copyTradeId)) || [];
    list.push({ ...p, id: p._id, markPrice: mark, unrealizedPnl: unrealized, unrealizedPercent: p.margin ? round2((unrealized / p.margin) * 100) : 0 });
    byCopy.set(String(p.copyTradeId), list);
  }

  return copies.map((c) => {
    const open = byCopy.get(String(c._id)) || [];
    const invested = round2(open.reduce((s, p) => s + p.margin, 0));
    const unrealized = round2(open.reduce((s, p) => s + p.unrealizedPnl, 0));
    const cash = c.status === 'stopped' ? 0 : round2(c.cash ?? c.amount);
    const equity = round2(cash + invested + unrealized);
    const totalPnl = c.status === 'stopped' ? round2((c.payout || 0) - c.amount) : round2(equity - c.amount);
    return {
      ...c,
      id: c._id,
      cash,
      invested,
      unrealizedPnl: unrealized,
      equity: c.status === 'stopped' ? 0 : equity,
      totalPnl,
      totalPnlPercent: c.amount ? round2((totalPnl / c.amount) * 100) : 0,
      openPositions: open
    };
  });
};

/* ------------------------------------------------------------------ */
/* Copier side                                                         */
/* ------------------------------------------------------------------ */

/** Commit a slice of a copy's equity to a master trade. Returns the position or null when skipped. */
const openPositionForCopy = async (copy, master, price) => {
  return withTransaction(async (session) => {
    const fresh = await CopyTrade.findOne({ _id: copy._id, status: 'active' }).session(session);
    if (!fresh) return null;
    const exists = await CopiedTrade.exists({ copyTradeId: fresh._id, masterTradeId: master._id }).session(session);
    if (exists) return null;

    const openMargins = await CopiedTrade.aggregate([
      { $match: { copyTradeId: fresh._id, status: 'open' } },
      { $group: { _id: null, m: { $sum: '$margin' } } }
    ]).session(session);
    const equity = (fresh.cash || 0) + (openMargins[0]?.m || 0);
    const margin = round2(Math.min(fresh.cash || 0, equity * (master.allocationPercent / 100)));
    if (margin < 0.01) return null;

    const reserved = await CopyTrade.updateOne(
      { _id: fresh._id, status: 'active', cash: { $gte: margin } },
      [{ $set: addTo('cash', -margin) }],
      { session }
    );
    if (reserved.modifiedCount !== 1) return null;

    const [position] = await CopiedTrade.create([{
      copyTradeId: fresh._id,
      userId: fresh.userId,
      traderId: master.traderId,
      traderUsername: fresh.traderUsername,
      masterTradeId: master._id,
      originalTradeId: String(master._id),
      symbol: master.symbol,
      side: master.side,
      entryPrice: price,
      margin,
      leverage: master.leverage,
      quantity: round8((margin * master.leverage) / price),
      openedAt: new Date()
    }], { session });
    return position;
  });
};

/** Settle one open position at `price`. Idempotent: a closed position is never settled twice. */
export const settlePosition = async (positionId, price, reason) => {
  const result = await withTransaction(async (session) => {
    const p = await CopiedTrade.findOne({ _id: positionId, status: 'open' }).session(session);
    if (!p) return null;
    const copy = await CopyTrade.findById(p.copyTradeId).session(session);
    const trader = await Trader.findOne({ traderId: p.traderId }).select('settings.commissionRate').session(session);

    const isCancel = reason === 'cancelled';
    const pct = isCancel ? 0 : pnlPercentAt(p, price);
    const pnl = round2(Math.max(-p.margin, (p.margin * pct) / 100));
    const commission = pnl > 0 ? round2(pnl * ((trader?.settings?.commissionRate || 0) / 100)) : 0;
    const returned = round2(Math.max(0, p.margin + pnl - commission));

    p.status = isCancel ? 'cancelled' : 'closed';
    p.exitPrice = isCancel ? p.entryPrice : price;
    p.profitLoss = pnl;
    p.profitPercentage = round2(pct);
    p.commission = commission;
    p.closedReason = reason;
    p.closedAt = new Date();
    await p.save({ session });

    if (copy) {
      await CopyTrade.updateOne({ _id: copy._id }, [{
        $set: {
          ...addTo('cash', returned),
          ...addTo('realizedPnl', round2(pnl - commission)),
          ...addTo('commissionPaid', commission),
          'performance.totalTrades': { $add: [{ $ifNull: ['$performance.totalTrades', 0] }, isCancel ? 0 : 1] },
          'performance.successfulTrades': { $add: [{ $ifNull: ['$performance.successfulTrades', 0] }, !isCancel && pnl > 0 ? 1 : 0] }
        }
      }], { session });
    }
    return { position: p, copy, pnl, commission };
  });

  if (result?.copy) {
    emit(result.copy.userId, { event: 'position_closed', positionId: String(positionId), pnl: result.pnl });
  }
  return result;
};

/** Auto-stop a copy when its equity crosses the user's stop-loss / take-profit. */
const enforceRiskLimits = async (copyId) => {
  const copy = await CopyTrade.findById(copyId).lean();
  if (!copy || !OPEN_COPY.includes(copy.status)) return;
  const { stopLossPercent, takeProfitPercent } = copy.settings || {};
  if (!stopLossPercent && !takeProfitPercent) return;
  const [valued] = await valueCopies([copy]);
  const changePct = copy.amount ? ((valued.equity - copy.amount) / copy.amount) * 100 : 0;
  if (stopLossPercent && changePct <= -stopLossPercent) await stopCopy(copy._id, { reason: 'stop_loss' });
  else if (takeProfitPercent && changePct >= takeProfitPercent) await stopCopy(copy._id, { reason: 'take_profit' });
};

/** Start copying a trader with `amount` (user currency). */
export const startCopy = async (userId, traderId, amount, settings = {}) => {
  const user = await User.findById(userId);
  if (!user) throw new HttpError(404, 'User not found');
  if (user.status === 'Inactive') throw new HttpError(403, 'Your account is restricted. Contact support.');

  const trader = await Trader.findOne({ traderId: String(traderId) });
  if (!trader || !trader.isActive || !trader.settings.allowCopying) throw new HttpError(404, 'This trader is not available to copy');

  const min = await convertFromBase(trader.settings.minCopyAmount || 0, user.currency);
  if (amount < min.amount) throw new HttpError(400, `Minimum copy amount is ${min.amount} ${user.currency}`);

  if (trader.settings.maxCopiers > 0) {
    const count = await CopyTrade.countDocuments({ traderId: trader.traderId, isOpen: true });
    if (count >= trader.settings.maxCopiers) throw new HttpError(400, 'This trader is not accepting new copiers right now');
  }

  const setting = await Setting.findOne().select('signalStrength').lean();
  const signalCost = Number(setting?.signalStrength?.copyTrading) || 0;
  if (signalCost > 0 && (user.tradingSignalStrength || 0) < signalCost) {
    throw new HttpError(400, `Insufficient signal strength. Required: ${signalCost}%, available: ${user.tradingSignalStrength || 0}%`);
  }

  const sl = Number(settings.stopLossPercent);
  const tp = Number(settings.takeProfitPercent);

  const copy = await withTransaction(async (session) => {
    await debitUser(user._id, amount, { session });
    if (signalCost > 0) {
      const ok = await User.updateOne(
        { _id: user._id, tradingSignalStrength: { $gte: signalCost } },
        { $inc: { tradingSignalStrength: -signalCost }, $set: { tradingSignalUpdatedAt: new Date() } },
        { session }
      );
      if (ok.modifiedCount !== 1) throw new HttpError(400, 'Insufficient signal strength');
    }
    let created;
    try {
      [created] = await CopyTrade.create([{
        userId: user._id,
        trader: trader._id,
        traderId: trader.traderId,
        traderUsername: trader.username,
        traderAvatar: trader.avatar,
        currency: user.currency,
        amount: round2(amount),
        cash: round2(amount),
        settings: {
          stopLossPercent: sl > 0 && sl <= 100 ? sl : null,
          takeProfitPercent: tp > 0 && tp <= 1000 ? tp : null,
          copyOpenTrades: settings.copyOpenTrades !== false
        }
      }], { session });
    } catch (err) {
      if (err?.code === 11000) throw new HttpError(400, 'You are already copying this trader');
      throw err;
    }
    await recordTransaction({
      userId: user._id, amount, currency: user.currency, type: 'copy_trade',
      metadata: { action: 'allocate', trader: trader.username, copyTradeId: created._id }, session, prefix: 'CPY'
    });
    await Trader.updateOne(
      { _id: trader._id },
      { $inc: { 'socialStats.totalCopiers': 1, 'socialStats.activeCopiers': 1, 'socialStats.totalCopiedAmount': round2(amount) } },
      { session }
    );
    return created;
  });

  // Join the trader's currently open trades at today's price, if requested.
  if (copy.settings.copyOpenTrades) {
    const open = await MasterTrade.find({ traderId: trader.traderId, status: 'open' }).sort({ openedAt: 1 });
    for (const m of open) {
      // eslint-disable-next-line no-await-in-loop
      const pos = await openPositionForCopy(copy, m, m.markPrice || m.entryPrice);
      // eslint-disable-next-line no-await-in-loop
      if (pos) await MasterTrade.updateOne({ _id: m._id }, { $inc: { copiedCount: 1 } });
    }
  }

  await notify(user._id, {
    type: 'copy_trading',
    link: '/copy-positions',
    title: `You're now copying ${trader.username}`,
    content: `${round2(amount)} ${user.currency} allocated. New trades by ${trader.username} will be copied automatically.`
  });
  return copy;
};

/** Add more funds to an open copy. */
export const addFunds = async (userId, copyId, amount) => {
  return withTransaction(async (session) => {
    const copy = await CopyTrade.findOne({ _id: copyId, userId, status: { $in: OPEN_COPY } }).session(session);
    if (!copy) throw new HttpError(404, 'Active copy not found');
    await debitUser(userId, amount, { session });
    await CopyTrade.updateOne({ _id: copy._id }, [{ $set: { ...addTo('cash', amount), ...addTo('amount', amount) } }], { session });
    await Trader.updateOne({ traderId: copy.traderId }, { $inc: { 'socialStats.totalCopiedAmount': round2(amount) } }, { session });
    await recordTransaction({
      userId, amount, currency: copy.currency, type: 'copy_trade',
      metadata: { action: 'add_funds', trader: copy.traderUsername, copyTradeId: copy._id }, session, prefix: 'CPY'
    });
    return CopyTrade.findById(copy._id).session(session);
  });
};

/**
 * Stop a copy: close its open positions at current mark prices and return
 * all remaining funds to the user's balance. Safe to call concurrently.
 */
export const stopCopy = async (copyId, { userId, reason = 'user' } = {}) => {
  const filter = { _id: copyId, status: { $in: OPEN_COPY } };
  if (userId) filter.userId = userId;
  const copy = await CopyTrade.findOneAndUpdate(filter, { $set: { status: 'stopping' } }, { new: true });
  if (!copy) throw new HttpError(404, 'Active copy not found');

  const positions = await CopiedTrade.find({ copyTradeId: copy._id, status: 'open' });
  for (const p of positions) {
    // eslint-disable-next-line no-await-in-loop
    const m = p.masterTradeId ? await MasterTrade.findById(p.masterTradeId).lean() : null;
    // eslint-disable-next-line no-await-in-loop
    await settlePosition(p._id, m?.markPrice || p.entryPrice, 'copy_stopped');
  }

  const payout = await withTransaction(async (session) => {
    const c = await CopyTrade.findOne({ _id: copy._id, status: 'stopping' }).session(session);
    if (!c) return 0;
    const amount = round2(c.cash || 0);
    c.cash = 0;
    c.payout = amount;
    c.status = 'stopped';
    c.isOpen = false;
    c.stoppedAt = new Date();
    c.stopReason = reason;
    await c.save({ session });
    if (amount > 0) {
      await creditUser(c.userId, amount, { session, currency: c.currency });
      await recordTransaction({
        userId: c.userId, amount, currency: c.currency, type: 'copy_trade',
        metadata: { action: 'payout', trader: c.traderUsername, copyTradeId: c._id, reason }, session, prefix: 'CPY'
      });
    }
    return amount;
  });

  await Trader.updateOne({ traderId: copy.traderId }, [{ $set: { 'socialStats.activeCopiers': { $max: [0, { $subtract: ['$socialStats.activeCopiers', 1] }] } } }]);
  const reasonText = { user: 'stopped', stop_loss: 'stopped by your stop-loss', take_profit: 'stopped by your take-profit', admin: 'stopped by an administrator', trader_removed: 'stopped because the trader was removed' }[reason] || 'stopped';
  await notify(copy.userId, {
    type: 'copy_trading',
    link: '/copy-positions',
    title: `Copy of ${copy.traderUsername} ${reasonText}`,
    content: `${payout} ${copy.currency} has been returned to your balance.`
  });
  emit(copy.userId, { event: 'copy_stopped', copyTradeId: String(copy._id), payout });
  return { copy, payout };
};

/** User closes one copied position early at the current mark price. */
export const closePositionEarly = async (userId, positionId) => {
  const p = await CopiedTrade.findOne({ _id: positionId, userId, status: 'open' });
  if (!p) throw new HttpError(404, 'Open position not found');
  const m = p.masterTradeId ? await MasterTrade.findById(p.masterTradeId).lean() : null;
  const result = await settlePosition(p._id, m?.markPrice || p.entryPrice, 'manual');
  if (!result) throw new HttpError(400, 'Position is already closed');
  await enforceRiskLimits(p.copyTradeId);
  return result.position;
};

/* ------------------------------------------------------------------ */
/* Trader side (admin)                                                 */
/* ------------------------------------------------------------------ */

/** Open a master trade and mirror it into every active copy. */
export const openMasterTrade = async (trader, { symbol, side, entryPrice, allocationPercent = 10, leverage = 1, notes = '', source = 'manual' }) => {
  const master = await MasterTrade.create({
    source,
    trader: trader._id,
    traderId: trader.traderId,
    symbol,
    side,
    entryPrice,
    markPrice: entryPrice,
    markUpdatedAt: new Date(),
    allocationPercent,
    leverage,
    notes
  });

  const copies = await CopyTrade.find({ traderId: trader.traderId, status: 'active' }).lean();
  let copied = 0;
  for (const c of copies) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const pos = await openPositionForCopy(c, master, entryPrice);
      if (pos) {
        copied += 1;
        emit(c.userId, { event: 'position_opened', symbol, side, margin: pos.margin });
      }
    } catch (err) {
      console.error(`Copy trading: could not mirror trade into copy ${c._id}:`, err.message);
    }
  }
  master.copiedCount = copied;
  await master.save();
  await Trader.updateOne({ _id: trader._id }, { $set: { lastActive: new Date() } });
  return master;
};

/** Update the latest price of open master trades (by id, or every open trade on a symbol). */
export const updateMarkPrice = async ({ masterTradeId, traderId, symbol, price }) => {
  const filter = { status: 'open' };
  if (masterTradeId) filter._id = masterTradeId;
  if (traderId) filter.traderId = traderId;
  if (symbol) filter.symbol = String(symbol).toUpperCase();
  const r = await MasterTrade.updateMany(filter, { $set: { markPrice: price, markUpdatedAt: new Date() } });

  // Price moves can trigger copiers' stop-loss / take-profit.
  if (r.modifiedCount) {
    const masters = await MasterTrade.find(filter).select('_id').lean();
    const copyIds = await CopiedTrade.distinct('copyTradeId', { masterTradeId: { $in: masters.map((m) => m._id) }, status: 'open' });
    for (const id of copyIds) {
      // eslint-disable-next-line no-await-in-loop
      await enforceRiskLimits(id).catch((err) => console.error('Risk check failed:', err.message));
    }
  }
  return r.modifiedCount;
};

/** Close a master trade and settle every copied position at the same price. */
export const closeMasterTrade = async (masterId, exitPrice, { cancel = false, reason = '' } = {}) => {
  const existing = await MasterTrade.findOne({ _id: masterId, status: 'open' });
  if (!existing) throw new HttpError(404, 'Open trade not found');
  const price = cancel ? existing.entryPrice : exitPrice;
  const master = await MasterTrade.findOneAndUpdate(
    { _id: masterId, status: 'open' },
    {
      $set: {
        status: cancel ? 'cancelled' : 'closed',
        exitPrice: price,
        markPrice: price,
        pnlPercent: cancel ? 0 : pnlPercentAt(existing, price),
        closeReason: cancel ? 'cancelled' : (reason || 'manual'),
        closedAt: new Date()
      }
    },
    { new: true }
  );
  if (!master) throw new HttpError(409, 'Trade was closed by another request');

  const positions = await CopiedTrade.find({ masterTradeId: master._id, status: 'open' }).select('_id copyTradeId').lean();
  let settled = 0;
  for (const p of positions) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await settlePosition(p._id, price, cancel ? 'cancelled' : 'trader_closed');
      if (r) settled += 1;
    } catch (err) {
      console.error(`Copy trading: settlement failed for position ${p._id}:`, err.message);
    }
  }
  for (const copyId of new Set(positions.map((p) => String(p.copyTradeId)))) {
    // eslint-disable-next-line no-await-in-loop
    await enforceRiskLimits(copyId).catch((err) => console.error('Risk check failed:', err.message));
  }
  await recomputeTraderStats(master.traderId);
  return { master, settled };
};

/** Positions that failed to settle (e.g. a crash mid-close) are retried here. */
export const settleOrphanedPositions = async () => {
  const closedMasters = await MasterTrade.find({ status: { $in: ['closed', 'cancelled'] } }).select('_id exitPrice status').lean();
  if (!closedMasters.length) return 0;
  const orphans = await CopiedTrade.find({ masterTradeId: { $in: closedMasters.map((m) => m._id) }, status: 'open' }).select('_id masterTradeId').lean();
  const byId = new Map(closedMasters.map((m) => [String(m._id), m]));
  for (const o of orphans) {
    const m = byId.get(String(o.masterTradeId));
    // eslint-disable-next-line no-await-in-loop
    await settlePosition(o._id, m.exitPrice, m.status === 'cancelled' ? 'cancelled' : 'trader_closed').catch(() => {});
  }
  // Copies left in 'stopping' by a crash are finished too.
  const stuck = await CopyTrade.find({ status: 'stopping', updatedAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) } }).select('_id').lean();
  for (const s of stuck) {
    // eslint-disable-next-line no-await-in-loop
    await CopyTrade.updateOne({ _id: s._id }, { $set: { status: 'active' } });
    // eslint-disable-next-line no-await-in-loop
    await stopCopy(s._id, { reason: 'user' }).catch(() => {});
  }
  return orphans.length;
};

export const isValidId = (id) => mongoose.Types.ObjectId.isValid(String(id));
