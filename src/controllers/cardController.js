import crypto from 'crypto';
import mongoose from 'mongoose';
import Card from '../models/Card.js';
import User from '../models/User.js';
import { parseAmount, round2 } from '../utils/money.js';
import { asString } from '../utils/validation.js';
import { rateBetween } from '../services/fx.js';
import { withTransaction, debitUser, creditUser, recordTransaction, convertFromBase, HttpError } from '../utils/wallet.js';
import { handler, getSettings, loadActiveUser, notify, paging } from '../services/productService.js';

const COLORS = ['midnight', 'aurora', 'gold', 'rose'];
const OPEN_STATUSES = ['pending', 'active', 'frozen'];

const ownCard = async (userId, id, session) => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, 'Invalid card id');
  const card = await Card.findOne({ _id: id, user: userId }).session(session || null);
  if (!card) throw new HttpError(404, 'Card not found');
  return card;
};

/** GET /api/cards */
export const listCards = handler(async (req, res) => {
  const [cards, settings, user] = await Promise.all([
    Card.find({ user: req.user.id, status: { $ne: 'cancelled' } }).sort({ createdAt: -1 }),
    getSettings(),
    User.findById(req.user.id).select('currency balance firstName lastName')
  ]);
  const [virtualFee, physicalFee] = await Promise.all([
    convertFromBase(settings.cards.virtualFee, user.currency),
    convertFromBase(settings.cards.physicalFee, user.currency)
  ]);
  res.json({
    success: true,
    data: {
      cards,
      currency: user.currency,
      availableBalance: user.balance,
      suggestedHolderName: `${user.firstName || ''} ${user.lastName || ''}`.trim().toUpperCase(),
      config: {
        virtualFee: virtualFee.amount,
        physicalFee: physicalFee.amount,
        maxCardsPerUser: settings.cards.maxCardsPerUser
      }
    }
  });
});

/** POST /api/cards  { type, brand, holderName, label, color, shippingAddress } */
export const requestCard = handler(async (req, res) => {
  const type = req.body.type === 'physical' ? 'physical' : 'virtual';
  const brand = req.body.brand === 'mastercard' ? 'mastercard' : 'visa';
  const holderName = asString(req.body.holderName, 60).toUpperCase();
  if (!/^[A-Z][A-Z .'-]{1,59}$/.test(holderName)) throw new HttpError(400, 'Enter the cardholder name as it should appear on the card');

  const shipping = req.body.shippingAddress || {};
  const shippingAddress = {
    street: asString(shipping.street, 120),
    city: asString(shipping.city, 60),
    state: asString(shipping.state, 60),
    postalCode: asString(shipping.postalCode, 20),
    country: asString(shipping.country, 60)
  };
  if (type === 'physical' && (!shippingAddress.street || !shippingAddress.city || !shippingAddress.country)) {
    throw new HttpError(400, 'A shipping address is required for a physical card');
  }

  const user = await loadActiveUser(req.user.id);
  const settings = await getSettings();
  const open = await Card.countDocuments({ user: user._id, status: { $in: OPEN_STATUSES } });
  if (open >= settings.cards.maxCardsPerUser) {
    throw new HttpError(400, `You can hold at most ${settings.cards.maxCardsPerUser} cards`);
  }

  const fee = await convertFromBase(type === 'physical' ? settings.cards.physicalFee : settings.cards.virtualFee, user.currency);

  const card = await withTransaction(async (session) => {
    if (fee.amount > 0) await debitUser(user._id, fee.amount, { session });
    const [c] = await Card.create([{
      user: user._id,
      type,
      brand,
      holderName,
      label: asString(req.body.label, 40),
      color: COLORS.includes(req.body.color) ? req.body.color : 'midnight',
      currency: user.currency,
      issuanceFee: fee.amount,
      shippingAddress: type === 'physical' ? shippingAddress : undefined
    }], { session });
    if (fee.amount > 0) {
      await recordTransaction({
        userId: user._id, amount: fee.amount, currency: user.currency, type: 'card',
        metadata: { action: 'issuance_fee', cardId: c._id, cardType: type }, session, prefix: 'CRD'
      });
    }
    return c;
  });

  res.status(201).json({ success: true, message: 'Card requested. It will be activated after review.', data: card });
});

/** POST /api/cards/:id/fund  { amount } — move money from main balance onto the card */
export const fundCard = handler(async (req, res) => {
  const amount = parseAmount(req.body.amount);
  if (amount === null) throw new HttpError(400, 'A valid amount is required');
  const user = await loadActiveUser(req.user.id);

  const card = await withTransaction(async (session) => {
    const c = await ownCard(user._id, req.params.id, session);
    if (c.status !== 'active') throw new HttpError(400, 'Only active cards can be funded');
    await debitUser(user._id, amount, { session });
    // The card keeps the currency it was issued in; convert if the account has since changed.
    c.balance = round2(c.balance + amount * (await rateBetween(user.currency, c.currency)));
    await c.save({ session });
    await recordTransaction({
      userId: user._id, amount, currency: c.currency, type: 'card',
      metadata: { action: 'fund', cardId: c._id, last4: c.last4 }, session, prefix: 'CRD'
    });
    return c;
  });
  res.json({ success: true, message: 'Card funded', data: card });
});

/** POST /api/cards/:id/unload  { amount } — move money from the card back to main balance */
export const unloadCard = handler(async (req, res) => {
  const amount = parseAmount(req.body.amount);
  if (amount === null) throw new HttpError(400, 'A valid amount is required');

  const card = await withTransaction(async (session) => {
    const c = await Card.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id, status: { $in: ['active', 'frozen'] }, balance: { $gte: round2(amount) } },
      { $inc: { balance: -round2(amount) } },
      { new: true, session }
    );
    if (!c) throw new HttpError(400, 'Insufficient card balance');
    await creditUser(req.user.id, amount, { session, currency: c.currency });
    await recordTransaction({
      userId: req.user.id, amount, currency: c.currency, type: 'card',
      metadata: { action: 'unload', cardId: c._id, last4: c.last4 }, session, prefix: 'CRD'
    });
    return c;
  });
  res.json({ success: true, message: 'Funds returned to your balance', data: card });
});

/** PATCH /api/cards/:id/freeze  { frozen: boolean } */
export const setFrozen = handler(async (req, res) => {
  const freeze = req.body.frozen !== false;
  const card = await Card.findOneAndUpdate(
    { _id: req.params.id, user: req.user.id, status: freeze ? 'active' : 'frozen' },
    { $set: { status: freeze ? 'frozen' : 'active' } },
    { new: true }
  );
  if (!card) throw new HttpError(400, freeze ? 'Only active cards can be frozen' : 'Card is not frozen');
  res.json({ success: true, message: freeze ? 'Card frozen' : 'Card unfrozen', data: card });
});

/** PATCH /api/cards/:id/limit  { spendingLimit } */
export const setLimit = handler(async (req, res) => {
  const limit = parseAmount(req.body.spendingLimit, { allowZero: true, max: 1e7 });
  if (limit === null) throw new HttpError(400, 'A valid spending limit is required');
  const card = await Card.findOneAndUpdate(
    { _id: req.params.id, user: req.user.id, status: { $in: OPEN_STATUSES } },
    { $set: { spendingLimit: round2(limit) } },
    { new: true }
  );
  if (!card) throw new HttpError(404, 'Card not found');
  res.json({ success: true, message: 'Spending limit updated', data: card });
});

/** DELETE /api/cards/:id — cancels the card and refunds any card balance */
export const cancelCard = handler(async (req, res) => {
  const refunded = await withTransaction(async (session) => {
    const c = await ownCard(req.user.id, req.params.id, session);
    if (!OPEN_STATUSES.includes(c.status)) throw new HttpError(400, 'Card is already closed');
    const balance = c.balance;
    c.balance = 0;
    c.status = 'cancelled';
    c.cancelledAt = new Date();
    await c.save({ session });
    if (balance > 0) {
      await creditUser(c.user, balance, { session, currency: c.currency });
      await recordTransaction({
        userId: c.user, amount: balance, currency: c.currency, type: 'card',
        metadata: { action: 'cancel_refund', cardId: c._id }, session, prefix: 'CRD'
      });
    }
    return balance;
  });
  res.json({ success: true, message: refunded > 0 ? `Card cancelled. ${refunded} returned to your balance.` : 'Card cancelled' });
});

/* ------------------------------ Admin ------------------------------ */

export const adminListCards = handler(async (req, res) => {
  const { page, limit, skip } = paging(req.query);
  const filter = {};
  if (['pending', 'active', 'frozen', 'rejected', 'cancelled'].includes(req.query.status)) filter.status = req.query.status;
  const [items, total] = await Promise.all([
    Card.find(filter).populate('user', 'email firstName lastName accountId').sort({ createdAt: -1 }).skip(skip).limit(limit),
    Card.countDocuments(filter)
  ]);
  res.json({ success: true, data: { items, total, page, limit } });
});

/**
 * POST /api/admin/products/cards/:id/approve  { last4?, expiryMonth?, expiryYear?, providerCardId? }
 * When an issuing provider is integrated, pass its card reference and last4 here.
 */
export const adminApproveCard = handler(async (req, res) => {
  const card = await Card.findOne({ _id: req.params.id, status: 'pending' });
  if (!card) throw new HttpError(404, 'Pending card not found');

  const last4 = /^\d{4}$/.test(String(req.body.last4 || '')) ? String(req.body.last4) : String(crypto.randomInt(0, 10000)).padStart(4, '0');
  const now = new Date();
  card.last4 = last4;
  card.expiryMonth = Number(req.body.expiryMonth) >= 1 && Number(req.body.expiryMonth) <= 12 ? Number(req.body.expiryMonth) : now.getMonth() + 1;
  card.expiryYear = Number(req.body.expiryYear) > now.getFullYear() ? Number(req.body.expiryYear) : now.getFullYear() + 4;
  card.providerCardId = asString(req.body.providerCardId, 100) || null;
  card.status = 'active';
  card.activatedAt = now;
  card.adminNote = asString(req.body.adminNote, 500);
  await card.save();

  await notify(card.user, { type: 'card', link: '/cards', title: 'Your card is ready', content: `Your ${card.type} ${card.brand} card ending ${last4} is now active.` });
  res.json({ success: true, data: card });
});

/** POST /api/admin/products/cards/:id/reject  { reason } — refunds the issuance fee */
export const adminRejectCard = handler(async (req, res) => {
  const card = await withTransaction(async (session) => {
    const c = await Card.findOne({ _id: req.params.id, status: 'pending' }).session(session);
    if (!c) throw new HttpError(404, 'Pending card not found');
    c.status = 'rejected';
    c.adminNote = asString(req.body.reason, 500);
    await c.save({ session });
    if (c.issuanceFee > 0) {
      await creditUser(c.user, c.issuanceFee, { session, currency: c.currency });
      await recordTransaction({
        userId: c.user, amount: c.issuanceFee, currency: c.currency, type: 'card',
        metadata: { action: 'fee_refund', cardId: c._id }, session, prefix: 'CRD'
      });
    }
    return c;
  });
  await notify(card.user, { type: 'card', link: '/cards', title: 'Card request declined', content: card.adminNote || 'Your card request was declined. The fee has been refunded.' });
  res.json({ success: true, data: card });
});

/** PATCH /api/admin/products/cards/:id/status  { status: 'active' | 'frozen' } */
export const adminSetCardStatus = handler(async (req, res) => {
  if (!['active', 'frozen'].includes(req.body.status)) throw new HttpError(400, 'Status must be active or frozen');
  const card = await Card.findOneAndUpdate(
    { _id: req.params.id, status: { $in: ['active', 'frozen'] } },
    { $set: { status: req.body.status, adminNote: asString(req.body.adminNote, 500) } },
    { new: true }
  );
  if (!card) throw new HttpError(404, 'Card not found');
  res.json({ success: true, data: card });
});
