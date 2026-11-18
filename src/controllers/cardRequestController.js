// Card catalog (admin Card Settings), card requests and their two payments
// (purchase, then activation), reviewed by the admin in Card Invoices.
// Payments reuse the platform's existing payment methods: the user picks a
// method, pays, uploads proof; nothing is debited from the wallet here.
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import CardProduct, { CARD_NETWORKS, CARD_PRESETS } from '../models/CardProduct.js';
import CardRequest, { OPEN_STAGES } from '../models/CardRequest.js';
import Transaction from '../models/Transaction.js';
import PaymentMethod from '../models/PaymentMethod.js';
import User from '../models/User.js';
import { asString } from '../utils/validation.js';
import { HttpError, convertFromBase } from '../utils/wallet.js';
import { getBaseCurrency } from '../services/fx.js';
import { handler, notify, paging } from '../services/productService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STAGE_KEYS = { purchase: 'purchase', activation: 'activation' };

const money = (v) => {
  const n = Number(String(v ?? '').replace(/,/g, '').match(/-?\d+(\.\d+)?/)?.[0]);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
};
const oid = (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, 'Invalid id');
  return id;
};
const saveUpload = async (file, folder) => {
  const name = `${uuidv4()}${path.extname(file.name || '') || '.jpg'}`;
  await file.mv(path.join(__dirname, '../uploads', folder, name));
  return `/uploads/${folder}/${name}`;
};

/* ======================= Card catalog (admin) ======================= */

const readProduct = (body, { partial = false } = {}) => {
  const out = {};
  const errors = [];
  const has = (k) => !partial || body[k] !== undefined;
  if (has('name')) { out.name = asString(body.name, 60); if (!out.name) errors.push('Card name is required'); }
  if (has('type')) { out.type = body.type === 'physical' ? 'physical' : body.type === 'virtual' ? 'virtual' : null; if (!out.type) errors.push('Choose Virtual or Physical'); }
  if (has('network')) { out.network = String(body.network || '').toLowerCase(); if (!CARD_NETWORKS.includes(out.network)) errors.push('Choose a card network'); }
  if (has('purchasePrice')) { out.purchasePrice = money(body.purchasePrice); if (!(out.purchasePrice >= 0)) errors.push('Purchase price must be a number'); }
  if (has('activationFee')) { out.activationFee = money(body.activationFee); if (!(out.activationFee >= 0)) errors.push('Activation fee must be a number'); }
  if (body.status !== undefined) out.status = body.status === 'unavailable' ? 'unavailable' : 'available';
  if (body.designPreset !== undefined && CARD_PRESETS.includes(body.designPreset)) out.designPreset = body.designPreset;
  if (body.description !== undefined) out.description = asString(body.description, 300);
  if (body.removeDesign === 'true' || body.removeDesign === true) out.design = '';
  if (body.sortOrder !== undefined) out.sortOrder = Number(body.sortOrder) || 0;
  return { out, errors };
};

export const adminListProducts = handler(async (_req, res) => {
  const [items, base] = await Promise.all([CardProduct.find().sort({ sortOrder: 1, createdAt: -1 }).lean(), getBaseCurrency()]);
  const counts = await CardRequest.aggregate([{ $group: { _id: '$product', total: { $sum: 1 }, active: { $sum: { $cond: [{ $eq: ['$stage', 'active'] }, 1, 0] } } } }]);
  const byId = Object.fromEntries(counts.map((c) => [String(c._id), c]));
  res.json({ success: true, data: { items: items.map((p) => ({ ...p, requests: byId[String(p._id)]?.total || 0, activeCards: byId[String(p._id)]?.active || 0 })), currency: base, networks: CARD_NETWORKS, presets: CARD_PRESETS } });
});

export const adminCreateProduct = handler(async (req, res) => {
  const { out, errors } = readProduct(req.body);
  if (errors.length) throw new HttpError(400, errors.join('. '));
  if (req.files?.design) out.design = await saveUpload(req.files.design, 'card-designs');
  const item = await CardProduct.create(out);
  res.status(201).json({ success: true, data: item });
});

export const adminUpdateProduct = handler(async (req, res) => {
  const { out, errors } = readProduct(req.body, { partial: true });
  if (errors.length) throw new HttpError(400, errors.join('. '));
  if (req.files?.design) out.design = await saveUpload(req.files.design, 'card-designs');
  const item = await CardProduct.findByIdAndUpdate(oid(req.params.id), { $set: out }, { new: true, runValidators: true });
  if (!item) throw new HttpError(404, 'Card not found');
  res.json({ success: true, data: item });
});

/* ======================= User: catalog & requests ======================= */

const priced = async (p, currency) => {
  const [buy, act] = await Promise.all([convertFromBase(p.purchasePrice, currency), convertFromBase(p.activationFee, currency)]);
  return { ...p, purchasePrice: buy.amount, activationFee: act.amount, currency: buy.currency };
};

/** GET /api/card-catalog  -> available cards, priced in the user's currency */
export const userCatalog = handler(async (req, res) => {
  const user = await User.findById(req.user.id).select('currency').lean();
  const items = await CardProduct.find({ status: 'available' }).sort({ sortOrder: 1, createdAt: -1 }).lean();
  res.json({ success: true, data: { items: await Promise.all(items.map((p) => priced(p, user?.currency))) } });
});

const publicRequest = (r) => ({
  _id: r._id,
  stage: r.stage,
  product: r.productSnapshot,
  productId: r.product,
  holder: r.holder,
  purchase: { status: r.purchase?.status, amount: r.purchase?.amount, currency: r.purchase?.currency, note: r.purchase?.note, submittedAt: r.purchase?.submittedAt, reviewedAt: r.purchase?.reviewedAt },
  activation: { status: r.activation?.status, amount: r.activation?.amount, currency: r.activation?.currency, note: r.activation?.note, submittedAt: r.activation?.submittedAt, reviewedAt: r.activation?.reviewedAt },
  card: r.card,
  activatedAt: r.activatedAt,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt
});

/** GET /api/card-requests  -> the user's card requests (newest first) */
export const userRequests = handler(async (req, res) => {
  const user = await User.findById(req.user.id).select('currency').lean();
  const items = await CardRequest.find({ user: req.user.id, stage: { $ne: 'cancelled' } }).sort({ createdAt: -1 }).lean();
  // Amounts still to pay are quoted in the user's current currency.
  const out = await Promise.all(items.map(async (r) => {
    const pr = publicRequest(r);
    if (r.purchase?.status !== 'approved' && r.purchase?.status !== 'pending') {
      const q = await convertFromBase(r.productSnapshot.purchasePrice, user?.currency);
      pr.purchase.amount = q.amount; pr.purchase.currency = q.currency;
    }
    if (r.activation?.status !== 'approved' && r.activation?.status !== 'pending') {
      const q = await convertFromBase(r.productSnapshot.activationFee, user?.currency);
      pr.activation.amount = q.amount; pr.activation.currency = q.currency;
    }
    return pr;
  }));
  res.json({ success: true, data: { items: out } });
});

/** POST /api/card-requests  { productId, holder: { fullName, email, phone, dateOfBirth, address } } */
export const userCreateRequest = handler(async (req, res) => {
  const product = await CardProduct.findOne({ _id: oid(req.body.productId), status: 'available' }).lean();
  if (!product) throw new HttpError(404, 'This card is no longer available');

  const h = req.body.holder || {};
  const a = h.address || {};
  const holder = {
    fullName: asString(h.fullName, 60),
    email: asString(h.email, 120),
    phone: asString(h.phone, 30),
    dateOfBirth: asString(h.dateOfBirth, 20),
    address: { street: asString(a.street, 120), city: asString(a.city, 60), state: asString(a.state, 60), postalCode: asString(a.postalCode, 20), country: asString(a.country, 60) }
  };
  if (holder.fullName.length < 3) throw new HttpError(400, 'Enter the cardholder name as it should appear on the card');
  if (holder.email && !/^\S+@\S+\.\S+$/.test(holder.email)) throw new HttpError(400, 'Enter a valid email address');
  if (product.type === 'physical' && (!holder.address.street || !holder.address.city || !holder.address.country)) {
    throw new HttpError(400, 'A delivery address (street, city and country) is required for a physical card');
  }

  // No duplicate open request for the same card.
  const open = await CardRequest.findOne({ user: req.user.id, product: product._id, stage: { $in: OPEN_STAGES } }).lean();
  if (open) throw new HttpError(409, 'You already have an open request for this card. Continue it from My cards.');

  const base = await getBaseCurrency();
  const r = await CardRequest.create({
    user: req.user.id,
    product: product._id,
    productSnapshot: {
      name: product.name, type: product.type, network: product.network, design: product.design, designPreset: product.designPreset,
      purchasePrice: product.purchasePrice, activationFee: product.activationFee, baseCurrency: base
    },
    holder
  });
  res.status(201).json({ success: true, data: publicRequest(r.toObject()) });
});

/**
 * POST /api/card-requests/:id/pay/:which   (which = purchase | activation)
 * multipart: paymentMethod, paymentProof (file)
 * The amount is set here from the card's price; the user only supplies proof.
 */
export const userSubmitPayment = handler(async (req, res) => {
  const which = STAGE_KEYS[req.params.which];
  if (!which) throw new HttpError(400, 'Unknown payment');
  const paymentMethod = asString(req.body.paymentMethod, 80);
  const proofFile = req.files?.paymentProof;
  if (!paymentMethod) throw new HttpError(400, 'Choose a payment method');
  if (!proofFile) throw new HttpError(400, 'Upload your payment proof');

  const wantStage = which === 'purchase' ? 'purchase_unpaid' : 'activation_unpaid';
  const r = await CardRequest.findOne({ _id: oid(req.params.id), user: req.user.id });
  if (!r) throw new HttpError(404, 'Card request not found');
  if (r.stage !== wantStage) {
    if (which === 'activation' && ['purchase_unpaid', 'purchase_review'].includes(r.stage)) throw new HttpError(400, 'Your card purchase payment must be approved before you can activate the card');
    if (r.stage.endsWith('_review')) throw new HttpError(409, 'Your payment is already being reviewed');
    throw new HttpError(409, 'This payment is not due right now');
  }

  // The payment method must be one the admin has switched on; store its name for the admin.
  const method = await PaymentMethod.findOne({ methodId: paymentMethod, isActive: true }).lean();
  if (!method) throw new HttpError(400, 'This payment method is not available. Choose another one.');

  const user = await User.findById(req.user.id).select('currency').lean();
  const baseAmount = which === 'purchase' ? r.productSnapshot.purchasePrice : r.productSnapshot.activationFee;
  const quote = await convertFromBase(baseAmount, user?.currency);
  const proof = await saveUpload(proofFile, 'invoices');
  const reference = `${which === 'purchase' ? 'CRD' : 'CRA'}-${uuidv4().replace(/-/g, '').slice(0, 12).toUpperCase()}`;

  // Move the stage atomically so two quick submissions can't both go through.
  const next = which === 'purchase' ? 'purchase_review' : 'activation_review';
  const updated = await CardRequest.findOneAndUpdate(
    { _id: r._id, stage: wantStage },
    {
      $set: {
        stage: next,
        [`${which}.status`]: 'pending',
        [`${which}.amount`]: quote.amount,
        [`${which}.currency`]: quote.currency,
        [`${which}.baseAmount`]: baseAmount,
        [`${which}.paymentMethod`]: method.title || paymentMethod,
        [`${which}.proof`]: proof,
        [`${which}.reference`]: reference,
        [`${which}.submittedAt`]: new Date(),
        [`${which}.note`]: ''
      },
      $inc: { [`${which}.attempts`]: 1 }
    },
    { new: true }
  );
  if (!updated) throw new HttpError(409, 'Your payment is already being reviewed');

  const tx = await Transaction.create({
    userId: r.user, amount: quote.amount, currency: quote.currency, type: 'card', status: 'pending', reference,
    metadata: { cardRequest: String(r._id), payment: which, card: r.productSnapshot.name, method: paymentMethod }
  });
  updated[which].transaction = tx._id;
  await updated.save();

  res.json({ success: true, message: 'Payment submitted. We will review it shortly.', data: publicRequest(updated.toObject()) });
});

/** POST /api/card-requests/:id/cancel  (only before any payment is approved or under review) */
export const userCancelRequest = handler(async (req, res) => {
  const r = await CardRequest.findOneAndUpdate(
    { _id: oid(req.params.id), user: req.user.id, stage: 'purchase_unpaid' },
    { $set: { stage: 'cancelled', cancelledAt: new Date() } },
    { new: true }
  );
  if (!r) throw new HttpError(409, 'This request can no longer be cancelled');
  res.json({ success: true });
});

/* ======================= Admin: Card Invoices ======================= */

export const adminListRequests = handler(async (req, res) => {
  const { page, limit, skip } = paging(req.query, 20);
  const q = {};
  const s = String(req.query.status || '');
  if (s === 'review') q.stage = { $in: ['purchase_review', 'activation_review'] };
  else if (s === 'awaiting') q.stage = { $in: ['purchase_unpaid', 'activation_unpaid'] };
  else if (s) q.stage = s;
  if (req.query.search) {
    const rx = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const users = await User.find({ $or: [{ email: rx }, { firstName: rx }, { lastName: rx }] }).select('_id').limit(200).lean();
    q.$or = [{ user: { $in: users.map((u) => u._id) } }, { 'holder.fullName': rx }, { 'productSnapshot.name': rx }];
  }
  const [items, total, counts] = await Promise.all([
    CardRequest.find(q).sort({ updatedAt: -1 }).skip(skip).limit(limit).populate('user', 'firstName lastName email accountId').lean(),
    CardRequest.countDocuments(q),
    CardRequest.aggregate([{ $group: { _id: '$stage', n: { $sum: 1 } } }])
  ]);
  res.json({ success: true, data: { items, total, page, limit, counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) } });
});

export const adminGetRequest = handler(async (req, res) => {
  const r = await CardRequest.findById(oid(req.params.id)).populate('user', 'firstName lastName email accountId phoneNumber country').lean();
  if (!r) throw new HttpError(404, 'Card request not found');
  res.json({ success: true, data: r });
});

/**
 * PATCH /api/admin/card-requests/:id/:which/:decision   (which = purchase|activation, decision = approve|reject)
 * body: { note?, last4?, expiry? }   (last4/expiry optional when approving activation)
 * Only a payment that is under review can be decided, and only once.
 */
export const adminDecidePayment = handler(async (req, res) => {
  const which = STAGE_KEYS[req.params.which];
  const decision = req.params.decision;
  if (!which || !['approve', 'reject'].includes(decision)) throw new HttpError(400, 'Unknown action');
  const note = asString(req.body?.note, 500);
  if (decision === 'reject' && !note) throw new HttpError(400, 'Give the user a reason for the rejection');

  const reviewStage = `${which}_review`;
  const current = await CardRequest.findById(oid(req.params.id)).lean();
  if (!current) throw new HttpError(404, 'Card request not found');
  // Backend checks before approval: right stage, a proof on file, an amount set by the server.
  if (current.stage !== reviewStage || current[which]?.status !== 'pending') {
    throw new HttpError(409, `There is no ${which} payment waiting for review on this request`);
  }
  if (decision === 'approve' && (!current[which]?.proof || !(current[which]?.amount >= 0))) {
    throw new HttpError(400, 'This payment has no proof or amount on file and cannot be approved');
  }

  const set = {
    [`${which}.status`]: decision === 'approve' ? 'approved' : 'rejected',
    [`${which}.reviewedAt`]: new Date(),
    [`${which}.reviewedBy`]: req.user?.id,
    [`${which}.note`]: note
  };
  if (decision === 'approve') {
    set.stage = which === 'purchase' ? 'activation_unpaid' : 'active';
    if (which === 'activation') {
      set.activatedAt = new Date();
      const last4 = String(req.body?.last4 || '').replace(/\D/g, '');
      if (last4) { if (last4.length !== 4) throw new HttpError(400, 'Last 4 digits must be 4 numbers'); set['card.last4'] = last4; }
      if (req.body?.expiry) set['card.expiry'] = asString(req.body.expiry, 7);
    }
  } else {
    set.stage = which === 'purchase' ? 'purchase_unpaid' : 'activation_unpaid';
  }

  // Atomic: only succeeds if it is still under review (stops double approvals).
  const r = await CardRequest.findOneAndUpdate({ _id: current._id, stage: reviewStage, [`${which}.status`]: 'pending' }, { $set: set }, { new: true });
  if (!r) throw new HttpError(409, 'This payment was already decided');

  if (r[which]?.transaction) {
    await Transaction.updateOne({ _id: r[which].transaction }, { $set: { status: decision === 'approve' ? 'completed' : 'failed' } });
  }

  const name = r.productSnapshot.name;
  const msg = decision === 'approve'
    ? (which === 'purchase'
      ? { title: 'Card purchase approved', content: `Your ${name} purchase is approved. Pay the activation fee to activate it.` }
      : { title: 'Card activated', content: `Your ${name} is now active.` })
    : { title: `Card ${which} payment rejected`, content: `Your ${name} ${which} payment was rejected: ${note}. You can pay again from Cards.` };
  notify(r.user, { ...msg, type: 'transaction', link: '/cards', metadata: { cardRequest: String(r._id) } }).catch(() => {});

  res.json({ success: true, data: r });
});
