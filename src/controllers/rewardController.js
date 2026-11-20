// Trader Rewards: milestones (admin), progress and claims (user), Reward Invoices (admin).
// Everything is driven from the admin dashboard: the program switch, which products'
// profit counts, every milestone, reward amount and claim fee.
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { RewardMilestone, RewardClaim } from '../models/Reward.js';
import Setting from '../models/Setting.js';
import User from '../models/User.js';
import Transaction from '../models/Transaction.js';
import PaymentMethod from '../models/PaymentMethod.js';
import { asString } from '../utils/validation.js';
import { HttpError, convertFromBase, creditUser, recordTransaction, withTransaction } from '../utils/wallet.js';
import { getBaseCurrency } from '../services/fx.js';
import { handler, notify, paging } from '../services/productService.js';
import { userProfit, PROFIT_SOURCES } from '../services/rewardProgress.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const oid = (id) => { if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, 'Invalid id'); return id; };
const round2 = (n) => Math.round(n * 100) / 100;
const money = (v) => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? round2(n) : NaN;
};

const programSettings = async () => {
  const s = await Setting.findOne().select('rewardProgram').lean();
  const p = s?.rewardProgram || {};
  return {
    enabled: !!p.enabled,
    title: p.title || 'Trader Rewards',
    description: p.description || '',
    sources: (p.sources?.length ? p.sources : Object.keys(PROFIT_SOURCES)).filter((k) => PROFIT_SOURCES[k])
  };
};
const UNAVAILABLE = 'Reward Program Currently Unavailable.';

/* ============================ User ============================ */

const claimView = (c) => ({
  id: c._id,
  milestone: c.milestone,
  stage: c.stage,
  invoiceNumber: c.invoiceNumber,
  snapshot: c.snapshot,
  payment: { status: c.payment?.status, amount: c.payment?.amount, currency: c.payment?.currency, note: c.payment?.note, submittedAt: c.payment?.submittedAt },
  reward: c.reward,
  note: c.note,
  createdAt: c.createdAt,
  reviewedAt: c.reviewedAt
});

/** GET /api/rewards — program, the user's profit, every milestone with progress, and the user's claims */
export const userRewards = handler(async (req, res) => {
  const program = await programSettings();
  if (!program.enabled) return res.json({ success: true, data: { enabled: false, message: UNAVAILABLE } });
  const user = await User.findById(req.user.id).select('currency').lean();
  const [profit, milestones, claims] = await Promise.all([
    userProfit(req.user.id, program.sources),
    RewardMilestone.find({ status: 'active' }).sort({ requiredProfit: 1, sortOrder: 1 }).lean(),
    RewardClaim.find({ user: req.user.id }).sort({ createdAt: -1 }).lean()
  ]);
  const { rate, currency } = await convertFromBase(1, user?.currency);
  const local = (v) => round2((v || 0) * rate);
  const activeClaim = new Map(claims.filter((c) => c.active).map((c) => [String(c.milestone), c]));

  res.json({
    success: true,
    data: {
      enabled: true,
      title: program.title,
      description: program.description,
      currency,
      profit: { total: local(profit.total), breakdown: profit.breakdown.map((b) => ({ ...b, amount: local(b.amount) })) },
      milestones: milestones.map((m) => {
        const claim = activeClaim.get(String(m._id));
        const progress = m.requiredProfit > 0 ? Math.min(100, Math.max(0, (profit.total / m.requiredProfit) * 100)) : 100;
        return {
          id: m._id, name: m.name, description: m.description, prize: m.prize,
          requiredProfit: local(m.requiredProfit), rewardAmount: local(m.rewardAmount), claimFee: local(m.claimFee),
          progress: round2(progress),
          remaining: local(Math.max(0, m.requiredProfit - profit.total)),
          achieved: profit.total >= m.requiredProfit,
          claim: claim ? claimView(claim) : null
        };
      }),
      claims: claims.map(claimView)
    }
  });
});

/** POST /api/rewards/milestones/:id/claim */
export const userClaim = handler(async (req, res) => {
  const program = await programSettings();
  if (!program.enabled) throw new HttpError(403, UNAVAILABLE);
  const m = await RewardMilestone.findOne({ _id: oid(req.params.id), status: 'active' }).lean();
  if (!m) throw new HttpError(404, 'This milestone is no longer available');
  const profit = await userProfit(req.user.id, program.sources);
  if (profit.total < m.requiredProfit) {
    const user = await User.findById(req.user.id).select('currency').lean();
    const { amount, currency } = await convertFromBase(m.requiredProfit - profit.total, user?.currency);
    throw new HttpError(400, `You need ${amount} ${currency} more profit to claim this reward`);
  }
  const base = await getBaseCurrency();
  const hasFee = m.claimFee > 0;
  try {
    const claim = await RewardClaim.create({
      user: req.user.id,
      milestone: m._id,
      snapshot: { name: m.name, requiredProfit: m.requiredProfit, rewardAmount: m.rewardAmount, claimFee: m.claimFee, prize: m.prize, baseCurrency: base },
      profitAtClaim: profit.total,
      stage: hasFee ? 'fee_unpaid' : 'review',
      invoiceNumber: hasFee ? '' : `RWD-${uuidv4().replace(/-/g, '').slice(0, 10).toUpperCase()}`,
      payment: { status: hasFee ? 'unpaid' : 'not_required' }
    });
    const user = await User.findById(req.user.id).select('currency').lean();
    const fee = await convertFromBase(m.claimFee, user?.currency);
    res.status(201).json({
      success: true,
      message: hasFee ? `Pay the ${fee.amount} ${fee.currency} claim fee to submit your reward` : 'Reward claimed. It is credited once approved.',
      data: { ...claimView(claim.toObject()), fee: { amount: fee.amount, currency: fee.currency } }
    });
  } catch (err) {
    if (err?.code === 11000) throw new HttpError(409, 'You already claimed this reward');
    throw err;
  }
});

/**
 * POST /api/rewards/claims/:id/pay   multipart: paymentMethod, paymentProof (file)
 * Pays the claim fee through one of the admin's payment methods; creates the reward invoice.
 */
export const userPayFee = handler(async (req, res) => {
  const methodId = asString(req.body.paymentMethod, 80);
  const proofFile = req.files?.paymentProof;
  if (!methodId) throw new HttpError(400, 'Choose a payment method');
  if (!proofFile) throw new HttpError(400, 'Upload your payment proof');
  const claim = await RewardClaim.findOne({ _id: oid(req.params.id), user: req.user.id });
  if (!claim) throw new HttpError(404, 'Reward claim not found');
  if (claim.stage !== 'fee_unpaid') throw new HttpError(409, claim.stage === 'review' ? 'Your claim is already being reviewed' : 'No fee is due on this claim');
  const method = await PaymentMethod.findOne({ methodId, isActive: true }).lean();
  if (!method) throw new HttpError(400, 'This payment method is not available. Choose another one.');

  const user = await User.findById(req.user.id).select('currency').lean();
  const quote = await convertFromBase(claim.snapshot.claimFee, user?.currency);
  const name = `${uuidv4()}${path.extname(proofFile.name || '') || '.jpg'}`;
  await proofFile.mv(path.join(__dirname, '../uploads/invoices', name));
  const reference = `RWF-${uuidv4().replace(/-/g, '').slice(0, 12).toUpperCase()}`;

  const updated = await RewardClaim.findOneAndUpdate(
    { _id: claim._id, stage: 'fee_unpaid' },
    {
      $set: {
        stage: 'review',
        invoiceNumber: claim.invoiceNumber || `RWD-${uuidv4().replace(/-/g, '').slice(0, 10).toUpperCase()}`,
        'payment.status': 'pending', 'payment.amount': quote.amount, 'payment.currency': quote.currency,
        'payment.baseAmount': claim.snapshot.claimFee, 'payment.paymentMethod': method.title || methodId,
        'payment.proof': `/uploads/invoices/${name}`, 'payment.reference': reference, 'payment.submittedAt': new Date(), 'payment.note': ''
      },
      $inc: { 'payment.attempts': 1 }
    },
    { new: true }
  );
  if (!updated) throw new HttpError(409, 'Your claim is already being reviewed');
  const tx = await Transaction.create({
    userId: req.user.id, amount: quote.amount, currency: quote.currency, type: 'reward', status: 'pending', reference,
    metadata: { rewardClaim: String(updated._id), payment: 'claim_fee', milestone: updated.snapshot.name, method: methodId }
  });
  updated.payment.transaction = tx._id;
  await updated.save();
  res.json({ success: true, message: 'Fee payment submitted. Your reward invoice is being reviewed.', data: claimView(updated.toObject()) });
});

/** POST /api/rewards/claims/:id/cancel — before paying the fee */
export const userCancelClaim = handler(async (req, res) => {
  const c = await RewardClaim.findOneAndUpdate(
    { _id: oid(req.params.id), user: req.user.id, stage: 'fee_unpaid' },
    { $set: { stage: 'rejected', active: false, note: 'Cancelled by you' } },
    { new: true }
  );
  if (!c) throw new HttpError(409, 'This claim can no longer be cancelled');
  res.json({ success: true, message: 'Claim cancelled' });
});

/* ============================ Admin: program & milestones ============================ */

export const adminGetProgram = handler(async (_req, res) => {
  const [program, milestones, counts, base] = await Promise.all([
    programSettings(),
    RewardMilestone.find().sort({ requiredProfit: 1, sortOrder: 1 }).lean(),
    RewardClaim.aggregate([{ $group: { _id: { m: '$milestone', s: '$stage' }, n: { $sum: 1 } } }]),
    getBaseCurrency()
  ]);
  const by = {};
  for (const c of counts) {
    const k = String(c._id.m);
    by[k] = by[k] || { review: 0, approved: 0, fee_unpaid: 0, rejected: 0 };
    by[k][c._id.s] = c.n;
  }
  res.json({
    success: true,
    data: {
      program, currency: base,
      sources: Object.entries(PROFIT_SOURCES).map(([key, s]) => ({ key, label: s.label })),
      milestones: milestones.map((m) => ({ ...m, claims: by[String(m._id)] || { review: 0, approved: 0, fee_unpaid: 0, rejected: 0 } }))
    }
  });
});

/** PUT /api/admin/rewards/program  { enabled?, title?, description?, sources? } */
export const adminUpdateProgram = handler(async (req, res) => {
  const b = req.body || {};
  const set = {};
  if (typeof b.enabled === 'boolean') set['rewardProgram.enabled'] = b.enabled;
  if (b.title !== undefined) set['rewardProgram.title'] = asString(b.title, 80) || 'Trader Rewards';
  if (b.description !== undefined) set['rewardProgram.description'] = asString(b.description, 500);
  if (b.sources !== undefined) {
    const list = (Array.isArray(b.sources) ? b.sources : []).filter((k) => PROFIT_SOURCES[k]);
    if (!list.length) throw new HttpError(400, 'Choose at least one product whose profit counts');
    set['rewardProgram.sources'] = [...new Set(list)];
  }
  if (!Object.keys(set).length) throw new HttpError(400, 'Nothing to update');
  await Setting.updateOne({}, { $set: set }, { upsert: true });
  const program = await programSettings();
  res.json({
    success: true,
    message: typeof b.enabled === 'boolean' ? (b.enabled ? 'Reward program enabled' : 'Reward program disabled') : 'Reward program saved',
    data: program
  });
});

const readMilestone = (b, { partial = false } = {}) => {
  const out = {};
  const errors = [];
  const has = (k) => !partial || b[k] !== undefined;
  if (has('name')) { out.name = asString(b.name, 80); if (out.name.length < 2) errors.push('Enter a milestone name'); }
  if (has('requiredProfit')) { out.requiredProfit = money(b.requiredProfit); if (!(out.requiredProfit > 0)) errors.push('Required profit must be more than 0'); }
  if (has('rewardAmount')) { out.rewardAmount = money(b.rewardAmount); if (!(out.rewardAmount > 0)) errors.push('Reward amount must be more than 0'); }
  if (b.claimFee !== undefined && b.claimFee !== '') { out.claimFee = money(b.claimFee); if (!(out.claimFee >= 0)) errors.push('Claim fee must be 0 or more'); } else if (!partial) out.claimFee = 0;
  if (b.prize !== undefined) out.prize = asString(b.prize, 300);
  if (b.description !== undefined) out.description = asString(b.description, 300);
  if (b.status !== undefined) { if (['active', 'hidden'].includes(b.status)) out.status = b.status; else errors.push('Status must be active or hidden'); }
  if (b.sortOrder !== undefined && b.sortOrder !== '') out.sortOrder = Number(b.sortOrder) || 0;
  if (errors.length) throw new HttpError(400, errors.join('. '));
  return out;
};

export const adminCreateMilestone = handler(async (req, res) => {
  const m = await RewardMilestone.create(readMilestone(req.body || {}));
  res.status(201).json({ success: true, message: `${m.name} created`, data: m });
});

export const adminUpdateMilestone = handler(async (req, res) => {
  const m = await RewardMilestone.findByIdAndUpdate(oid(req.params.id), { $set: readMilestone(req.body || {}, { partial: true }) }, { new: true, runValidators: true });
  if (!m) throw new HttpError(404, 'Milestone not found');
  res.json({ success: true, message: `${m.name} saved`, data: m });
});

/** DELETE — refused while claims are waiting for review (hide it instead). */
export const adminDeleteMilestone = handler(async (req, res) => {
  const id = oid(req.params.id);
  const waiting = await RewardClaim.countDocuments({ milestone: id, stage: { $in: ['fee_unpaid', 'review'] } });
  if (waiting) throw new HttpError(409, `${waiting} claim${waiting === 1 ? ' is' : 's are'} still open for this milestone. Settle ${waiting === 1 ? 'it' : 'them'} in Reward Invoices first, or hide the milestone.`);
  const m = await RewardMilestone.findByIdAndDelete(id);
  if (!m) throw new HttpError(404, 'Milestone not found');
  res.json({ success: true, message: `${m.name} deleted` });
});

/* ============================ Admin: Reward Invoices ============================ */

export const adminListClaims = handler(async (req, res) => {
  const { page, limit, skip } = paging(req.query, 20);
  const q = {};
  const s = String(req.query.status || '');
  if (['fee_unpaid', 'review', 'approved', 'rejected'].includes(s)) q.stage = s;
  if (req.query.search) {
    const rx = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const users = await User.find({ $or: [{ email: rx }, { firstName: rx }, { lastName: rx }] }).select('_id').limit(200).lean();
    q.$or = [{ user: { $in: users.map((u) => u._id) } }, { 'snapshot.name': rx }, { invoiceNumber: rx }];
  }
  const [items, total, counts] = await Promise.all([
    RewardClaim.find(q).sort({ updatedAt: -1 }).skip(skip).limit(limit).populate('user', 'firstName lastName email accountId currency').lean(),
    RewardClaim.countDocuments(q),
    RewardClaim.aggregate([{ $group: { _id: '$stage', n: { $sum: 1 } } }])
  ]);
  res.json({ success: true, data: { items, total, page, limit, counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) } });
});

/** GET /:id — the claim with the user's current profit for a second check */
export const adminGetClaim = handler(async (req, res) => {
  const c = await RewardClaim.findById(oid(req.params.id)).populate('user', 'firstName lastName email accountId currency balance').lean();
  if (!c) throw new HttpError(404, 'Reward claim not found');
  const program = await programSettings();
  const profit = await userProfit(c.user._id, program.sources);
  res.json({ success: true, data: { ...c, currentProfit: profit } });
});

/**
 * PATCH /:id/:decision   decision = approve | reject
 * body: { note?, final? }   reject with final=false (default when a fee was paid) sends
 * the claim back so the user can pay the fee again; final=true closes the claim.
 */
export const adminDecideClaim = handler(async (req, res) => {
  const decision = req.params.decision;
  if (!['approve', 'reject'].includes(decision)) throw new HttpError(400, 'Unknown action');
  const note = asString(req.body?.note, 500);
  const claim = await RewardClaim.findById(oid(req.params.id)).lean();
  if (!claim) throw new HttpError(404, 'Reward claim not found');
  if (claim.stage !== 'review') throw new HttpError(409, 'Only claims under review can be decided');

  if (decision === 'reject') {
    if (!note) throw new HttpError(400, 'Give the user a reason');
    const feeRetry = claim.snapshot?.claimFee > 0 && req.body?.final !== true;
    const r = await RewardClaim.findOneAndUpdate(
      { _id: claim._id, stage: 'review' },
      {
        $set: feeRetry
          ? { stage: 'fee_unpaid', 'payment.status': 'rejected', 'payment.note': note, note }
          : { stage: 'rejected', active: false, 'payment.status': claim.payment?.status === 'pending' ? 'rejected' : claim.payment?.status, note, reviewedAt: new Date(), reviewedBy: req.user?.id }
      },
      { new: true }
    );
    if (!r) throw new HttpError(409, 'This claim was already decided');
    if (claim.payment?.transaction) await Transaction.updateOne({ _id: claim.payment.transaction, status: 'pending' }, { $set: { status: 'failed' } });
    notify(claim.user, {
      title: feeRetry ? 'Reward fee payment rejected' : 'Reward claim rejected',
      content: feeRetry ? `Your ${claim.snapshot.name} fee payment was rejected: ${note}. You can pay again from Rewards.` : `Your ${claim.snapshot.name} reward claim was rejected: ${note}`,
      type: 'transaction', link: '/rewards', metadata: { rewardClaim: String(claim._id) }
    }).catch(() => {});
    return res.json({ success: true, message: feeRetry ? 'Fee payment rejected. The user can pay again.' : 'Claim rejected', data: r });
  }

  // Approve: credit the reward once (the stage change is the guard).
  const user = await User.findById(claim.user).select('currency').lean();
  if (!user) throw new HttpError(404, 'The user no longer exists');
  const { amount, currency } = await convertFromBase(claim.snapshot.rewardAmount, user.currency);
  const result = await withTransaction(async (session) => {
    const r = await RewardClaim.findOneAndUpdate(
      { _id: claim._id, stage: 'review' },
      {
        $set: {
          stage: 'approved', reviewedAt: new Date(), reviewedBy: req.user?.id, note,
          'payment.status': claim.payment?.status === 'pending' ? 'approved' : claim.payment?.status,
          'reward.amount': amount, 'reward.currency': currency, 'reward.creditedAt': new Date()
        }
      },
      { new: true, session }
    );
    if (!r) throw new HttpError(409, 'This claim was already decided');
    await creditUser(claim.user, amount, { session });
    const tx = await recordTransaction({
      userId: claim.user, amount, currency, type: 'reward', session, prefix: 'RWD',
      metadata: { rewardClaim: String(claim._id), milestone: claim.snapshot.name, invoice: claim.invoiceNumber }
    });
    r.reward.transaction = tx?._id;
    await r.save({ session });
    return r;
  });
  if (claim.payment?.transaction) await Transaction.updateOne({ _id: claim.payment.transaction, status: 'pending' }, { $set: { status: 'completed' } });
  notify(claim.user, {
    title: 'Reward credited',
    content: `Your ${claim.snapshot.name} reward of ${amount} ${currency} was added to your balance.`,
    type: 'transaction', link: '/rewards', metadata: { rewardClaim: String(claim._id) }
  }).catch(() => {});
  res.json({ success: true, message: `Reward approved: ${amount} ${currency} credited`, data: result });
});
