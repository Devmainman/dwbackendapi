// Real estate projects: browse open / closed projects, invest an amount, collect returns.
import mongoose from 'mongoose';
import { Property, PropertyInvestment } from '../models/RealEstate.js';
import User from '../models/User.js';
import { parseAmount, parsePositiveInt, round2 } from '../utils/money.js';
import { asString, escapeRegex } from '../utils/validation.js';
import { withTransaction, debitUser, creditUser, recordTransaction, convertFromBase, HttpError } from '../utils/wallet.js';
import { handler, loadActiveUser, addMonths, paging } from '../services/productService.js';

const TYPES = ['residential', 'commercial', 'industrial', 'hospitality', 'land', 'mixed_use', 'life_science', 'healthcare', 'retail', 'office'];

/** Return earned so far: amount × roi%, spread evenly over the term. */
const earnings = (inv, now = new Date()) => {
  const total = round2(inv.amount * (inv.roi / 100));
  const span = new Date(inv.maturityAt) - new Date(inv.startAt);
  const elapsed = Math.min(span, Math.max(0, now - new Date(inv.startAt)));
  const earned = span > 0 ? round2(total * (elapsed / span)) : total;
  return { total, earned, unclaimed: round2(Math.max(0, earned - inv.incomeClaimed)), matured: now >= inv.maturityAt };
};

const presentInvestment = (inv, now) => {
  const e = earnings(inv, now);
  const obj = inv.toObject({ virtuals: true });
  return {
    ...obj,
    id: obj._id,
    totalReturn: e.total,
    earnedIncome: e.earned,
    unclaimedIncome: e.unclaimed,
    matured: e.matured,
    progressPercent: Math.min(100, Math.round(((now - inv.startAt) / (inv.maturityAt - inv.startAt)) * 100))
  };
};

const localize = (p, rate) => ({
  ...p.toJSON(),
  id: p._id,
  localMinimum: round2(p.minimumInvestment * rate),
  localTarget: round2(p.fundingTarget * rate),
  localRaised: round2(p.amountRaised * rate),
  localRemaining: round2(p.remaining * rate)
});

const findProject = (idOrSlug) => (mongoose.Types.ObjectId.isValid(idOrSlug)
  ? Property.findById(idOrSlug)
  : Property.findOne({ slug: asString(idOrSlug, 160).toLowerCase() }));

/** GET /api/real-estate/projects?status=open|closed&type=&search= */
export const listProperties = handler(async (req, res) => {
  const filter = { status: req.query.status === 'closed' ? 'closed' : 'open' };
  if (TYPES.includes(req.query.type)) filter.propertyType = req.query.type;
  if (req.query.search) {
    const rx = new RegExp(escapeRegex(req.query.search), 'i');
    filter.$or = [{ title: rx }, { summary: rx }, { 'location.city': rx }, { 'location.country': rx }];
  }
  const user = await User.findById(req.user.id).select('currency');
  const [projects, { rate }] = await Promise.all([
    Property.find(filter).select('-overview -whyProject -whySponsor -sponsor.about -documents')
      .sort(filter.status === 'closed' ? { closedAt: -1, updatedAt: -1 } : { featured: -1, sortOrder: 1, createdAt: -1 }).limit(100),
    convertFromBase(1, user.currency)
  ]);
  res.json({ success: true, data: { currency: user.currency, projects: projects.map((p) => localize(p, rate)) } });
});

/** GET /api/real-estate/projects/:id — full project page (id or slug) */
export const getProperty = handler(async (req, res) => {
  const project = await findProject(req.params.id);
  if (!project) throw new HttpError(404, 'Project not found');
  const user = await User.findById(req.user.id).select('currency balance');
  const [{ rate }, mine] = await Promise.all([
    convertFromBase(1, user.currency),
    PropertyInvestment.find({ user: req.user.id, property: project._id }).lean()
  ]);
  res.json({
    success: true,
    data: {
      currency: user.currency,
      availableBalance: user.balance,
      project: localize(project, rate),
      myInvestment: mine.length ? { count: mine.length, amount: round2(mine.reduce((s, i) => s + i.amount, 0)) } : null
    }
  });
});

/** POST /api/real-estate/projects/:id/invest  { amount }  (user currency) */
export const invest = handler(async (req, res) => {
  const amount = parseAmount(req.body.amount);
  if (amount === null) throw new HttpError(400, 'Enter a valid amount');
  const user = await loadActiveUser(req.user.id);
  const project = await findProject(req.params.id);
  if (!project) throw new HttpError(404, 'Project not found');
  if (project.status !== 'open') throw new HttpError(400, 'This project is closed to new investment');

  const { rate } = await convertFromBase(1, user.currency);
  const minimum = round2(project.minimumInvestment * rate);
  if (amount < minimum) throw new HttpError(400, `The minimum investment is ${minimum} ${user.currency}`);
  const baseAmount = round2(amount / rate);

  const investment = await withTransaction(async (session) => {
    // Reserve funding capacity atomically so a project is never over-subscribed.
    const reserved = await Property.findOneAndUpdate(
      { _id: project._id, status: 'open', $expr: { $lte: [{ $add: ['$amountRaised', baseAmount] }, { $add: ['$fundingTarget', 0.01] }] } },
      { $inc: { amountRaised: baseAmount } },
      { new: true, session }
    );
    if (!reserved) {
      const left = round2(Math.max(0, project.fundingTarget - project.amountRaised) * rate);
      throw new HttpError(400, left > 0 ? `Only ${left} ${user.currency} of this project is still available` : 'This project is fully funded');
    }
    if (reserved.amountRaised >= reserved.fundingTarget - 0.01) {
      reserved.status = 'closed';
      reserved.closedAt = new Date();
      await reserved.save({ session });
    }

    await debitUser(user._id, amount, { session });
    const now = new Date();
    const [inv] = await PropertyInvestment.create([{
      user: user._id,
      property: project._id,
      amount: round2(amount),
      baseAmount,
      currency: user.currency,
      roi: project.roi,
      durationMonths: project.durationMonths,
      startAt: now,
      maturityAt: addMonths(now, project.durationMonths)
    }], { session });
    await recordTransaction({
      userId: user._id, amount, currency: user.currency, type: 'real_estate',
      metadata: { action: 'invest', project: project.title, investmentId: inv._id }, session, prefix: 'RE'
    });
    return inv;
  });

  res.status(201).json({ success: true, message: `You invested in ${project.title}`, data: investment });
});

/** GET /api/real-estate/investments */
export const listInvestments = handler(async (req, res) => {
  const now = new Date();
  const user = await User.findById(req.user.id).select('currency');
  const items = (await PropertyInvestment.find({ user: req.user.id })
    .populate('property', 'title slug images location summary strategy roi status')
    .sort({ createdAt: -1 }).limit(200)).map((i) => presentInvestment(i, now));
  const active = items.filter((i) => i.status === 'active');
  res.json({
    success: true,
    data: {
      currency: user?.currency || 'USD',
      investments: items,
      totals: {
        invested: round2(active.reduce((s, i) => s + i.amount, 0)),
        unclaimedIncome: round2(active.reduce((s, i) => s + i.unclaimedIncome, 0)),
        incomeReceived: round2(items.reduce((s, i) => s + i.incomeClaimed, 0)),
        expectedReturn: round2(active.reduce((s, i) => s + i.totalReturn, 0))
      }
    }
  });
});

/** POST /api/real-estate/investments/:id/claim — collect returns earned so far */
export const claimIncome = handler(async (req, res) => {
  const amount = await withTransaction(async (session) => {
    const inv = await PropertyInvestment.findOne({ _id: req.params.id, user: req.user.id, status: 'active' }).session(session);
    if (!inv) throw new HttpError(404, 'Active investment not found');
    const e = earnings(inv);
    if (!(e.unclaimed >= 0.01)) throw new HttpError(400, 'No returns to collect yet');
    inv.incomeClaimed = round2(inv.incomeClaimed + e.unclaimed);
    await inv.save({ session });
    await creditUser(inv.user, e.unclaimed, { session });
    await recordTransaction({
      userId: inv.user, amount: e.unclaimed, currency: inv.currency, type: 'real_estate',
      metadata: { action: 'income', investmentId: inv._id }, session, prefix: 'RE'
    });
    return e.unclaimed;
  });
  res.json({ success: true, message: `${amount} added to your balance` });
});

/** POST /api/real-estate/investments/:id/redeem — at maturity: principal + remaining return */
export const redeem = handler(async (req, res) => {
  const payout = await withTransaction(async (session) => {
    const inv = await PropertyInvestment.findOne({ _id: req.params.id, user: req.user.id, status: 'active' }).session(session);
    if (!inv) throw new HttpError(404, 'Active investment not found');
    const e = earnings(inv);
    if (!e.matured) throw new HttpError(400, `This investment matures on ${inv.maturityAt.toISOString().slice(0, 10)}`);
    const total = round2(inv.amount + e.unclaimed);
    inv.incomeClaimed = round2(inv.incomeClaimed + e.unclaimed);
    inv.status = 'matured';
    inv.redeemedAt = new Date();
    inv.payout = total;
    await inv.save({ session });
    await creditUser(inv.user, total, { session });
    await recordTransaction({
      userId: inv.user, amount: total, currency: inv.currency, type: 'real_estate',
      metadata: { action: 'redeem', investmentId: inv._id }, session, prefix: 'RE'
    });
    return total;
  });
  res.json({ success: true, message: `${payout} returned to your balance` });
});

/* ------------------------------ Admin ------------------------------ */

const list = (v, max, len) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split('\n') : [])
  .map((x) => asString(x, len)).filter(Boolean).slice(0, max);

const propertyFields = (body) => {
  const out = {};
  if (body.title !== undefined) out.title = asString(body.title, 140);
  if (body.summary !== undefined) out.summary = asString(body.summary, 400);
  if (body.overview !== undefined || body.description !== undefined) out.overview = asString(body.overview ?? body.description, 8000);
  if (TYPES.includes(body.propertyType)) out.propertyType = body.propertyType;
  for (const k of ['assetType', 'strategy', 'objective']) if (body[k] !== undefined) out[k] = asString(body[k], 80);
  if (['open', 'closed'].includes(body.status)) out.status = body.status;
  if (typeof body.featured === 'boolean') out.featured = body.featured;
  if (body.location) {
    out.location = {
      address: asString(body.location.address, 200),
      city: asString(body.location.city, 80),
      country: asString(body.location.country, 80)
    };
  }
  if (body.images !== undefined) out.images = list(body.images, 12, 500).filter((u) => /^https?:\/\/|^\/uploads\//.test(u));
  if (body.whyProject !== undefined) out.whyProject = list(body.whyProject, 12, 600);
  if (body.whySponsor !== undefined) out.whySponsor = list(body.whySponsor, 12, 600);
  if (body.sponsor) out.sponsor = { name: asString(body.sponsor.name, 120), about: asString(body.sponsor.about, 2000) };
  if (Array.isArray(body.documents)) {
    out.documents = body.documents.slice(0, 20)
      .map((d) => ({ title: asString(d?.title, 120), url: asString(d?.url, 500) }))
      .filter((d) => d.title && /^https?:\/\/|^\/uploads\//.test(d.url));
  }
  for (const k of ['minimumInvestment', 'roi', 'fundingTarget']) {
    if (body[k] !== undefined) {
      const n = parseAmount(body[k], { allowZero: k === 'roi', max: 1e12 });
      if (n === null) throw new HttpError(400, `Invalid ${k}`);
      out[k] = n;
    }
  }
  for (const k of ['durationMonths', 'stories', 'sortOrder']) {
    if (body[k] !== undefined && body[k] !== null && body[k] !== '') {
      const n = k === 'durationMonths' ? parsePositiveInt(body[k]) : parseAmount(body[k], { allowZero: true });
      if (!n && n !== 0) throw new HttpError(400, `Invalid ${k}`);
      out[k] = Math.floor(n);
    }
  }
  return out;
};

export const adminListProperties = handler(async (_req, res) => {
  res.json({ success: true, data: await Property.find().sort({ status: 1, sortOrder: 1, createdAt: -1 }) });
});

export const adminCreateProperty = handler(async (req, res) => {
  const fields = propertyFields(req.body);
  for (const k of ['title', 'minimumInvestment', 'roi', 'durationMonths', 'fundingTarget']) {
    if (fields[k] === undefined) throw new HttpError(400, `${k} is required`);
  }
  fields.slug = `${fields.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${Date.now().toString(36)}`;
  res.status(201).json({ success: true, data: await Property.create(fields) });
});

export const adminUpdateProperty = handler(async (req, res) => {
  const property = await Property.findById(req.params.id);
  if (!property) throw new HttpError(404, 'Project not found');
  const fields = propertyFields(req.body);
  if (fields.fundingTarget !== undefined && fields.fundingTarget < property.amountRaised) {
    throw new HttpError(400, `fundingTarget cannot be below the amount already raised (${property.amountRaised})`);
  }
  if (fields.status === 'closed' && property.status !== 'closed') fields.closedAt = new Date();
  Object.assign(property, fields);
  await property.save();
  res.json({ success: true, data: property });
});

export const adminDeleteProperty = handler(async (req, res) => {
  if (await PropertyInvestment.exists({ property: req.params.id, status: 'active' })) {
    throw new HttpError(400, 'Project has active investors. Close it instead.');
  }
  const property = await Property.findByIdAndDelete(req.params.id);
  if (!property) throw new HttpError(404, 'Project not found');
  res.json({ success: true, message: 'Project deleted' });
});

export const adminListInvestments = handler(async (req, res) => {
  const { page, limit, skip } = paging(req.query);
  const filter = {};
  if (mongoose.Types.ObjectId.isValid(req.query.propertyId)) filter.property = req.query.propertyId;
  const now = new Date();
  const [items, total] = await Promise.all([
    PropertyInvestment.find(filter).populate('user', 'email firstName lastName accountId').populate('property', 'title')
      .sort({ createdAt: -1 }).skip(skip).limit(limit),
    PropertyInvestment.countDocuments(filter)
  ]);
  res.json({ success: true, data: { items: items.map((i) => presentInvestment(i, now)), total, page, limit } });
});
