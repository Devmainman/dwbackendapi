// AI Smart Trader engine: places due trades for active bot subscriptions.
// Runs with the other periodic jobs (timer on a normal server, traffic + cron
// on Vercel) and also catches up whenever a user opens their bot page.
// Every trade is claimed with a guarded update, so no trade is placed twice and
// a bot never goes past its trade limit.
import mongoose from 'mongoose';
import BotSubscription from '../models/BotSubscription.js';
import BotTrade from '../models/BotTrade.js';
import User from '../models/User.js';
import { round2 } from '../utils/money.js';
import { creditUser, recordTransaction } from '../utils/wallet.js';
import { getUsdPrice } from './priceService.js';
import { notifyUser } from './notificationService.js';

const FALLBACK_PRICE = { BTC: 65000, ETH: 3200, SOL: 150, BNB: 580, XRP: 0.55, ADA: 0.45, DOGE: 0.12, LTC: 80, AVAX: 30, DOT: 6 };
const MAX_CATCH_UP = 25; // trades placed per subscription per pass

const rand = (min, max) => min + Math.random() * Math.max(0, max - min);

/** Place one trade for a subscription that has already been claimed. */
const placeTrade = async (sub, number, at) => {
  const s = sub.botSnapshot || {};
  const markets = s.markets?.length ? s.markets : ['BTC', 'ETH'];
  const asset = String(markets[Math.floor(Math.random() * markets.length)]).toUpperCase();
  const side = Math.random() < 0.5 ? 'long' : 'short';
  const win = Math.random() * 100 < (s.winRate ?? 70);
  const pct = round2(win ? rand(s.profitMin ?? 0.5, s.profitMax ?? 2) : -rand(s.lossMin ?? 0.3, s.lossMax ?? 1));
  let pnl = round2((sub.allocation * pct) / 100);

  const entry = await getUsdPrice(asset, FALLBACK_PRICE[asset] || 100);
  const move = Math.abs(pct) / 100;
  const up = (side === 'long') === win;
  const exit = entry * (up ? 1 + move : 1 - move);

  // Apply the result to the user's balance. A loss never takes the balance below zero.
  if (pnl > 0) {
    await creditUser(sub.user, pnl, { currency: sub.currency });
  } else if (pnl < 0) {
    const want = round2(-pnl);
    const user = await User.findOneAndUpdate(
      { _id: sub.user },
      [{ $set: { balance: { $round: [{ $max: [0, { $subtract: ['$balance', want] }] }, 2] } } }],
      { new: false }
    ).select('balance').lean();
    const taken = round2(Math.min(want, Math.max(0, user?.balance || 0)));
    pnl = -taken;
  }

  const openedAt = new Date(at.getTime() - 60 * 1000 * Math.max(1, Math.round((s.tradeIntervalMinutes || 60) / 2)));
  await BotTrade.create({
    subscription: sub._id, user: sub.user, number, market: `${asset}/USDT`, side,
    entryPrice: entry, exitPrice: exit, result: win ? 'win' : 'loss', pnlPercent: pct, pnl,
    currency: sub.currency, openedAt, closedAt: at
  });
  if (pnl !== 0) {
    await recordTransaction({
      userId: sub.user, amount: Math.abs(pnl), currency: sub.currency, type: 'trade', status: 'completed', prefix: 'AIB',
      metadata: { source: 'ai_smart_trader', bot: s.name, subscription: String(sub._id), trade: number, result: win ? 'win' : 'loss', pnl }
    }).catch(() => {});
  }
  await BotSubscription.updateOne({ _id: sub._id }, [{ $set: { wins: { $add: ['$wins', win ? 1 : 0] }, losses: { $add: ['$losses', win ? 0 : 1] }, totalPnl: { $round: [{ $add: ['$totalPnl', pnl] }, 2] } } }]);
};

/** Place every trade that is due for one subscription (up to MAX_CATCH_UP). */
const runSubscription = async (subId, now = new Date()) => {
  let placed = 0;
  for (let i = 0; i < MAX_CATCH_UP; i++) {
    const cur = await BotSubscription.findById(subId).lean();
    if (!cur || cur.status !== 'active' || cur.tradesUsed >= cur.tradeLimit || !cur.nextTradeAt || cur.nextTradeAt > now) break;
    const intervalMs = (cur.botSnapshot?.tradeIntervalMinutes || 60) * 60 * 1000;
    const dueAt = new Date(cur.nextTradeAt);
    // Claim trade number tradesUsed+1 (fails if another worker got there first).
    const claimed = await BotSubscription.findOneAndUpdate(
      { _id: cur._id, status: 'active', tradesUsed: cur.tradesUsed, nextTradeAt: cur.nextTradeAt },
      { $inc: { tradesUsed: 1 }, $set: { nextTradeAt: new Date(dueAt.getTime() + intervalMs) } },
      { new: true }
    ).lean();
    if (!claimed) break;
    try {
      await placeTrade(claimed, claimed.tradesUsed, dueAt);
      placed++;
    } catch (err) {
      console.warn('[smart-bot] trade failed:', err.message);
    }
    if (claimed.tradesUsed >= claimed.tradeLimit) {
      const done = await BotSubscription.findOneAndUpdate(
        { _id: claimed._id, status: 'active' },
        { $set: { status: 'completed', completedAt: new Date(), nextTradeAt: null } },
        { new: true }
      ).lean();
      if (done) {
        notifyUser(done.user, {
          title: 'AI Smart Trader finished',
          content: `${done.botSnapshot?.name || 'Your bot'} used all ${done.tradeLimit} trades. Total result: ${round2(done.totalPnl)} ${done.currency}.`,
          type: 'transaction', link: '/ai-trader'
        }).catch(() => {});
      }
      break;
    }
  }
  return placed;
};

/** Periodic job: every active subscription with a trade due. */
export const runDueBotTrades = async (now = new Date()) => {
  const due = await BotSubscription.find({ status: 'active', nextTradeAt: { $lte: now } }).select('_id').limit(200).lean();
  let placed = 0;
  for (const s of due) placed += await runSubscription(s._id, now);
  return { subscriptions: due.length, placed };
};

/** Catch up one user's bots (called when they open the AI Smart Trader page). */
export const catchUpUser = async (userId) => {
  if (!mongoose.Types.ObjectId.isValid(userId)) return 0;
  const due = await BotSubscription.find({ user: userId, status: 'active', nextTradeAt: { $lte: new Date() } }).select('_id').lean();
  let placed = 0;
  for (const s of due) placed += await runSubscription(s._id);
  return placed;
};
