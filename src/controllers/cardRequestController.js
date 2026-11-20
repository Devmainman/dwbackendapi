// Card catalog (admin Card Settings), card requests and their two payments
// (purchase, then activation), reviewed by the admin in Card Invoices.
// Payments reuse the platform's existing payment methods: the user picks a
// method, pays, uploads proof; nothing is debited from the wallet here.
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import CardProduct, { CARD_NETWORKS, CARD_PRESETS } from '../models/CardProduct.js';
import bcrypt from 'bcryptjs';
import CardRequest, { OPEN_STAGES, ISSUABLE_STAGES } from '../models/CardRequest.js';
import {
  encrypt, decrypt, panError, generatePan, generateCvv, generateExpiry, expiryError,
  formatExpiry, cvvLength, groupPan, weakPin, NETWORK_RULES
} from '../services/cardVault.js';
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

/** Display-safe card fields only (never the encrypted number or CVV). */
const safeCard = (c) => {
  if (!c?.last4) return { issued: false };
  return {
    issued: true,
    last4: c.last4,
    maskedNumber: `•••• •••• •••• ${c.last4}`,
    expiry: c.expiry || formatExpiry(c.expiryMonth, c.expiryYear),
    expiryMonth: c.expiryMonth,
    expiryYear: c.expiryYear,
    holderName: c.holderName,
    network: c.network,
    issuedAt: c.issuedAt,
    updatedAt: c.updatedAt
  };
};
const lockedUntil = (r) => (r.pin?.lockedUntil && new Date(r.pin.lockedUntil) > new Date() ? r.pin.lockedUntil : null);
/** Admin view of a request: everything except the secrets. */
const adminView = (r) => {
  if (!r) return r;
  const o = typeof r.toObject === 'function' ? r.toObject() : { ...r };
  o.card = safeCard(o.card);
  o.pin = { isSet: Boolean(o.pin?.setAt), setAt: o.pin?.setAt || null, lockedUntil: lockedUntil(o), failedAttempts: o.pin?.failedAttempts || 0 };
  return o;
};

const publicRequest = (r) => ({
  _id: r._id,
  stage: r.stage,
  product: r.productSnapshot,
  productId: r.product,
  holder: r.holder,
  purchase: { status: r.purchase?.status, amount: r.purchase?.amount, currency: r.purchase?.currency, note: r.purchase?.note, submittedAt: r.purchase?.submittedAt, reviewedAt: r.purchase?.reviewedAt },
  activation: { status: r.activation?.status, amount: r.activation?.amount, currency: r.activation?.currency, note: r.activation?.note, submittedAt: r.activation?.submittedAt, reviewedAt: r.activation?.reviewedAt },
  card: safeCard(r.card),
  pin: { isSet: Boolean(r.pin?.setAt), setAt: r.pin?.setAt || null, lockedUntil: lockedUntil(r) },
  statusNote: r.statusNote || '',
  frozenAt: r.frozenAt,
  terminatedAt: r.terminatedAt,
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
  res.json({ success: true, data: { items: items.map(adminView), total, page, limit, counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) } });
});

export const adminGetRequest = handler(async (req, res) => {
  const r = await CardRequest.findById(oid(req.params.id)).populate('user', 'firstName lastName email accountId phoneNumber country').lean();
  if (!r) throw new HttpError(404, 'Card request not found');
  const net = r.productSnapshot?.network || 'visa';
  res.json({ success: true, data: { ...adminView(r), cardRule: CARD_NETWORK_RULES[net] || CARD_NETWORK_RULES.other } });
});

/* ---------------- Admin: issue card details, freeze / terminate ---------------- */

const toInt = (v) => (v === '' || v == null ? NaN : Number(v));

/**
 * POST /api/admin/card-invoices/:id/card/generate
 * Suggests a new number (Luhn-valid, right prefix for the network), expiry and
 * CVV. Nothing is saved: the admin reviews it in the form, then saves.
 */
export const adminGenerateCardDetails = handler(async (req, res) => {
  const r = await CardRequest.findById(oid(req.params.id)).lean();
  if (!r) throw new HttpError(404, 'Card request not found');
  const network = r.productSnapshot?.network || 'visa';
  const pan = generatePan(network);
  res.set('Cache-Control', 'no-store');
  res.json({
    success: true,
    data: { pan, panFormatted: groupPan(pan), cvv: generateCvv(network), ...generateExpiry(), holderName: r.card?.holderName || r.holder?.fullName || '', network }
  });
});

/** GET /api/admin/card-invoices/:id/card/reveal  -> full number and CVV for the admin. */
export const adminRevealCard = handler(async (req, res) => {
  const r = await CardRequest.findById(oid(req.params.id)).select('+card.panEnc +card.cvvEnc').lean();
  if (!r) throw new HttpError(404, 'Card request not found');
  if (!r.card?.panEnc) throw new HttpError(404, 'No card details have been issued for this request yet');
  const pan = decrypt(r.card.panEnc);
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: { pan, panFormatted: groupPan(pan), cvv: decrypt(r.card.cvvEnc), expiryMonth: r.card.expiryMonth, expiryYear: r.card.expiryYear, holderName: r.card.holderName, network: r.card.network } });
});

/**
 * PUT /api/admin/card-invoices/:id/card
 * body: { pan?, cvv?, expiryMonth, expiryYear, holderName }
 * Allowed once the purchase is approved. On an already-issued card, leaving
 * pan / cvv empty keeps the current ones (so the admin can just fix the name or expiry).
 */
export const adminIssueCard = handler(async (req, res) => {
  const r = await CardRequest.findById(oid(req.params.id)).select('+card.panEnc +card.cvvEnc');
  if (!r) throw new HttpError(404, 'Card request not found');
  if (!ISSUABLE_STAGES.includes(r.stage)) {
    if (r.stage === 'terminated') throw new HttpError(409, 'This card is terminated. Its details can no longer be changed.');
    throw new HttpError(409, 'Approve the purchase payment before issuing the card details');
  }
  const network = r.productSnapshot?.network || 'visa';
  const issued = Boolean(r.card?.panEnc);
  const b = req.body || {};
  const pan = String(b.pan ?? '').replace(/[\s-]/g, '');
  const cvv = String(b.cvv ?? '').trim();
  const expiryMonth = toInt(b.expiryMonth);
  const expiryYear = toInt(b.expiryYear);
  const holderName = asString(b.holderName, 60).toUpperCase();

  const errors = [];
  if (pan || !issued) { const e = pan ? panError(pan, network) : 'Enter the card number or generate one'; if (e) errors.push(e); }
  const cvvLen = cvvLength(network);
  if (cvv || !issued) { if (!new RegExp(`^\\d{${cvvLen}}$`).test(cvv)) errors.push(`The CVV must be ${cvvLen} digits`); }
  const ee = expiryError(expiryMonth, expiryYear); if (ee) errors.push(ee);
  if (holderName.length < 3) errors.push('Enter the cardholder name (at least 3 characters)');
  if (holderName && !/^[A-Z][A-Z .'-]*$/.test(holderName)) errors.push('The cardholder name may only use letters, spaces, dots, hyphens and apostrophes');
  if (errors.length) throw new HttpError(400, errors.join('. '));

  if (pan) {
    // The same number must not belong to two cards. Compare by last 4 first (cheap), then decrypt.
    const same = await CardRequest.find({ _id: { $ne: r._id }, 'card.last4': pan.slice(-4) }).select('+card.panEnc').lean();
    if (same.some((o) => { try { return decrypt(o.card.panEnc) === pan; } catch { return false; } })) {
      throw new HttpError(409, 'This card number is already used by another card. Generate a new one.');
    }
    r.card.panEnc = encrypt(pan);
    r.card.last4 = pan.slice(-4);
  }
  if (cvv) r.card.cvvEnc = encrypt(cvv);
  r.card.expiryMonth = expiryMonth;
  r.card.expiryYear = expiryYear;
  r.card.expiry = formatExpiry(expiryMonth, expiryYear);
  r.card.holderName = holderName;
  r.card.network = network;
  r.card.updatedAt = new Date();
  if (!issued) { r.card.issuedAt = new Date(); r.card.issuedBy = req.user?.id; }
  await r.save();

  if (!issued && ['active', 'frozen'].includes(r.stage)) {
    notify(r.user, { title: 'Card details ready', content: `Your ${r.productSnapshot.name} details are ready. Open it from Cards to view them.`, type: 'transaction', link: '/cards', metadata: { cardRequest: String(r._id) } }).catch(() => {});
  }
  res.json({ success: true, message: issued ? 'Card details updated' : 'Card details issued', data: adminView(r) });
});

/**
 * PATCH /api/admin/card-invoices/:id/card/status   body: { action: freeze|unfreeze|terminate, note? }
 * Terminate is final.
 */
export const adminSetCardStatus = handler(async (req, res) => {
  const action = String(req.body?.action || '');
  const note = asString(req.body?.note, 300);
  const moves = {
    freeze: { from: ['active'], set: { stage: 'frozen', frozenAt: new Date() }, msg: 'Card frozen', user: ['Card frozen', 'has been frozen. Contact support if you did not expect this.'] },
    unfreeze: { from: ['frozen'], set: { stage: 'active', frozenAt: null }, msg: 'Card unfrozen', user: ['Card unfrozen', 'is active again.'] },
    terminate: { from: ['active', 'frozen', 'activation_unpaid', 'activation_review'], set: { stage: 'terminated', terminatedAt: new Date() }, msg: 'Card terminated', user: ['Card terminated', 'has been terminated and can no longer be used.'] }
  };
  const m = moves[action];
  if (!m) throw new HttpError(400, 'Unknown action');
  if (action === 'terminate' && !note) throw new HttpError(400, 'Give the user a reason for terminating the card');
  const r = await CardRequest.findOneAndUpdate(
    { _id: oid(req.params.id), stage: { $in: m.from } },
    { $set: { ...m.set, statusNote: note } },
    { new: true }
  );
  if (!r) {
    const cur = await CardRequest.findById(req.params.id).select('stage').lean();
    if (!cur) throw new HttpError(404, 'Card request not found');
    throw new HttpError(409, `This card is ${cur.stage.replace(/_/g, ' ')} and cannot be ${action === 'unfreeze' ? 'unfrozen' : `${action}d`}`);
  }
  // A terminated card's pending activation payment, if any, is closed too.
  if (action === 'terminate' && r.activation?.status === 'pending' && r.activation.transaction) {
    await Transaction.updateOne({ _id: r.activation.transaction, status: 'pending' }, { $set: { status: 'failed' } });
  }
  notify(r.user, { title: m.user[0], content: `Your ${r.productSnapshot.name} ${m.user[1]}${note ? ` Note: ${note}` : ''}`, type: 'transaction', link: '/cards', metadata: { cardRequest: String(r._id) } }).catch(() => {});
  res.json({ success: true, message: m.msg, data: adminView(r) });
});

/* ---------------- User: card details and PIN ---------------- */

const userCard = async (req, extra = '') => {
  const r = await CardRequest.findOne({ _id: oid(req.params.id), user: req.user.id }).select(extra);
  if (!r) throw new HttpError(404, 'Card not found');
  return r;
};
const PIN_MAX_TRIES = 5;
const PIN_LOCK_MS = 15 * 60 * 1000;
const readPin = (v, label) => {
  const s = String(v ?? '');
  if (!/^\d{4}$/.test(s)) throw new HttpError(400, `${label} must be exactly 4 digits`);
  return s;
};

/** GET /api/card-requests/:id/details  -> full number and CVV, only for the owner of an active card. */
export const userCardDetails = handler(async (req, res) => {
  const r = await userCard(req, '+card.panEnc +card.cvvEnc');
  if (r.stage === 'frozen') throw new HttpError(403, 'This card is frozen. Its details are hidden until it is unfrozen.');
  if (r.stage !== 'active') throw new HttpError(403, 'Card details are available once the card is active');
  if (!r.card?.panEnc) throw new HttpError(404, 'Your card details are being prepared. Check back shortly.');
  const pan = decrypt(r.card.panEnc);
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: { pan, panFormatted: groupPan(pan), cvv: decrypt(r.card.cvvEnc), expiry: r.card.expiry, expiryMonth: r.card.expiryMonth, expiryYear: r.card.expiryYear, holderName: r.card.holderName, network: r.card.network } });
});

/** POST /api/card-requests/:id/pin  { pin, confirmPin }  -> first PIN, active card only. */
export const userSetPin = handler(async (req, res) => {
  const pin = readPin(req.body?.pin, 'The PIN');
  if (String(req.body?.confirmPin ?? '') !== pin) throw new HttpError(400, 'The two PINs do not match');
  if (weakPin(pin)) throw new HttpError(400, 'This PIN is too easy to guess. Avoid repeated digits (1111) and runs (1234).');
  const r = await userCard(req, '+pin.hash');
  if (r.stage !== 'active') throw new HttpError(403, r.stage === 'frozen' ? 'This card is frozen. You can set a PIN once it is unfrozen.' : 'You can set a PIN once the card is active');
  if (!r.card?.last4) throw new HttpError(409, 'Your card details are still being prepared. Try again shortly.');
  if (r.pin?.hash) throw new HttpError(409, 'A PIN is already set for this card. Use Change PIN instead.');
  const hash = await bcrypt.hash(pin, 10);
  // Atomic: only if no PIN was set in the meantime.
  const ok = await CardRequest.findOneAndUpdate(
    { _id: r._id, $or: [{ 'pin.hash': { $exists: false } }, { 'pin.hash': null }] },
    { $set: { 'pin.hash': hash, 'pin.setAt': new Date(), 'pin.failedAttempts': 0, 'pin.lockedUntil': null } },
    { new: true }
  ).lean();
  if (!ok) throw new HttpError(409, 'A PIN is already set for this card. Use Change PIN instead.');
  res.json({ success: true, message: 'Card PIN set', data: publicRequest(ok) });
});

/** PUT /api/card-requests/:id/pin  { currentPin, newPin, confirmPin } */
export const userChangePin = handler(async (req, res) => {
  const currentPin = readPin(req.body?.currentPin, 'Your current PIN');
  const newPin = readPin(req.body?.newPin, 'The new PIN');
  if (String(req.body?.confirmPin ?? '') !== newPin) throw new HttpError(400, 'The two new PINs do not match');
  if (newPin === currentPin) throw new HttpError(400, 'The new PIN must be different from the current one');
  if (weakPin(newPin)) throw new HttpError(400, 'This PIN is too easy to guess. Avoid repeated digits (1111) and runs (1234).');
  const r = await userCard(req, '+pin.hash');
  if (r.stage !== 'active') throw new HttpError(403, r.stage === 'frozen' ? 'This card is frozen. You can change the PIN once it is unfrozen.' : 'This card is not active');
  if (!r.pin?.hash) throw new HttpError(409, 'No PIN is set for this card yet. Set one first.');
  const lock = lockedUntil(r);
  if (lock) {
    const mins = Math.max(1, Math.ceil((new Date(lock) - Date.now()) / 60000));
    throw new HttpError(429, `Too many wrong PIN attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
  }
  if (!(await bcrypt.compare(currentPin, r.pin.hash))) {
    const failed = (r.pin.failedAttempts || 0) + 1;
    const locked = failed >= PIN_MAX_TRIES;
    await CardRequest.updateOne({ _id: r._id }, { $set: { 'pin.failedAttempts': locked ? 0 : failed, 'pin.lockedUntil': locked ? new Date(Date.now() + PIN_LOCK_MS) : null } });
    if (locked) throw new HttpError(429, `Too many wrong PIN attempts. PIN changes are locked for ${PIN_LOCK_MS / 60000} minutes.`);
    const left = PIN_MAX_TRIES - failed;
    throw new HttpError(400, `Your current PIN is wrong. ${left} attempt${left === 1 ? '' : 's'} left.`);
  }
  const ok = await CardRequest.findByIdAndUpdate(r._id, { $set: { 'pin.hash': await bcrypt.hash(newPin, 10), 'pin.setAt': new Date(), 'pin.failedAttempts': 0, 'pin.lockedUntil': null } }, { new: true }).lean();
  notify(r.user, { title: 'Card PIN changed', content: `The PIN for your ${r.productSnapshot.name} was changed. If this was not you, contact support.`, type: 'security', link: '/cards' }).catch(() => {});
  res.json({ success: true, message: 'Card PIN changed', data: publicRequest(ok) });
});

export const CARD_NETWORK_RULES = Object.fromEntries(Object.entries(NETWORK_RULES).map(([k, v]) => [k, { label: v.label, lengths: v.lengths, cvv: v.cvv || 3, rule: v.rule }]));

/**
 * PATCH /api/admin/card-requests/:id/:which/:decision   (which = purchase|activation, decision = approve|reject)
 * body: { note? }   Approving an activation needs the card details issued first (adminIssueCard).
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
      // The card must have its number, expiry, CVV and holder name before it can go live.
      const withSecrets = await CardRequest.findById(current._id).select('+card.panEnc +card.cvvEnc').lean();
      if (!withSecrets?.card?.panEnc || !withSecrets.card.cvvEnc || !withSecrets.card.expiryMonth || !withSecrets.card.holderName) {
        throw new HttpError(400, 'Issue the card details (number, expiry, CVV and cardholder name) before approving the activation');
      }
      set.activatedAt = new Date();
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

  res.json({ success: true, data: adminView(r) });
});
