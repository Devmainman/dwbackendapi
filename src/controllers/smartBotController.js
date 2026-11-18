// AI Smart Trader: admin bot setup, user subscriptions (paid with the normal
// payment methods, reviewed in Bot Invoices), and the user's trade history.
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import SmartBot from '../models/SmartBot.js';
import BotSubscription, { OPEN_SUB_STATUSES } from '../models/BotSubscription.js';
import BotTrade from '../models/BotTrade.js';
import Transaction from '../models/Transaction.js';
import PaymentMethod from '../models/PaymentMethod.js';
import User from '../models/User.js';
import { asString } from '../utils/validation.js';
import { HttpError, convertFromBase } from '../utils/wallet.js';
import { getBaseCurrency } from '../services/fx.js';
import { handler, notify, paging } from '../services/productService.js';
import { catchUpUser } from '../services/smartBotEngine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const num = (v) => {
  const n = Number(String(v ?? '').replace(/,/g, '').match(/-?\d+(\.\d+)?/)?.[0]);
  return Number.isFinite(n) ? n : NaN;
};
const oid = (id) => { if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, 'Invalid id'); return id; };

/* ============================ Admin: bots ============================ */

const readBot = (b, partial) => {
  const out = {};
  const errors = [];
  const has = (k) => !partial || b[k] !== undefined;
  if (has('name')) { out.name = asString(b.name, 60); if (!out.name) errors.push('Bot name is required'); }
  if (b.description !== undefined) out.description = asString(b.description, 400);
  if (b.strategy !== undefined) out.strategy = asString(b.strategy, 60);
  const numField = (k, label, { min = 0, max = Infinity, int = false, required = false } = {}) => {
    if (!has(k) && !required) return;
    if ((b[k] === undefined || String(b[k]).trim() === '') && !required) return;
    const n = num(b[k]);
    if (!Number.isFinite(n) || n < min || n > max) { errors.push(`${label} must be a number${max < Infinity ? ` from ${min} to ${max}` : ` of at least ${min}`}`); return; }
    out[k] = int ? Math.round(n) : Math.round(n * 100) / 100;
  };
  numField('price', 'Price', { required: !partial });
  numField('tradeLimit', 'Trade limit', { min: 1, max: 100000, int: true, required: !partial });
  numField('tradeIntervalMinutes', 'Minutes between trades', { min: 1, max: 10080, int: true });
  numField('minAllocation', 'Minimum capital');
  numField('winRate', 'Win rate', { max: 100 });
  numField('profitMin', 'Smallest profit %', { max: 100 });
  numField('profitMax', 'Largest profit %', { max: 100 });
  numField('lossMin', 'Smallest loss %', { max: 100 });
  numField('lossMax', 'Largest loss %', { max: 100 });
  if (b.markets !== undefined) {
    const list = Array.isArray(b.markets) ? b.markets : String(b.markets).split(/[\s,]+/);
    out.markets = list.map((m) => String(m).toUpperCase().replace(/[^A-Z0-9]/g, '')).filter(Boolean).slice(0, 20);
    if (!out.markets.length) errors.push('Add at least one market, e.g. BTC');
  }
  if (b.status !== undefined) out.status = b.status === 'unavailable' ? 'unavailable' : 'available';
  if (out.profitMin > out.profitMax) errors.push('Smallest profit % cannot be above the largest');
  if (out.lossMin > out.lossMax) errors.push('Smallest loss % cannot be above the largest');
  return { out, errors };
};

export const adminListBots = handler(async (_req, res) => {
  const [items, currency, stats] = await Promise.all([
    SmartBot.find().sort({ sortOrder: 1, createdAt: -1 }).lean(),
    getBaseCurrency(),
    BotSubscription.aggregate([{ $group: { _id: '$bot', subs: { $sum: 1 }, active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } }, trades: { $sum: '$tradesUsed' } } }])
  ]);
  const by = Object.fromEntries(stats.map((s) => [String(s._id), s]));
  res.json({ success: true, data: { items: items.map((b) => ({ ...b, subscribers: by[String(b._id)]?.subs || 0, active: by[String(b._id)]?.active || 0, tradesPlaced: by[String(b._id)]?.trades || 0 })), currency } });
});

export const adminCreateBot = handler(async (req, res) => {
  const { out, errors } = readBot(req.body, false);
  if (errors.length) throw new HttpError(400, errors.join('. '));
  res.status(201).json({ success: true, data: await SmartBot.create(out) });
});

export const adminUpdateBot = handler(async (req, res) => {
  const { out, errors } = readBot(req.body, true);
  if (errors.length) throw new HttpError(400, errors.join('. '));
  const bot = await SmartBot.findByIdAndUpdate(oid(req.params.id), { $set: out }, { new: true, runValidators: true });
  if (!bot) throw new HttpError(404, 'Bot not found');
  res.json({ success: true, data: bot });
});

/* ============================ User ============================ */

/** GET /api/smart-bots  -> available bots priced for the user */
export const userBots = handler(async (req, res) => {
  const user = await User.findById(req.user.id).select('currency').lean();
  const bots = await SmartBot.find({ status: 'available' }).sort({ sortOrder: 1, createdAt: -1 }).lean();
  const items = await Promise.all(bots.map(async (b) => {
    const [p, m] = await Promise.all([convertFromBase(b.price, user?.currency), convertFromBase(b.minAllocation || 0, user?.currency)]);
    return { _id: b._id, name: b.name, description: b.description, strategy: b.strategy, tradeLimit: b.tradeLimit, tradeIntervalMinutes: b.tradeIntervalMinutes, winRate: b.winRate, markets: b.markets, price: p.amount, minAllocation: m.amount, currency: p.currency };
  }));
  res.json({ success: true, data: { items } });
});

/** GET /api/smart-bots/subscriptions  -> the user's bots with live progress and recent trades */
export const userSubscriptions = handler(async (req, res) => {
  await catchUpUser(req.user.id).catch(() => 0);
  const subs = await BotSubscription.find({ user: req.user.id, status: { $ne: 'cancelled' } }).sort({ createdAt: -1 }).lean();
  const trades = await BotTrade.find({ subscription: { $in: subs.map((s) => s._id) } }).sort({ closedAt: -1 }).limit(300).lean();
  const bySub = {};
  for (const t of trades) (bySub[String(t.subscription)] ||= []).push(t);
  res.json({
    success: true,
    data: {
      items: subs.map((s) => ({
        _id: s._id, bot: s.bot, botName: s.botSnapshot?.name, strategy: s.botSnapshot?.strategy, markets: s.botSnapshot?.markets,
        tradeIntervalMinutes: s.botSnapshot?.tradeIntervalMinutes, status: s.status, allocation: s.allocation, currency: s.currency,
        tradeLimit: s.tradeLimit, tradesUsed: s.tradesUsed, tradesLeft: Math.max(0, s.tradeLimit - s.tradesUsed),
        wins: s.wins, losses: s.losses, totalPnl: Math.round((s.totalPnl || 0) * 100) / 100, nextTradeAt: s.status === 'active' ? s.nextTradeAt : null,
        startedAt: s.startedAt, completedAt: s.completedAt, createdAt: s.createdAt,
        payment: { status: s.payment?.status, amount: s.payment?.amount, currency: s.payment?.currency, note: s.payment?.note },
        trades: (bySub[String(s._id)] || []).slice(0, 50)
      }))
    }
  });
});

/** POST /api/smart-bots/:id/subscribe  { allocation } -> subscription awaiting payment */
export const userSubscribe = handler(async (req, res) => {
  const bot = await SmartBot.findOne({ _id: oid(req.params.id), status: 'available' }).lean();
  if (!bot) throw new HttpError(404, 'This bot is no longer available');
  const user = await User.findById(req.user.id).select('currency').lean();
  const [price, min] = await Promise.all([convertFromBase(bot.price, user?.currency), convertFromBase(bot.minAllocation || 0, user?.currency)]);
  const allocation = Math.round(num(req.body.allocation) * 100) / 100;
  if (!(allocation > 0)) throw new HttpError(400, 'Enter how much capital the bot should trade with');
  if (allocation < min.amount) throw new HttpError(400, `This bot needs at least ${min.amount} ${min.currency} of capital`);

  const open = await BotSubscription.findOne({ user: req.user.id, bot: bot._id, status: { $in: OPEN_SUB_STATUSES } }).lean();
  if (open) throw new HttpError(409, open.status === 'active' ? 'This bot is already trading for you' : 'You already have a subscription to this bot waiting. Continue it from My bots.');

  const sub = await BotSubscription.create({
    user: req.user.id, bot: bot._id,
    botSnapshot: {
      name: bot.name, strategy: bot.strategy, tradeLimit: bot.tradeLimit, tradeIntervalMinutes: bot.tradeIntervalMinutes,
      winRate: bot.winRate, profitMin: bot.profitMin, profitMax: bot.profitMax, lossMin: bot.lossMin, lossMax: bot.lossMax, markets: bot.markets,
      price: bot.price, baseCurrency: await getBaseCurrency()
    },
    allocation, currency: price.currency, tradeLimit: bot.tradeLimit,
    payment: { status: 'unpaid', amount: price.amount, currency: price.currency }
  });
  res.status(201).json({ success: true, data: { _id: sub._id, amount: price.amount, currency: price.currency } });
});

/** POST /api/smart-bots/subscriptions/:id/pay  (multipart: paymentMethod, paymentProof) */
export const userPaySubscription = handler(async (req, res) => {
  const paymentMethod = asString(req.body.paymentMethod, 80);
  if (!paymentMethod) throw new HttpError(400, 'Choose a payment method');
  if (!req.files?.paymentProof) throw new HttpError(400, 'Upload your payment proof');
  const method = await PaymentMethod.findOne({ methodId: paymentMethod, isActive: true }).lean();
  if (!method) throw new HttpError(400, 'This payment method is not available. Choose another one.');

  const sub = await BotSubscription.findOne({ _id: oid(req.params.id), user: req.user.id });
  if (!sub) throw new HttpError(404, 'Subscription not found');
  if (sub.status !== 'awaiting_payment') throw new HttpError(409, sub.status === 'pending' ? 'Your payment is already being reviewed' : 'This subscription is not waiting for payment');

  const user = await User.findById(req.user.id).select('currency').lean();
  const quote = await convertFromBase(sub.botSnapshot.price, user?.currency);
  const file = req.files.paymentProof;
  const name = `${uuidv4()}${path.extname(file.name || '') || '.jpg'}`;
  await file.mv(path.join(__dirname, '../uploads/invoices', name));
  const reference = `BOT-${uuidv4().replace(/-/g, '').slice(0, 12).toUpperCase()}`;

  const updated = await BotSubscription.findOneAndUpdate(
    { _id: sub._id, status: 'awaiting_payment' },
    { $set: {
      status: 'pending',
      'payment.status': 'pending', 'payment.amount': quote.amount, 'payment.currency': quote.currency,
      'payment.paymentMethod': method.title || paymentMethod, 'payment.proof': `/uploads/invoices/${name}`,
      'payment.reference': reference, 'payment.submittedAt': new Date(), 'payment.note': ''
    } },
    { new: true }
  );
  if (!updated) throw new HttpError(409, 'Your payment is already being reviewed');
  const tx = await Transaction.create({
    userId: sub.user, amount: quote.amount, currency: quote.currency, type: 'trade', status: 'pending', reference,
    metadata: { source: 'ai_smart_trader_subscription', bot: sub.botSnapshot.name, subscription: String(sub._id), method: method.title }
  });
  await BotSubscription.updateOne({ _id: sub._id }, { $set: { 'payment.transaction': tx._id } });
  res.json({ success: true, message: 'Payment submitted. Your bot starts trading once it is approved.' });
});

/** POST /api/smart-bots/subscriptions/:id/cancel  (only before paying) */
export const userCancelSubscription = handler(async (req, res) => {
  const s = await BotSubscription.findOneAndUpdate({ _id: oid(req.params.id), user: req.user.id, status: 'awaiting_payment' }, { $set: { status: 'cancelled' } });
  if (!s) throw new HttpError(409, 'This subscription can no longer be cancelled');
  res.json({ success: true });
});

/* ============================ Admin: Bot Invoices ============================ */

export const adminListSubscriptions = handler(async (req, res) => {
  const { page, limit, skip } = paging(req.query, 20);
  const q = {};
  const st = String(req.query.status || '');
  if (st) q.status = st;
  if (req.query.search) {
    const rx = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const users = await User.find({ $or: [{ email: rx }, { firstName: rx }, { lastName: rx }] }).select('_id').limit(200).lean();
    q.$or = [{ user: { $in: users.map((u) => u._id) } }, { 'botSnapshot.name': rx }];
  }
  const [items, total, counts] = await Promise.all([
    BotSubscription.find(q).sort({ updatedAt: -1 }).skip(skip).limit(limit).populate('user', 'firstName lastName email accountId').lean(),
    BotSubscription.countDocuments(q),
    BotSubscription.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])
  ]);
  res.json({ success: true, data: { items, total, page, limit, counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) } });
});

export const adminGetSubscription = handler(async (req, res) => {
  const s = await BotSubscription.findById(oid(req.params.id)).populate('user', 'firstName lastName email accountId').lean();
  if (!s) throw new HttpError(404, 'Subscription not found');
  const trades = await BotTrade.find({ subscription: s._id }).sort({ number: -1 }).limit(100).lean();
  res.json({ success: true, data: { ...s, trades } });
});

/** PATCH /api/admin/bot-invoices/:id/:decision   (approve | reject | stop) */
export const adminDecideSubscription = handler(async (req, res) => {
  const decision = req.params.decision;
  const note = asString(req.body?.note, 300);
  const id = oid(req.params.id);
  let s;
  if (decision === 'approve') {
    const cur = await BotSubscription.findById(id).lean();
    if (!cur) throw new HttpError(404, 'Subscription not found');
    if (cur.status !== 'pending' || cur.payment?.status !== 'pending') throw new HttpError(409, 'There is no payment waiting for review on this subscription');
    if (!cur.payment?.proof) throw new HttpError(400, 'This payment has no proof on file and cannot be approved');
    const now = new Date();
    s = await BotSubscription.findOneAndUpdate(
      { _id: id, status: 'pending', 'payment.status': 'pending' },
      { $set: { status: 'active', startedAt: now, nextTradeAt: new Date(now.getTime() + 60 * 1000), 'payment.status': 'approved', 'payment.reviewedAt': now, 'payment.note': note } },
      { new: true }
    );
  } else if (decision === 'reject') {
    if (!note) throw new HttpError(400, 'Give the user a reason for the rejection');
    s = await BotSubscription.findOneAndUpdate(
      { _id: id, status: 'pending', 'payment.status': 'pending' },
      { $set: { status: 'rejected', 'payment.status': 'rejected', 'payment.reviewedAt': new Date(), 'payment.note': note } },
      { new: true }
    );
  } else if (decision === 'stop') {
    s = await BotSubscription.findOneAndUpdate({ _id: id, status: 'active' }, { $set: { status: 'stopped', nextTradeAt: null, completedAt: new Date() } }, { new: true });
  } else {
    throw new HttpError(400, 'Unknown action');
  }
  if (!s) throw new HttpError(409, 'This subscription was already updated');
  if (s.payment?.transaction && decision !== 'stop') {
    await Transaction.updateOne({ _id: s.payment.transaction }, { $set: { status: decision === 'approve' ? 'completed' : 'failed' } });
  }
  const name = s.botSnapshot?.name || 'AI Smart Trader';
  const msg = decision === 'approve'
    ? { title: 'AI Smart Trader is live', content: `${name} is now trading for you: ${s.tradeLimit} trades.` }
    : decision === 'reject'
      ? { title: 'Bot payment rejected', content: `Your ${name} payment was rejected: ${note}` }
      : { title: 'AI Smart Trader stopped', content: `${name} was stopped after ${s.tradesUsed} of ${s.tradeLimit} trades.` };
  notify(s.user, { ...msg, type: 'transaction', link: '/ai-trader' }).catch(() => {});
  res.json({ success: true, data: s });
});
