// Admin copy trading API: manage traders, place/close their trades, oversee copies.
// Money movement is delegated to services/copyTradingEngine.js.
import path from 'path';
import Trader from '../models/Trader.js';
import MasterTrade from '../models/MasterTrade.js';
import CopyTrade from '../models/CopyTrade.js';
import CopiedTrade from '../models/CopiedTrade.js';
import { uploadDir, safeFileName } from '../config/paths.js';
import { parseAmount, round2 } from '../utils/money.js';
import { asString, escapeRegex } from '../utils/validation.js';
import { HttpError } from '../utils/wallet.js';
import { handler, paging } from '../services/productService.js';
import { createDefaultAvatar } from '../services/traderAvatar.js';
import TraderFollow from '../models/TraderFollow.js';
import {
  openMasterTrade, closeMasterTrade, updateMarkPrice, stopCopy, valueCopies, recomputeTraderStats, pnlPercentAt, isValidId
} from '../services/copyTradingEngine.js';

const STYLES = ['scalping', 'day', 'swing', 'position', 'arbitrage', 'algorithmic'];
const MARKETS = ['crypto', 'forex', 'stocks', 'commodities', 'indices'];
const RISK = ['low', 'medium', 'high', 'very_high'];
const EXPERIENCE = ['beginner', 'intermediate', 'advanced', 'expert'];
const LEVELS = ['unverified', 'basic', 'advanced', 'pro'];

const toList = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((s) => String(s).trim());

const findTrader = async (traderId) => {
  const trader = await Trader.findOne({ traderId: asString(traderId, 60) });
  if (!trader) throw new HttpError(404, 'Trader not found');
  return trader;
};

/** Profile fields an admin may edit. Performance is computed, never accepted from input. */
const profileFields = (body) => {
  const out = {};
  if (body.username !== undefined) {
    const u = asString(body.username, 40);
    if (!/^[A-Za-z0-9_.-]{3,40}$/.test(u)) throw new HttpError(400, 'Username must be 3-40 letters, numbers, _ . -');
    out.username = u;
  }
  if (body.email !== undefined) out.email = asString(body.email, 120).toLowerCase();
  for (const k of ['fullName', 'country', 'avatar']) if (body[k] !== undefined) out[k] = asString(body[k], k === 'avatar' ? 500 : 80);
  if (body.bio !== undefined) out.bio = asString(body.bio, 1000);
  if (body.tradingStyle !== undefined) out.tradingStyle = toList(body.tradingStyle).filter((s) => STYLES.includes(s));
  if (body.markets !== undefined) out.markets = toList(body.markets).filter((s) => MARKETS.includes(s));
  if (EXPERIENCE.includes(body.tradingExperience)) out.tradingExperience = body.tradingExperience;
  if (RISK.includes(body.riskLevel)) out['riskMetrics.riskLevel'] = body.riskLevel;
  return out;
};

const MIN_COPY_FLOOR = 1;

const settingsFields = (body) => {
  const out = {};
  if (typeof body.allowCopying === 'boolean') out['settings.allowCopying'] = body.allowCopying;
  for (const [k, max] of [['minCopyAmount', 1e9], ['maxCopiers', 1e7], ['commissionRate', 50]]) {
    if (body[k] !== undefined) {
      // Every trader must have a minimum copy amount of at least 1 (base currency).
      const n = parseAmount(body[k], { allowZero: k !== 'minCopyAmount', max });
      if (n === null || (k === 'minCopyAmount' && n < MIN_COPY_FLOOR)) {
        throw new HttpError(400, k === 'minCopyAmount' ? `Minimum copy amount must be at least ${MIN_COPY_FLOOR}` : `Invalid ${k}`);
      }
      out[`settings.${k}`] = k === 'maxCopiers' ? Math.floor(n) : n;
    }
  }
  return out;
};

/* ------------------------------ Traders ------------------------------ */

/** GET /traders?search=&status=active|inactive&page=&limit=&sortBy=&sortOrder= */
export const getAllTraders = handler(async (req, res) => {
  const { page, limit, skip } = paging(req.query, 20);
  const query = {};
  if (req.query.search) {
    const rx = new RegExp(escapeRegex(req.query.search), 'i');
    query.$or = [{ username: rx }, { fullName: rx }, { email: rx }, { traderId: rx }];
  }
  if (req.query.status === 'active') query.isActive = true;
  if (req.query.status === 'inactive') query.isActive = false;
  if (req.query.verification === 'verified') query.verified = true;
  if (req.query.verification === 'unverified') query.verified = false;

  const sortable = ['joinedDate', 'username', 'performance.roi', 'performance.winRate', 'socialStats.activeCopiers', 'createdAt'];
  const sortBy = sortable.includes(req.query.sortBy) ? req.query.sortBy : 'joinedDate';
  const [traders, total] = await Promise.all([
    Trader.find(query).sort({ [sortBy]: req.query.sortOrder === 'asc' ? 1 : -1 }).skip(skip).limit(limit).lean(),
    Trader.countDocuments(query)
  ]);

  const ids = traders.map((t) => t.traderId);
  const [copyAgg, openAgg] = await Promise.all([
    CopyTrade.aggregate([
      { $match: { traderId: { $in: ids }, isOpen: true } },
      { $group: { _id: '$traderId', copiers: { $sum: 1 }, aum: { $sum: '$amount' } } }
    ]),
    MasterTrade.aggregate([
      { $match: { traderId: { $in: ids }, status: 'open' } },
      { $group: { _id: '$traderId', open: { $sum: 1 } } }
    ])
  ]);
  const copies = new Map(copyAgg.map((c) => [c._id, c]));
  const opens = new Map(openAgg.map((o) => [o._id, o.open]));

  res.json({
    success: true,
    traders: traders.map((t) => ({
      ...t,
      id: t._id,
      stats: {
        activeCopies: copies.get(t.traderId)?.copiers || 0,
        assetsUnderCopy: round2(copies.get(t.traderId)?.aum || 0),
        openTrades: opens.get(t.traderId) || 0
      }
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasNextPage: page * limit < total, hasPrevPage: page > 1 }
  });
});

/** POST /traders */
export const createTrader = handler(async (req, res) => {
  const fields = profileFields(req.body);
  if (!fields.username || !fields.email) throw new HttpError(400, 'Username and email are required');
  const exists = await Trader.exists({ $or: [{ username: fields.username }, { email: fields.email }] });
  if (exists) throw new HttpError(400, 'A trader with this username or email already exists');

  const settings = settingsFields(req.body);
  const trader = new Trader({
    traderId: `TR-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`,
    verificationLevel: 'basic',
    joinedDate: new Date()
  });
  trader.set(fields);
  trader.set(settings);
  if (req.body.badge === 'gold') trader.set({ verified: true, verificationLevel: 'pro' });
  if (req.body.badge === 'blue') trader.set({ verified: true, verificationLevel: 'advanced' });
  if (!trader.avatar) trader.avatar = createDefaultAvatar(trader);
  await trader.save();
  res.status(201).json({ success: true, message: 'Trader created', trader });
});

/** GET /traders/:traderId */
export const getTraderDetails = handler(async (req, res) => {
  const trader = await findTrader(req.params.traderId);
  const [openTrades, closedTrades, copies] = await Promise.all([
    MasterTrade.find({ traderId: trader.traderId, status: 'open' }).sort({ openedAt: -1 }).lean(),
    MasterTrade.find({ traderId: trader.traderId, status: { $in: ['closed', 'cancelled'] } }).sort({ closedAt: -1 }).limit(50).lean(),
    CopyTrade.find({ traderId: trader.traderId, isOpen: true }).lean()
  ]);
  res.json({
    success: true,
    trader,
    openTrades: openTrades.map((m) => ({ ...m, id: m._id, unrealizedPercent: pnlPercentAt(m, m.markPrice || m.entryPrice) })),
    closedTrades: closedTrades.map((m) => ({ ...m, id: m._id })),
    copiers: { active: copies.length, assetsUnderCopy: round2(copies.reduce((s, c) => s + c.amount, 0)) }
  });
});

/** PUT /traders/:traderId/profile */
export const updateTraderProfile = handler(async (req, res) => {
  const trader = await findTrader(req.params.traderId);
  const fields = profileFields(req.body);
  trader.set(fields);
  // Every trader keeps a picture: clearing it (or renaming a default one) regenerates the default.
  if (!trader.avatar || (trader.avatar.includes('/default_') && (fields.username || fields.fullName))) {
    trader.avatar = createDefaultAvatar(trader);
  }
  await trader.save();
  if (fields.username || fields.avatar !== undefined) {
    await CopyTrade.updateMany({ traderId: trader.traderId }, { $set: { traderUsername: trader.username, traderAvatar: trader.avatar } });
  }
  res.json({ success: true, message: 'Profile updated', trader });
});

/** PUT /traders/:traderId/settings */
export const updateTraderSettings = handler(async (req, res) => {
  const trader = await Trader.findOneAndUpdate({ traderId: asString(req.params.traderId, 60) }, { $set: settingsFields(req.body) }, { new: true });
  if (!trader) throw new HttpError(404, 'Trader not found');
  res.json({ success: true, message: 'Settings updated', trader });
});

/** PUT /traders/:traderId/status  { isActive } — deactivating hides the trader and blocks new copies */
export const updateTraderStatus = handler(async (req, res) => {
  const isActive = req.body.isActive === true || req.body.status === 'active';
  const trader = await Trader.findOneAndUpdate({ traderId: asString(req.params.traderId, 60) }, { $set: { isActive } }, { new: true });
  if (!trader) throw new HttpError(404, 'Trader not found');
  res.json({ success: true, message: isActive ? 'Trader activated' : 'Trader deactivated', trader });
});

/**
 * PUT /traders/:traderId/verification
 *   { badge: 'gold' | 'blue' | 'none' }        simplest: gold tick, blue tick or unverified
 *   { verified, verificationLevel }           fine-grained (level 'pro' + verified = gold tick)
 */
export const updateTraderVerification = handler(async (req, res) => {
  const set = {};
  if (req.body.badge === 'gold') Object.assign(set, { verified: true, verificationLevel: 'pro' });
  else if (req.body.badge === 'blue') Object.assign(set, { verified: true, verificationLevel: 'advanced' });
  else if (req.body.badge === 'none') Object.assign(set, { verified: false, verificationLevel: 'unverified' });
  if (!req.body.badge) {
    if (typeof req.body.verified === 'boolean') set.verified = req.body.verified;
    if (LEVELS.includes(req.body.verificationLevel)) set.verificationLevel = req.body.verificationLevel;
  }
  const trader = await Trader.findOneAndUpdate({ traderId: asString(req.params.traderId, 60) }, { $set: set }, { new: true });
  if (!trader) throw new HttpError(404, 'Trader not found');
  res.json({ success: true, trader });
});

/** POST /traders/:traderId/avatar  (multipart field "avatar") */
export const uploadTraderAvatar = handler(async (req, res) => {
  const trader = await findTrader(req.params.traderId);
  const file = req.files?.avatar;
  if (!file) throw new HttpError(400, 'No file uploaded');
  const ext = path.extname(file.name || '').toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) throw new HttpError(400, 'Allowed: JPG, PNG, WebP, GIF');
  if (file.size > 2 * 1024 * 1024) throw new HttpError(400, 'Maximum size is 2MB');
  const filename = safeFileName(`trader_${trader.traderId}_${Date.now()}${ext}`);
  await file.mv(path.join(uploadDir('traders'), filename));
  trader.avatar = `/uploads/traders/${filename}`;
  await trader.save();
  await CopyTrade.updateMany({ traderId: trader.traderId }, { $set: { traderAvatar: trader.avatar } });
  res.json({ success: true, avatar: trader.avatar, trader });
});

/** DELETE /traders/:traderId — stops every copy (refunding copiers), cancels open trades, removes the trader */
export const deleteTrader = handler(async (req, res) => {
  const trader = await findTrader(req.params.traderId);
  await Trader.updateOne({ _id: trader._id }, { $set: { isActive: false, 'settings.allowCopying': false } });

  const open = await MasterTrade.find({ traderId: trader.traderId, status: 'open' }).select('_id').lean();
  for (const m of open) {
    // eslint-disable-next-line no-await-in-loop
    await closeMasterTrade(m._id, null, { cancel: true });
  }
  const copies = await CopyTrade.find({ traderId: trader.traderId, status: { $in: ['active', 'paused'] } }).select('_id').lean();
  let refunded = 0;
  for (const c of copies) {
    // eslint-disable-next-line no-await-in-loop
    const r = await stopCopy(c._id, { reason: 'trader_removed' });
    refunded += r.payout;
  }
  await Trader.deleteOne({ _id: trader._id });
  await TraderFollow.deleteMany({ traderId: trader.traderId });
  res.json({ success: true, message: `Trader removed. ${copies.length} copies stopped and refunded (${round2(refunded)} total).` });
});

/* ------------------------------ Trades ------------------------------ */

const tradeInput = (body) => {
  const symbol = asString(body.symbol, 20).toUpperCase();
  const side = String(body.side || '').toLowerCase();
  const entryPrice = parseAmount(body.entryPrice);
  const allocationPercent = body.allocationPercent === undefined ? 10 : parseAmount(body.allocationPercent, { max: 100 });
  const leverage = body.leverage === undefined ? 1 : parseAmount(body.leverage, { max: 100 });
  if (!/^[A-Z0-9./_-]{2,20}$/.test(symbol)) throw new HttpError(400, 'Invalid symbol');
  if (!['buy', 'sell'].includes(side)) throw new HttpError(400, 'Side must be buy or sell');
  if (!entryPrice) throw new HttpError(400, 'Invalid entry price');
  if (!allocationPercent || allocationPercent < 0.1) throw new HttpError(400, 'allocationPercent must be between 0.1 and 100');
  if (!leverage || leverage < 1) throw new HttpError(400, 'leverage must be between 1 and 100');
  return { symbol, side, entryPrice, allocationPercent, leverage, notes: asString(body.notes, 500) };
};

/** GET /traders/:traderId/trades?status=open|closed|cancelled */
const listTrades = async (req, res, forcedStatus) => {
  const trader = await findTrader(req.params.traderId);
  const { page, limit, skip } = paging(req.query, 50);
  const filter = { traderId: trader.traderId };
  const status = forcedStatus || req.query.status;
  if (['open', 'closed', 'cancelled'].includes(status)) filter.status = status;
  const [trades, total] = await Promise.all([
    MasterTrade.find(filter).sort({ openedAt: -1 }).skip(skip).limit(limit).lean(),
    MasterTrade.countDocuments(filter)
  ]);
  res.json({
    success: true,
    trades: trades.map((m) => ({ ...m, id: m._id, tradeId: m._id, unrealizedPercent: m.status === 'open' ? pnlPercentAt(m, m.markPrice || m.entryPrice) : undefined })),
    total, page, limit
  });
};
export const getTraderTrades = handler((req, res) => listTrades(req, res));

/** POST /traders/:traderId/trades  { symbol, side, entryPrice, allocationPercent?, leverage?, notes? } */
export const addTradeToTrader = handler(async (req, res) => {
  const trader = await findTrader(req.params.traderId || req.body.traderId);
  if (!trader.isActive) throw new HttpError(400, 'Trader is inactive');
  const master = await openMasterTrade(trader, tradeInput(req.body));
  res.status(201).json({ success: true, message: `Trade opened and copied to ${master.copiedCount} copier(s)`, trade: master });
});

/** POST /traders/:traderId/trades/bulk  { trades: [...] } — opens several trades */
export const bulkAddTrades = handler(async (req, res) => {
  const trader = await findTrader(req.params.traderId);
  const list = Array.isArray(req.body.trades) ? req.body.trades.slice(0, 50) : [];
  if (!list.length) throw new HttpError(400, 'trades array is required');
  const inputs = list.map(tradeInput); // validate all before opening any
  const opened = [];
  for (const input of inputs) {
    // eslint-disable-next-line no-await-in-loop
    opened.push(await openMasterTrade(trader, input));
  }
  res.status(201).json({ success: true, message: `${opened.length} trades opened`, trades: opened });
});

const findMaster = async (traderId, tradeId) => {
  if (!isValidId(tradeId)) throw new HttpError(400, 'Invalid trade id');
  const m = await MasterTrade.findOne({ _id: tradeId, traderId: asString(traderId, 60) });
  if (!m) throw new HttpError(404, 'Trade not found');
  return m;
};

/**
 * PUT /traders/:traderId/trades/:tradeId
 *   { markPrice }                       update the live price
 *   { notes }                           edit notes
 *   { status: 'closed', exitPrice }     close (kept for older admin clients)
 */
export const updateTraderTrade = handler(async (req, res) => {
  const m = await findMaster(req.params.traderId, req.params.tradeId);
  if (req.body.status === 'closed') {
    const exit = parseAmount(req.body.exitPrice);
    if (!exit) throw new HttpError(400, 'exitPrice is required to close a trade');
    const { master, settled } = await closeMasterTrade(m._id, exit);
    return res.json({ success: true, message: `Trade closed. ${settled} position(s) settled.`, trade: master });
  }
  if (m.status !== 'open') throw new HttpError(400, 'Closed trades cannot be edited');
  if (req.body.notes !== undefined) {
    m.notes = asString(req.body.notes, 500);
    await m.save();
  }
  if (req.body.markPrice !== undefined || req.body.currentPrice !== undefined) {
    const price = parseAmount(req.body.markPrice ?? req.body.currentPrice);
    if (!price) throw new HttpError(400, 'Invalid markPrice');
    await updateMarkPrice({ masterTradeId: m._id, price });
  }
  const fresh = await MasterTrade.findById(m._id).lean();
  res.json({ success: true, message: 'Trade updated', trade: { ...fresh, unrealizedPercent: pnlPercentAt(fresh, fresh.markPrice || fresh.entryPrice) } });
});

/** POST /traders/:traderId/trades/:tradeId/close  { exitPrice } */
export const closeTraderTrade = handler(async (req, res) => {
  const m = await findMaster(req.params.traderId, req.params.tradeId);
  const exit = parseAmount(req.body.exitPrice ?? req.body.closePrice);
  if (!exit) throw new HttpError(400, 'exitPrice is required');
  const { master, settled } = await closeMasterTrade(m._id, exit);
  res.json({ success: true, message: `Trade closed at ${exit} (${round2(master.pnlPercent)}%). ${settled} position(s) settled.`, trade: master });
});

/** DELETE /traders/:traderId/trades/:tradeId — cancels an open trade; copiers get their margin back with no P/L */
export const deleteTraderTrade = handler(async (req, res) => {
  const m = await findMaster(req.params.traderId, req.params.tradeId);
  if (m.status !== 'open') throw new HttpError(400, 'Only open trades can be cancelled. Closed trades are part of the track record.');
  const { settled } = await closeMasterTrade(m._id, null, { cancel: true });
  res.json({ success: true, message: `Trade cancelled. ${settled} position(s) refunded.` });
});

/** GET /traders/:traderId/open-trades */
export const getTraderOpenTrades = handler((req, res) => listTrades(req, res, 'open'));

/** POST /update-prices  { prices: [{ symbol, price, traderId? } | { tradeId, price }] } */
export const updatePrices = handler(async (req, res) => {
  const list = Array.isArray(req.body.prices) ? req.body.prices.slice(0, 500) : [];
  if (!list.length) throw new HttpError(400, 'prices array is required');
  let updated = 0;
  for (const p of list) {
    const price = parseAmount(p?.price ?? p?.markPrice);
    if (!price) continue;
    // eslint-disable-next-line no-await-in-loop
    updated += await updateMarkPrice({
      masterTradeId: isValidId(p.tradeId) ? p.tradeId : undefined,
      symbol: p.tradeId ? undefined : asString(p.symbol, 20),
      traderId: p.traderId ? asString(p.traderId, 60) : undefined,
      price
    });
  }
  res.json({ success: true, message: `${updated} open trade(s) repriced` });
});

/* ------------------------------ Copies ------------------------------ */

/** GET /traders/:traderId/copiers */
export const getTraderCopiers = handler(async (req, res) => {
  const trader = await findTrader(req.params.traderId);
  const copies = await CopyTrade.find({ traderId: trader.traderId }).populate('userId', 'email firstName lastName accountId').sort({ createdAt: -1 }).limit(500).lean();
  res.json({ success: true, copiers: await valueCopies(copies) });
});

/** GET /copies?status=active|paused|stopped&traderId= */
export const getAllCopies = handler(async (req, res) => {
  const { page, limit, skip } = paging(req.query, 25);
  const filter = {};
  if (['active', 'paused', 'stopped'].includes(req.query.status)) filter.status = req.query.status;
  if (req.query.traderId) filter.traderId = asString(req.query.traderId, 60);
  const [copies, total] = await Promise.all([
    CopyTrade.find(filter).populate('userId', 'email firstName lastName accountId').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    CopyTrade.countDocuments(filter)
  ]);
  res.json({ success: true, copies: await valueCopies(copies), total, page, limit });
});

const setCopyStatus = (from, to) => handler(async (req, res) => {
  if (!isValidId(req.params.copyId)) throw new HttpError(400, 'Invalid copy id');
  const copy = await CopyTrade.findOneAndUpdate({ _id: req.params.copyId, status: from }, { $set: { status: to } }, { new: true });
  if (!copy) throw new HttpError(400, `Copy is not ${from}`);
  res.json({ success: true, copy });
});
export const suspendCopyTrader = setCopyStatus('active', 'paused');
export const resumeCopyTrader = setCopyStatus('paused', 'active');

/** POST /copies/:copyId/force-stop — closes positions at mark and refunds the user */
export const forceStopCopyTrade = handler(async (req, res) => {
  if (!isValidId(req.params.copyId)) throw new HttpError(400, 'Invalid copy id');
  const { payout } = await stopCopy(req.params.copyId, { reason: 'admin' });
  res.json({ success: true, message: `Copy stopped. ${payout} returned to the user.` });
});

/** GET /positions?status=open|closed&traderId= */
export const getAllPositions = handler(async (req, res) => {
  const { page, limit, skip } = paging(req.query, 50);
  const filter = { closedReason: { $ne: 'legacy' } };
  if (['open', 'closed', 'cancelled'].includes(req.query.status)) filter.status = req.query.status;
  if (req.query.traderId) filter.traderId = asString(req.query.traderId, 60);
  const [items, total] = await Promise.all([
    CopiedTrade.find(filter).populate('userId', 'email firstName lastName accountId').sort({ openedAt: -1 }).skip(skip).limit(limit).lean(),
    CopiedTrade.countDocuments(filter)
  ]);
  res.json({ success: true, positions: items, total, page, limit });
});

/** GET /platform/stats */
export const getPlatformCopyStats = handler(async (_req, res) => {
  const [traders, activeTraders, copyAgg, openTrades, settledAgg] = await Promise.all([
    Trader.countDocuments(),
    Trader.countDocuments({ isActive: true }),
    CopyTrade.aggregate([{ $match: { isOpen: true } }, { $group: { _id: null, copies: { $sum: 1 }, aum: { $sum: '$amount' }, users: { $addToSet: '$userId' } } }]),
    MasterTrade.countDocuments({ status: 'open' }),
    CopiedTrade.aggregate([
      { $match: { status: 'closed', masterTradeId: { $exists: true } } },
      { $group: { _id: null, positions: { $sum: 1 }, pnl: { $sum: '$profitLoss' }, commission: { $sum: '$commission' } } }
    ])
  ]);
  res.json({
    success: true,
    stats: {
      traders,
      activeTraders,
      activeCopies: copyAgg[0]?.copies || 0,
      copiers: copyAgg[0]?.users?.length || 0,
      assetsUnderCopy: round2(copyAgg[0]?.aum || 0),
      openMasterTrades: openTrades,
      settledPositions: settledAgg[0]?.positions || 0,
      copierPnl: round2(settledAgg[0]?.pnl || 0),
      commissionEarned: round2(settledAgg[0]?.commission || 0)
    }
  });
});

/** POST /traders/:traderId/recompute — rebuild stats from trade history */
export const recomputeStats = handler(async (req, res) => {
  const trader = await findTrader(req.params.traderId);
  await recomputeTraderStats(trader.traderId);
  res.json({ success: true, trader: await Trader.findById(trader._id) });
});
