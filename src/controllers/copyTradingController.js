// User-facing copy trading API. All money movement lives in services/copyTradingEngine.js.
import Trader, { traderBadge } from '../models/Trader.js';
import TraderFollow from '../models/TraderFollow.js';
import MasterTrade from '../models/MasterTrade.js';
import CopyTrade from '../models/CopyTrade.js';
import CopiedTrade from '../models/CopiedTrade.js';
import User from '../models/User.js';
import { parseAmount, round2 } from '../utils/money.js';
import { asString, escapeRegex } from '../utils/validation.js';
import { convertFromBase, HttpError } from '../utils/wallet.js';
import { handler, paging } from '../services/productService.js';
import {
  startCopy, addFunds, stopCopy, closePositionEarly, valueCopies, pnlPercentAt, isValidId
} from '../services/copyTradingEngine.js';

const SORTS = {
  roi: { 'performance.roi': -1 },
  monthly: { 'performance.monthlyProfit': -1 },
  winRate: { 'performance.winRate': -1 },
  copiers: { 'socialStats.activeCopiers': -1 },
  followers: { 'socialStats.followers': -1 },
  drawdown: { 'performance.maxDrawdown': 1 },
  newest: { joinedDate: -1 }
};

/** Public profile fields only (no email, internal metadata, etc.). */
const publicTrader = (t, extra = {}) => ({
  id: t._id,
  traderId: t.traderId,
  username: t.username,
  fullName: t.fullName,
  avatar: t.avatar,
  bio: t.bio,
  country: t.country,
  verified: t.verified,
  badge: traderBadge(t), // 'gold' | 'blue' | 'none'
  followers: t.socialStats?.followers || 0,
  tradingStyle: t.tradingStyle,
  markets: t.markets,
  experience: t.tradingExperience,
  riskLevel: t.riskMetrics?.riskLevel || 'medium',
  performance: {
    roi: t.performance?.roi || 0,
    winRate: t.performance?.winRate || 0,
    totalTrades: t.performance?.totalTrades || 0,
    maxDrawdown: t.performance?.maxDrawdown || 0,
    monthlyProfit: t.performance?.monthlyProfit || 0,
    weeklyProfit: t.performance?.weeklyProfit || 0,
    averageHoldHours: t.performance?.averageHoldHours || 0,
    lastTradeAt: t.performance?.lastTradeAt || null,
    sparkline: (t.performance?.equityCurve || []).slice(-30).map((p) => p.value)
  },
  copiers: t.socialStats?.activeCopiers || 0,
  commissionRate: t.settings?.commissionRate || 0,
  acceptingCopiers: t.isActive && t.settings?.allowCopying !== false,
  joinedDate: t.joinedDate,
  // Live status: 'trading' (has open trades), 'online' (autopilot watching the market), 'offline'.
  status: !t.isActive ? 'offline'
    : t.autoTrading?.enabled ? (t.autoTrading.state === 'in_trade' ? 'trading' : 'online')
      : (t.lastActive && Date.now() - new Date(t.lastActive).getTime() < 15 * 60e3 ? 'online' : 'offline'),
  autoTrading: !!t.autoTrading?.enabled,
  lastActive: t.lastActive,
  ...extra
});

/** GET /api/copy-trading/traders?search=&sort=&risk=&market= */
export const listTraders = handler(async (req, res) => {
  const filter = { isActive: true };
  if (req.query.search) {
    const rx = new RegExp(escapeRegex(req.query.search), 'i');
    filter.$or = [{ username: rx }, { fullName: rx }];
  }
  if (['low', 'medium', 'high', 'very_high'].includes(req.query.risk)) filter['riskMetrics.riskLevel'] = req.query.risk;
  if (['crypto', 'forex', 'stocks', 'commodities', 'indices'].includes(req.query.market)) filter.markets = req.query.market;

  const user = await User.findById(req.user.id).select('currency');
  const [traders, myCopies, { rate }, follows] = await Promise.all([
    Trader.find(filter).sort(SORTS[req.query.sort] || SORTS.roi).limit(100).lean(),
    CopyTrade.find({ userId: req.user.id, isOpen: true }).select('traderId status').lean(),
    convertFromBase(1, user.currency),
    TraderFollow.find({ user: req.user.id }).select('traderId').lean()
  ]);
  const following = new Set(follows.map((f) => f.traderId));
  const copying = new Map(myCopies.map((c) => [c.traderId, c]));

  const list = traders.map((t) => publicTrader(t, {
    minCopyAmount: round2((t.settings?.minCopyAmount || 0) * rate),
    isFollowing: following.has(t.traderId),
    myCopy: copying.has(t.traderId) ? { id: copying.get(t.traderId)._id, status: copying.get(t.traderId).status } : null
  }));

  res.json({
    success: true,
    data: {
      currency: user.currency,
      traders: list,
      stats: {
        totalTraders: list.length,
        totalCopiers: list.reduce((s, t) => s + t.copiers, 0),
        averageRoi: list.length ? round2(list.reduce((s, t) => s + t.performance.roi, 0) / list.length) : 0
      }
    }
  });
});

/** GET /api/copy-trading/traders/:traderId — profile, equity curve, open trades, recent history */
export const getTrader = handler(async (req, res) => {
  const trader = await Trader.findOne({ traderId: asString(req.params.traderId, 60), isActive: true }).lean();
  if (!trader) throw new HttpError(404, 'Trader not found');
  const user = await User.findById(req.user.id).select('currency balance');
  const [open, recent, myCopy, { rate }, isFollowing] = await Promise.all([
    MasterTrade.find({ traderId: trader.traderId, status: 'open' }).sort({ openedAt: -1 }).lean(),
    MasterTrade.find({ traderId: trader.traderId, status: 'closed' }).sort({ closedAt: -1 }).limit(30).lean(),
    CopyTrade.findOne({ userId: req.user.id, traderId: trader.traderId, isOpen: true }).select('_id status').lean(),
    convertFromBase(1, user.currency),
    TraderFollow.exists({ user: req.user.id, traderId: trader.traderId })
  ]);

  const [stats, copierAgg] = await Promise.all([
    detailedStats(trader),
    CopyTrade.aggregate([
      { $match: { traderId: trader.traderId, isOpen: true } },
      { $group: { _id: null, count: { $sum: 1 } } }
    ])
  ]);

  res.json({
    success: true,
    data: {
      currency: user.currency,
      availableBalance: user.balance,
      trader: publicTrader(trader, {
        minCopyAmount: round2((trader.settings?.minCopyAmount || 0) * rate),
        equityCurve: trader.performance?.equityCurve || [],
        isFollowing: !!isFollowing,
        myCopy: myCopy ? { id: myCopy._id, status: myCopy.status } : null
      }),
      stats: { ...stats, openTrades: open.length, copiers: copierAgg[0]?.count || 0 },
      openTrades: open.map(mapTrade),
      recentTrades: recent.map(mapTrade)
    }
  });
});

const mapTrade = (m) => ({
  id: m._id,
  symbol: m.symbol,
  side: m.side,
  status: m.status,
  leverage: m.leverage,
  allocationPercent: m.allocationPercent,
  entryPrice: m.entryPrice,
  markPrice: m.markPrice,
  exitPrice: m.exitPrice,
  pnlPercent: m.status === 'open' ? pnlPercentAt(m, m.markPrice || m.entryPrice) : m.pnlPercent,
  durationHours: m.closedAt ? round2((new Date(m.closedAt) - new Date(m.openedAt)) / 3600000) : null,
  openedAt: m.openedAt,
  closedAt: m.closedAt
});

/** Full statistics computed from every closed trade of a trader. */
const detailedStats = async (trader) => {
  const closed = await MasterTrade.find({ traderId: trader.traderId, status: 'closed' })
    .select('symbol side pnlPercent allocationPercent leverage openedAt closedAt').sort({ closedAt: 1 }).lean();

  const wins = closed.filter((t) => t.pnlPercent > 0);
  const losses = closed.filter((t) => t.pnlPercent < 0);
  const avg = (list) => (list.length ? round2(list.reduce((s, t) => s + t.pnlPercent, 0) / list.length) : 0);
  // Contribution of each trade to the strategy's equity (return × share of capital used).
  const contrib = (t) => (t.pnlPercent * t.allocationPercent) / 100;
  const grossWin = wins.reduce((s, t) => s + contrib(t), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + contrib(t), 0));
  const best = closed.reduce((b, t) => (!b || t.pnlPercent > b.pnlPercent ? t : b), null);
  const worst = closed.reduce((w, t) => (!w || t.pnlPercent < w.pnlPercent ? t : w), null);

  // Longest winning / losing streaks.
  let streakW = 0; let streakL = 0; let curW = 0; let curL = 0;
  for (const t of closed) {
    if (t.pnlPercent > 0) { curW += 1; curL = 0; } else if (t.pnlPercent < 0) { curL += 1; curW = 0; }
    streakW = Math.max(streakW, curW);
    streakL = Math.max(streakL, curL);
  }

  // Compounded return per calendar month (last 12 months with trades).
  const months = new Map();
  for (const t of closed) {
    const d = new Date(t.closedAt);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    months.set(key, (months.get(key) ?? 1) * (1 + contrib(t) / 100));
  }
  const monthlyReturns = [...months.entries()].slice(-12).map(([month, f]) => ({ month, returnPercent: round2((f - 1) * 100) }));

  const symbols = new Map();
  for (const t of closed) symbols.set(t.symbol, (symbols.get(t.symbol) || 0) + 1);
  const topSymbols = [...symbols.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([symbol, count]) => ({ symbol, count, sharePercent: round2((count / closed.length) * 100) }));

  const p = trader.performance || {};
  return {
    roi: p.roi || 0,
    dailyReturn: p.dailyProfit || 0,
    weeklyReturn: p.weeklyProfit || 0,
    monthlyReturn: p.monthlyProfit || 0,
    maxDrawdown: p.maxDrawdown || 0,
    totalTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: p.winRate || 0,
    averageWinPercent: avg(wins),
    averageLossPercent: avg(losses),
    profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : (grossWin > 0 ? null : 0), // null = no losing trades
    bestTrade: best ? { symbol: best.symbol, pnlPercent: best.pnlPercent, closedAt: best.closedAt } : null,
    worstTrade: worst ? { symbol: worst.symbol, pnlPercent: worst.pnlPercent, closedAt: worst.closedAt } : null,
    longestWinStreak: streakW,
    longestLossStreak: streakL,
    averageHoldHours: p.averageHoldHours || 0,
    averageLeverage: closed.length ? round2(closed.reduce((s, t) => s + (t.leverage || 1), 0) / closed.length) : 0,
    longPercent: closed.length ? round2((closed.filter((t) => t.side === 'buy').length / closed.length) * 100) : 0,
    topSymbols,
    monthlyReturns,
    firstTradeAt: closed[0]?.openedAt || null,
    lastTradeAt: p.lastTradeAt || null,
    followers: trader.socialStats?.followers || 0,
    commissionRate: trader.settings?.commissionRate || 0
  };
};

/** GET /api/copy-trading/traders/:traderId/trades?status=all|open|closed&page=&limit= — full trade history */
export const getTraderTrades = handler(async (req, res) => {
  const trader = await Trader.findOne({ traderId: asString(req.params.traderId, 60), isActive: true }).select('traderId').lean();
  if (!trader) throw new HttpError(404, 'Trader not found');
  const { page, limit, skip } = paging(req.query, 25);
  const filter = { traderId: trader.traderId, status: { $in: ['open', 'closed'] } }; // cancelled trades never ran
  if (['open', 'closed'].includes(req.query.status)) filter.status = req.query.status;
  if (req.query.symbol) filter.symbol = asString(req.query.symbol, 20).toUpperCase();
  const [items, total, symbols] = await Promise.all([
    MasterTrade.find(filter).sort({ openedAt: -1 }).skip(skip).limit(limit).lean(),
    MasterTrade.countDocuments(filter),
    MasterTrade.distinct('symbol', { traderId: trader.traderId, status: { $in: ['open', 'closed'] } })
  ]);
  res.json({ success: true, data: { items: items.map(mapTrade), total, page, limit, pages: Math.ceil(total / limit), symbols: symbols.sort() } });
});

/** POST /api/copy-trading/copy  { traderId, amount, settings: { stopLossPercent, takeProfitPercent, copyOpenTrades } } */
export const copyTrader = handler(async (req, res) => {
  const amount = parseAmount(req.body.amount);
  if (amount === null) throw new HttpError(400, 'Enter a valid amount');
  const traderId = asString(req.body.traderId, 60);
  if (!traderId) throw new HttpError(400, 'Trader is required');
  const created = await startCopy(req.user.id, traderId, amount, req.body.settings || {});
  // Re-read: joining the trader's open trades has already moved cash into positions.
  const copy = await CopyTrade.findById(created._id).lean();
  const [valued] = await valueCopies([copy]);
  res.status(201).json({ success: true, message: `You're now copying ${copy.traderUsername}`, data: valued });
});

/** GET /api/copy-trading/copies?status=open|stopped */
export const listCopies = handler(async (req, res) => {
  const filter = { userId: req.user.id };
  filter.isOpen = req.query.status !== 'stopped';
  const copies = await CopyTrade.find(filter).sort({ createdAt: -1 }).limit(100).lean();
  const [valuedRaw, traders] = await Promise.all([
    valueCopies(copies),
    Trader.find({ traderId: { $in: [...new Set(copies.map((c) => c.traderId))] } }).select('traderId avatar verified verificationLevel').lean()
  ]);
  // Show each copy with the trader's current picture and verification tick.
  const byId = new Map(traders.map((t) => [t.traderId, t]));
  const valued = valuedRaw.map((c) => {
    const t = byId.get(c.traderId);
    return { ...c, traderAvatar: t?.avatar || c.traderAvatar, traderBadge: t ? traderBadge(t) : 'none' };
  });
  const user = await User.findById(req.user.id).select('currency balance');
  const open = valued.filter((c) => c.status !== 'stopped');
  res.json({
    success: true,
    data: {
      currency: user.currency,
      availableBalance: user.balance,
      copies: valued,
      totals: {
        allocated: round2(open.reduce((s, c) => s + c.amount, 0)),
        equity: round2(open.reduce((s, c) => s + c.equity, 0)),
        pnl: round2(open.reduce((s, c) => s + c.totalPnl, 0)),
        openPositions: open.reduce((s, c) => s + c.openPositions.length, 0)
      }
    }
  });
});

const ownCopy = async (req) => {
  if (!isValidId(req.params.id)) throw new HttpError(400, 'Invalid copy id');
  const copy = await CopyTrade.findOne({ _id: req.params.id, userId: req.user.id }).lean();
  if (!copy) throw new HttpError(404, 'Copy not found');
  return copy;
};

/** GET /api/copy-trading/copies/:id — copy detail with open positions and history */
export const getCopy = handler(async (req, res) => {
  const copy = await ownCopy(req);
  const { page, limit, skip } = paging(req.query, 25);
  const [[valued], history, total] = await Promise.all([
    valueCopies([copy]),
    CopiedTrade.find({ copyTradeId: copy._id, status: { $ne: 'open' } }).sort({ closedAt: -1 }).skip(skip).limit(limit).lean(),
    CopiedTrade.countDocuments({ copyTradeId: copy._id, status: { $ne: 'open' } })
  ]);
  res.json({ success: true, data: { copy: valued, history: history.map((h) => ({ ...h, id: h._id })), total, page, limit } });
});

/** POST /api/copy-trading/copies/:id/add-funds  { amount } */
export const addCopyFunds = handler(async (req, res) => {
  const amount = parseAmount(req.body.amount);
  if (amount === null) throw new HttpError(400, 'Enter a valid amount');
  if (!isValidId(req.params.id)) throw new HttpError(400, 'Invalid copy id');
  const copy = await addFunds(req.user.id, req.params.id, amount);
  const [valued] = await valueCopies([copy.toObject()]);
  res.json({ success: true, message: 'Funds added to your copy', data: valued });
});

const setPaused = (paused) => handler(async (req, res) => {
  if (!isValidId(req.params.id)) throw new HttpError(400, 'Invalid copy id');
  const copy = await CopyTrade.findOneAndUpdate(
    { _id: req.params.id, userId: req.user.id, status: paused ? 'active' : 'paused' },
    { $set: { status: paused ? 'paused' : 'active' } },
    { new: true }
  );
  if (!copy) throw new HttpError(400, paused ? 'Only an active copy can be paused' : 'This copy is not paused');
  res.json({
    success: true,
    message: paused ? 'Paused. Open positions stay open; new trades will not be copied.' : 'Resumed. New trades will be copied again.',
    data: copy
  });
});
export const pauseCopy = setPaused(true);
export const resumeCopy = setPaused(false);

/** PUT /api/copy-trading/copies/:id/settings  { stopLossPercent, takeProfitPercent } (null clears) */
export const updateCopySettings = handler(async (req, res) => {
  const copy = await ownCopy(req);
  if (!['active', 'paused'].includes(copy.status)) throw new HttpError(400, 'This copy is no longer active');
  const set = {};
  for (const [key, max] of [['stopLossPercent', 100], ['takeProfitPercent', 1000]]) {
    if (req.body[key] === null || req.body[key] === '') set[`settings.${key}`] = null;
    else if (req.body[key] !== undefined) {
      const n = parseAmount(req.body[key], { max });
      if (n === null) throw new HttpError(400, `Invalid ${key}`);
      set[`settings.${key}`] = n;
    }
  }
  const updated = await CopyTrade.findByIdAndUpdate(copy._id, { $set: set }, { new: true });
  res.json({ success: true, message: 'Settings saved', data: updated });
});

/** POST /api/copy-trading/copies/:id/stop — closes positions and returns funds */
export const stopCopyHandler = handler(async (req, res) => {
  const id = req.params.id || req.body.copyTradeId;
  if (!isValidId(id)) throw new HttpError(400, 'Invalid copy id');
  const { payout, copy } = await stopCopy(id, { userId: req.user.id, reason: 'user' });
  res.json({ success: true, message: `Stopped copying ${copy.traderUsername}. ${payout} ${copy.currency} returned to your balance.`, data: { payout } });
});

/** POST /api/copy-trading/positions/:id/close — close one copied position early */
export const closePosition = handler(async (req, res) => {
  if (!isValidId(req.params.id)) throw new HttpError(400, 'Invalid position id');
  const p = await closePositionEarly(req.user.id, req.params.id);
  res.json({ success: true, message: `Position closed (${p.profitLoss >= 0 ? '+' : ''}${p.profitLoss})`, data: p });
});

/** GET /api/copy-trading/history — closed positions across all copies */
export const getHistory = handler(async (req, res) => {
  const { page, limit, skip } = paging(req.query, 25);
  const filter = { userId: req.user.id, status: { $in: ['closed', 'cancelled'] }, closedReason: { $ne: 'legacy' } };
  const [items, total] = await Promise.all([
    CopiedTrade.find(filter).sort({ closedAt: -1 }).skip(skip).limit(limit).lean(),
    CopiedTrade.countDocuments(filter)
  ]);
  res.json({ success: true, data: { items: items.map((i) => ({ ...i, id: i._id })), total, page, limit } });
});

/** POST /api/copy-trading/traders/:traderId/follow  ·  DELETE to unfollow */
const setFollow = (follow) => handler(async (req, res) => {
  const traderId = asString(req.params.traderId, 60);
  const trader = await Trader.findOne({ traderId, isActive: true }).select('_id');
  if (!trader) throw new HttpError(404, 'Trader not found');
  let changed = false;
  if (follow) {
    const r = await TraderFollow.updateOne({ user: req.user.id, traderId }, { $setOnInsert: { user: req.user.id, traderId } }, { upsert: true });
    changed = r.upsertedCount === 1;
  } else {
    changed = (await TraderFollow.deleteOne({ user: req.user.id, traderId })).deletedCount === 1;
  }
  // Recount rather than increment so the number can never drift.
  const followers = await TraderFollow.countDocuments({ traderId });
  await Trader.updateOne({ _id: trader._id }, { $set: { 'socialStats.followers': followers } });
  res.json({ success: true, data: { isFollowing: follow, followers, changed } });
});
export const followTrader = setFollow(true);
export const unfollowTrader = setFollow(false);
