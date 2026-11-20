// Admin operations across the newer products: a single overview, live-market
// positions, connected wallets, user notifications and package trades.
// Mounted at /api/admin/ops
import express from 'express';
import mongoose from 'mongoose';
import { authenticate, isAdmin } from '../middleware/auth.js';
import { handler, paging } from '../services/productService.js';
import { HttpError } from '../utils/wallet.js';
import { round2 } from '../utils/money.js';
import { asString } from '../utils/validation.js';
import { getBaseCurrency, safeRateBetween } from '../services/fx.js';
import { getQuote } from '../services/marketData.js';
import { notifyUser, notifyMany } from '../services/notificationService.js';
import { closeAt } from '../controllers/marketTradingController.js';
import { settleTrade } from '../services/botTradeEngine.js';
import { getCatalog, invalidateCatalog, finishSession } from '../services/miningEngine.js';
import Setting from '../models/Setting.js';
import User from '../models/User.js';
import Notification from '../models/Notification.js';
import MarketPosition from '../models/MarketPosition.js';
import ConnectedWallet from '../models/ConnectedWallet.js';
import ColdStorageVault from '../models/ColdStorageVault.js';
import Card from '../models/Card.js';
import Trade from '../models/Trade.js';
import CopyTrade from '../models/CopyTrade.js';
import MiningSession from '../models/MiningSession.js';
import { StockHolding } from '../models/Stock.js';
import { StakePosition } from '../models/Staking.js';
import { PropertyInvestment, Property } from '../models/RealEstate.js';

const router = express.Router();
router.use(authenticate, isAdmin);

const oid = (v) => (mongoose.Types.ObjectId.isValid(v) ? new mongoose.Types.ObjectId(String(v)) : null);

/** Sum a money field grouped by currency, then convert everything into the base currency. */
const totalIn = async (Model, match, field, base, currencyField = '$currency') => {
  const rows = await Model.aggregate([
    { $match: match },
    { $group: { _id: currencyField, total: { $sum: `$${field}` }, count: { $sum: 1 } } }
  ]);
  let total = 0;
  let count = 0;
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    total += (r.total || 0) * (await safeRateBetween(r._id || base, base));
    count += r.count;
  }
  return { total: round2(total), count };
};

/** GET /overview — headline numbers for every product, in the platform base currency */
router.get('/overview', handler(async (_req, res) => {
  const base = await getBaseCurrency();
  const [
    users, balances, vaults, cards, packages, market, copies, stakes, realEstate, stocks, mining, projects
  ] = await Promise.all([
    User.countDocuments({}),
    totalIn(User, {}, 'balance', base),
    totalIn(ColdStorageVault, { status: { $ne: 'closed' } }, 'amount', base),
    totalIn(Card, { status: { $in: ['active', 'frozen'] } }, 'balance', base),
    totalIn(Trade, { status: 'in-progress' }, 'amount', base),
    totalIn(MarketPosition, { status: 'open' }, 'margin', base),
    totalIn(CopyTrade, { isOpen: true }, 'amount', base),
    StakePosition.countDocuments({ status: 'active' }),
    totalIn(PropertyInvestment, { status: 'active' }, 'amount', base),
    StockHolding.countDocuments({ shares: { $gt: 0 } }),
    MiningSession.countDocuments({ status: 'active' }),
    Property.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])
  ]);
  res.json({
    success: true,
    data: {
      currency: base,
      users,
      userBalances: balances,
      coldStorage: vaults,
      cards,
      tradingPackages: packages,
      liveMarkets: market,
      copyTrading: copies,
      staking: { count: stakes },
      realEstate: { ...realEstate, projects: Object.fromEntries(projects.map((p) => [p._id, p.n])) },
      stocks: { holders: stocks },
      mining: { activeSessions: mining }
    }
  });
}));

// ----------------------------------------------------------- live markets

/** GET /market/positions?status=open|closed&userId=&symbol= */
router.get('/market/positions', handler(async (req, res) => {
  const { page, limit, skip } = paging(req.query, 25);
  const filter = {};
  if (['open', 'closed', 'closing'].includes(req.query.status)) filter.status = req.query.status;
  if (oid(req.query.userId)) filter.user = oid(req.query.userId);
  if (req.query.symbol) filter.symbol = asString(req.query.symbol, 20).toUpperCase();
  const [items, total, open] = await Promise.all([
    MarketPosition.find(filter).populate('user', 'email firstName lastName accountId').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    MarketPosition.countDocuments(filter),
    MarketPosition.countDocuments({ status: 'open' })
  ]);
  res.json({ success: true, data: { items, total, page, limit, open } });
}));

/** POST /market/positions/:id/close  { price? } — closes at the live price (or the given one) */
router.post('/market/positions/:id/close', handler(async (req, res) => {
  const p = await MarketPosition.findOne({ _id: oid(req.params.id), status: 'open' }).lean();
  if (!p) throw new HttpError(404, 'Open position not found');
  let price = Number(req.body?.price);
  if (!(price > 0)) price = (await getQuote(p.symbol)).price;
  const closed = await closeAt(p._id, price, 'admin');
  if (!closed) throw new HttpError(409, 'Position was already closed');
  await notifyUser(closed.user, {
    type: 'trading',
    title: `Position closed · ${closed.symbol}`,
    content: `Your ${closed.side} was closed by support at ${closed.exitPrice}. P/L ${closed.pnl >= 0 ? '+' : ''}${closed.pnl} ${closed.currency}.`,
    link: '/trademain'
  });
  res.json({ success: true, message: 'Position closed', data: closed });
}));

// ----------------------------------------------------------- trading packages

/** GET /packages/trades?status=in-progress|completed|terminated */
router.get('/packages/trades', handler(async (req, res) => {
  const { page, limit, skip } = paging(req.query, 25);
  const filter = {};
  if (['in-progress', 'completed', 'terminated'].includes(req.query.status)) filter.status = req.query.status;
  if (oid(req.query.userId)) filter.userId = oid(req.query.userId);
  const [items, total] = await Promise.all([
    Trade.find(filter).populate('userId', 'email firstName lastName').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Trade.countDocuments(filter)
  ]);
  res.json({ success: true, data: { items, total, page, limit } });
}));

/** POST /packages/trades/:id/settle { mode: 'complete' | 'terminate' } */
router.post('/packages/trades/:id/settle', handler(async (req, res) => {
  const mode = req.body?.mode === 'terminate' ? 'admin_terminated' : 'admin_completed';
  const t = await settleTrade(oid(req.params.id), mode);
  if (!t) throw new HttpError(404, 'Running trade not found');
  res.json({ success: true, message: mode === 'admin_completed' ? 'Trade completed and paid' : 'Trade terminated, stake returned', data: t });
}));

// ----------------------------------------------------------- wallets

/** DELETE /wallets/:id — disconnect a wallet from a user's account */
router.delete('/wallets/:id', handler(async (req, res) => {
  const w = await ConnectedWallet.findByIdAndDelete(oid(req.params.id));
  if (!w) throw new HttpError(404, 'Wallet not found');
  res.json({ success: true, message: 'Wallet disconnected' });
}));

// ----------------------------------------------------------- notifications

/** GET /notifications — latest notifications across users */
router.get('/notifications', handler(async (req, res) => {
  const { page, limit, skip } = paging(req.query, 30);
  const filter = {};
  if (oid(req.query.userId)) filter.user = oid(req.query.userId);
  const [items, total] = await Promise.all([
    Notification.find(filter).populate('user', 'email firstName lastName').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Notification.countDocuments(filter)
  ]);
  res.json({ success: true, data: { items, total, page, limit } });
}));

/**
 * POST /notifications/send
 *   { title, content, link?, type?, userIds?: string[], audience?: 'all' | 'active' }
 */
router.post('/notifications/send', handler(async (req, res) => {
  const title = asString(req.body?.title, 140);
  const content = asString(req.body?.content, 2000);
  if (!title) throw new HttpError(400, 'A title is required');
  const payload = { title, content, type: req.body?.type || 'system', link: asString(req.body?.link, 200) };
  let ids = Array.isArray(req.body?.userIds) ? req.body.userIds.map(oid).filter(Boolean) : [];
  if (!ids.length) {
    const filter = req.body?.audience === 'active' ? { status: 'Active' } : {};
    ids = (await User.find(filter).select('_id').lean()).map((u) => u._id);
  }
  if (!ids.length) throw new HttpError(400, 'No recipients');
  const sent = await notifyMany(ids, payload);
  res.json({ success: true, message: `Sent to ${sent} user${sent === 1 ? '' : 's'}`, data: { sent, recipients: ids.length } });
}));

// ----------------------------------------------------------- mining catalog

/** GET /mining/catalog — machines and boosters with current prices (base currency) */
router.get('/mining/catalog', handler(async (_req, res) => {
  const c = await getCatalog({ includeDisabled: true });
  res.json({ success: true, data: { currency: await getBaseCurrency(), ...c } });
}));

const catalogKind = (k) => {
  const kind = k === 'boosters' ? 'boosters' : k === 'equipment' ? 'equipment' : null;
  if (!kind) throw new HttpError(400, 'kind must be equipment or boosters');
  return kind;
};
const MACHINE_TYPES = ['CPU', 'GPU', 'ASIC', 'FPGA'];
const BOOSTER_TYPES = ['hash_rate', 'energy', 'rewards'];
const LABEL = {
  price: 'Price', dailyYieldPercent: 'Daily yield %', hashRate: 'Hash rate', powerConsumption: 'Power (W)',
  multiplier: 'Multiplier', duration: 'Duration (seconds)'
};
const NUMBERS = {
  equipment: { price: [0, 1e7], dailyYieldPercent: [0, 20], hashRate: [0.01, 1e7], powerConsumption: [0, 1e6] },
  boosters: { price: [0, 1e6], multiplier: [1, 10], duration: [60, 30 * 86400] }
};

/** Validated catalog fields from a request body. `full` requires every field (new items). */
const readCatalogItem = (kind, body = {}, { full = false } = {}) => {
  const out = {};
  const errors = [];
  for (const [k, [min, max]] of Object.entries(NUMBERS[kind])) {
    if (body[k] === undefined || body[k] === '') { if (full) errors.push(`${LABEL[k]} is required`); continue; }
    const n = Number(body[k]);
    if (!Number.isFinite(n) || n < min || n > max) errors.push(`${LABEL[k]} must be between ${min} and ${max}`);
    else out[k] = n;
  }
  if (body.name !== undefined || full) {
    out.name = asString(body.name, 60);
    if (out.name.length < 2) errors.push('Enter a name');
  }
  if (body.type !== undefined || full) {
    const types = kind === 'equipment' ? MACHINE_TYPES : BOOSTER_TYPES;
    out.type = kind === 'equipment' ? String(body.type || '').toUpperCase() : String(body.type || '');
    if (!types.includes(out.type)) errors.push(`Type must be one of ${types.join(', ')}`);
  }
  if (kind === 'boosters' && body.description !== undefined) out.description = asString(body.description, 120);
  if (typeof body.enabled === 'boolean') out.enabled = body.enabled;
  if (errors.length) throw new HttpError(400, errors.join('. '));
  return out;
};

/** POST /mining/catalog/:kind  — add a machine or booster to the shop */
router.post('/mining/catalog/:kind', handler(async (req, res) => {
  const kind = catalogKind(req.params.kind);
  const item = readCatalogItem(kind, req.body, { full: true });
  const all = await getCatalog({ includeDisabled: true });
  if (Object.values(all[kind]).some((t) => t.name.toLowerCase() === item.name.toLowerCase())) throw new HttpError(409, 'An item with this name already exists');
  if (kind === 'boosters' && !item.description) {
    item.description = `${item.multiplier}x earnings for ${item.duration >= 3600 ? `${round2(item.duration / 3600)} hour(s)` : `${Math.round(item.duration / 60)} minutes`}`;
  }
  const id = `custom_${new mongoose.Types.ObjectId().toString().slice(-10)}`;
  await Setting.updateOne({}, { $set: { [`miningCatalog.${kind}.${id}`]: { ...item, custom: true, enabled: item.enabled !== false } } }, { upsert: true });
  invalidateCatalog();
  res.status(201).json({ success: true, message: `${item.name} added to the shop`, data: { id, ...(await getCatalog({ includeDisabled: true }))[kind][id] } });
}));

/** PUT /mining/catalog/:kind/:id  { name?, type?, price?, dailyYieldPercent?, hashRate?, powerConsumption?, multiplier?, duration?, description?, enabled? } */
router.put('/mining/catalog/:kind/:id', handler(async (req, res) => {
  const kind = catalogKind(req.params.kind);
  const id = asString(req.params.id, 40);
  const all = await getCatalog({ includeDisabled: true });
  if (!all[kind][id]) throw new HttpError(404, 'Item not found');
  const item = readCatalogItem(kind, req.body);
  if (item.name && Object.entries(all[kind]).some(([oid2, t]) => oid2 !== id && t.name.toLowerCase() === item.name.toLowerCase())) {
    throw new HttpError(409, 'An item with this name already exists');
  }
  if (!Object.keys(item).length) throw new HttpError(400, 'Nothing to update');
  const set = Object.fromEntries(Object.entries(item).map(([k, v]) => [`miningCatalog.${kind}.${id}.${k}`, v]));
  if (item.hashRate !== undefined || item.powerConsumption !== undefined) {
    const t = { ...all[kind][id], ...item };
    set[`miningCatalog.${kind}.${id}.efficiency`] = t.hashRate > 0 ? round2(t.powerConsumption / t.hashRate) : 0;
  }
  await Setting.updateOne({}, { $set: set }, { upsert: true });
  invalidateCatalog();
  res.json({ success: true, message: `${item.name || all[kind][id].name} saved`, data: (await getCatalog({ includeDisabled: true }))[kind][id] });
}));

/** DELETE /mining/catalog/:kind/:id — remove from the shop. Machines users own keep earning. */
router.delete('/mining/catalog/:kind/:id', handler(async (req, res) => {
  const kind = catalogKind(req.params.kind);
  const id = asString(req.params.id, 40);
  const all = await getCatalog({ includeDisabled: true });
  const item = all[kind][id];
  if (!item) throw new HttpError(404, 'Item not found');
  await Setting.updateOne({}, { $set: { [`miningCatalog.${kind}.${id}.deleted`]: true } }, { upsert: true });
  invalidateCatalog();
  res.json({ success: true, message: `${item.name} removed from the shop` });
}));

/** POST /mining/sessions/:id/stop — end a running session now and credit what it earned as a pending reward */
router.post('/mining/sessions/:id/stop', handler(async (req, res) => {
  const r = await finishSession(oid(req.params.id), 'admin');
  if (!r) throw new HttpError(404, 'Active session not found');
  res.json({ success: true, message: 'Session stopped', data: r });
}));

export default router;
