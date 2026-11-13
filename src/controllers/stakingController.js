// Staking pools: users stake an amount of a crypto asset (e.g. 9–1000 AVAX).
// Cost and payouts convert at the asset's live USD price into the user's currency.
// Rewards are earned in the asset for every completed cycle (daily / weekly / monthly).
import mongoose from 'mongoose';
import { StakingPlan, StakePosition, CYCLE_DAYS } from '../models/Staking.js';
import User from '../models/User.js';
import { parseAmount, round2, round8 } from '../utils/money.js';
import { asString } from '../utils/validation.js';
import { withTransaction, debitUser, creditUser, recordTransaction, HttpError } from '../utils/wallet.js';
import { handler, loadActiveUser, addDays, paging } from '../services/productService.js';
import { getUsdPrice, getUsdPrices, usdToCurrency } from '../services/priceService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Completed cycles and earned rewards (asset units) for a position at `now`. */
export const rewardState = (p, now = new Date()) => {
  const cycleMs = (CYCLE_DAYS[p.cycle] || 1) * DAY_MS;
  const until = p.endAt && now > p.endAt ? p.endAt : now;
  const elapsed = Math.max(0, until - new Date(p.startAt));
  const cycles = Math.floor(elapsed / cycleMs);
  const perCycle = p.assetAmount * (p.apy / 100) * ((CYCLE_DAYS[p.cycle] || 1) / 365);
  const earned = round8(perCycle * cycles);
  const nextRewardAt = p.endAt && now >= p.endAt ? null : new Date(new Date(p.startAt).getTime() + (cycles + 1) * cycleMs);
  return {
    cycles,
    perCycle: round8(perCycle),
    earned,
    unclaimed: round8(Math.max(0, earned - p.claimedRewards)),
    matured: !p.endAt || now >= p.endAt,
    nextRewardAt
  };
};

const priceOf = async (plan) => {
  const price = await getUsdPrice(plan.asset, plan.price || null);
  if (!(price > 0)) throw new HttpError(503, `No price is available for ${plan.asset} right now. Please try again shortly.`);
  return price;
};

const presentPosition = (p, price, fx, now) => {
  const r = rewardState(p, now);
  const obj = p.toObject();
  const valueUsd = (p.assetAmount + r.unclaimed) * (price || p.priceAtStake);
  return {
    ...obj,
    id: obj._id,
    cycles: r.cycles,
    rewardPerCycle: r.perCycle,
    earnedRewards: r.earned,
    unclaimedRewards: r.unclaimed,
    unclaimedValue: round2(r.unclaimed * (price || 0) * fx),
    nextRewardAt: p.status === 'active' ? r.nextRewardAt : null,
    matured: p.lockDays === 0 ? true : r.matured,
    currentPrice: price,
    currentValue: p.status === 'active' ? round2(valueUsd * fx) : 0,
    progressPercent: p.endAt ? Math.min(100, Math.round(((now - p.startAt) / (p.endAt - p.startAt)) * 100)) : null
  };
};

/** GET /api/staking/pools — active pools with live prices */
export const listPlans = handler(async (req, res) => {
  const user = await User.findById(req.user.id).select('currency balance');
  const plans = await StakingPlan.find({ isActive: true }).sort({ sortOrder: 1, asset: 1 });
  const [prices, fx] = await Promise.all([
    getUsdPrices(plans.map((p) => p.asset), Object.fromEntries(plans.map((p) => [p.asset, p.price || null]))),
    usdToCurrency(1, user.currency)
  ]);
  res.json({
    success: true,
    data: {
      currency: user.currency,
      availableBalance: user.balance,
      pools: plans.map((p) => {
        const price = prices[p.asset];
        return {
          ...p.toObject(),
          id: p._id,
          price,
          localPrice: price ? round2(price * fx.rate) : null,
          cycleRatePercent: round8((p.apy * (CYCLE_DAYS[p.cycle] || 1)) / 365),
          remainingCapacity: p.capacity ? round8(Math.max(0, p.capacity - p.totalStaked)) : null
        };
      })
    }
  });
});

/** GET /api/staking/history?status=active|closed */
export const listPositions = handler(async (req, res) => {
  const now = new Date();
  const user = await User.findById(req.user.id).select('currency');
  const filter = { user: req.user.id };
  if (req.query.status === 'active') filter.status = 'active';
  if (req.query.status === 'closed') filter.status = { $in: ['completed', 'cancelled'] };
  const positions = await StakePosition.find(filter).populate('plan', 'name asset icon price').sort({ createdAt: -1 }).limit(200);
  const [prices, fx] = await Promise.all([
    getUsdPrices(positions.map((p) => p.asset), Object.fromEntries(positions.map((p) => [p.asset, p.plan?.price || p.priceAtStake]))),
    usdToCurrency(1, user.currency)
  ]);
  const items = positions.map((p) => presentPosition(p, prices[p.asset], fx.rate, now));
  const active = items.filter((p) => p.status === 'active');
  res.json({
    success: true,
    data: {
      currency: user.currency,
      positions: items,
      totals: {
        activeStakes: active.length,
        stakedValue: round2(active.reduce((s, p) => s + p.currentValue, 0)),
        unclaimedValue: round2(active.reduce((s, p) => s + p.unclaimedValue, 0)),
        rewardsPaid: round2(items.reduce((s, p) => s + (p.claimedValue || 0), 0))
      }
    }
  });
});

/** POST /api/staking/stake  { poolId, amount }  — amount in units of the pool's asset */
export const stake = handler(async (req, res) => {
  const assetAmount = parseAmount(req.body.amount);
  const poolId = req.body.poolId || req.body.planId;
  if (assetAmount === null) throw new HttpError(400, 'Enter a valid amount');
  if (!mongoose.Types.ObjectId.isValid(poolId)) throw new HttpError(400, 'Invalid pool');

  const user = await loadActiveUser(req.user.id);
  const plan = await StakingPlan.findOne({ _id: poolId, isActive: true });
  if (!plan) throw new HttpError(404, 'This pool is not available');
  if (assetAmount < plan.minAmount) throw new HttpError(400, `Minimum stake is ${plan.minAmount} ${plan.asset}`);
  if (assetAmount > plan.maxAmount) throw new HttpError(400, `Maximum stake is ${plan.maxAmount} ${plan.asset}`);

  const price = await priceOf(plan);
  const { amount: cost } = await usdToCurrency(assetAmount * price, user.currency);
  if (!(cost >= 0.01)) throw new HttpError(400, 'Amount is too small');

  const position = await withTransaction(async (session) => {
    const capFilter = plan.capacity > 0
      ? { _id: plan._id, $expr: { $lte: [{ $add: ['$totalStaked', assetAmount] }, '$capacity'] } }
      : { _id: plan._id };
    const reserved = await StakingPlan.updateOne(capFilter, { $inc: { totalStaked: assetAmount } }, { session });
    if (reserved.modifiedCount !== 1) throw new HttpError(400, 'This pool is full');

    await debitUser(user._id, cost, { session });
    const now = new Date();
    const [p] = await StakePosition.create([{
      user: user._id,
      plan: plan._id,
      asset: plan.asset,
      assetName: plan.name,
      assetAmount: round8(assetAmount),
      priceAtStake: price,
      amount: cost,
      currency: user.currency,
      apy: plan.apy,
      cycle: plan.cycle,
      lockDays: plan.lockDays,
      startAt: now,
      endAt: plan.lockDays > 0 ? addDays(now, plan.lockDays) : null
    }], { session });
    await recordTransaction({
      userId: user._id, amount: cost, currency: user.currency, type: 'staking',
      metadata: { action: 'stake', asset: plan.asset, assetAmount, priceUsd: price, positionId: p._id }, session, prefix: 'STK'
    });
    return p;
  });

  res.status(201).json({ success: true, message: `Staked ${assetAmount} ${plan.asset}`, data: position });
});

/** POST /api/staking/positions/:id/claim — pay out rewards from completed cycles */
export const claimRewards = handler(async (req, res) => {
  const user = await User.findById(req.user.id).select('currency');
  const pos = await StakePosition.findOne({ _id: req.params.id, user: req.user.id, status: 'active' });
  if (!pos) throw new HttpError(404, 'Active stake not found');
  const r = rewardState(pos);
  if (pos.lockDays > 0 && !r.matured) throw new HttpError(400, 'Rewards for locked pools are paid when the lock ends');
  if (!(r.unclaimed > 0)) throw new HttpError(400, 'No completed cycles to claim yet');
  const price = await getUsdPrice(pos.asset, pos.priceAtStake);
  const { amount: value } = await usdToCurrency(r.unclaimed * price, user.currency);
  if (!(value >= 0.01)) throw new HttpError(400, 'Rewards are too small to claim yet');

  await withTransaction(async (session) => {
    // Conditional on the claimed total we read, so two claims can't pay the same rewards.
    const ok = await StakePosition.updateOne(
      { _id: pos._id, status: 'active', claimedRewards: pos.claimedRewards },
      { $inc: { claimedRewards: r.unclaimed, claimedValue: value }, $set: { lastClaimAt: new Date() } },
      { session }
    );
    if (ok.modifiedCount !== 1) throw new HttpError(409, 'Rewards were just claimed');
    await creditUser(pos.user, value, { session });
    await recordTransaction({
      userId: pos.user, amount: value, currency: user.currency, type: 'staking',
      metadata: { action: 'reward', asset: pos.asset, assetAmount: r.unclaimed, priceUsd: price, positionId: pos._id }, session, prefix: 'STK'
    });
  });
  res.json({ success: true, message: `${r.unclaimed} ${pos.asset} rewards (${value} ${user.currency}) added to your balance`, data: { assetAmount: r.unclaimed, value } });
});

/** POST /api/staking/positions/:id/unstake — return the stake (and unclaimed rewards) at today's price */
export const unstake = handler(async (req, res) => {
  const user = await User.findById(req.user.id).select('currency');
  const pos = await StakePosition.findOne({ _id: req.params.id, user: req.user.id, status: 'active' });
  if (!pos) throw new HttpError(404, 'Active stake not found');
  const plan = await StakingPlan.findById(pos.plan);
  const r = rewardState(pos);
  const early = pos.lockDays > 0 && !r.matured;
  if (early && !plan?.allowEarlyUnstake) {
    throw new HttpError(400, `This stake is locked until ${pos.endAt.toISOString().slice(0, 10)}`);
  }

  const penaltyUnits = early ? round8(pos.assetAmount * ((plan.earlyUnstakePenaltyPercent || 0) / 100)) : 0;
  const rewardUnits = early ? 0 : r.unclaimed; // rewards are forfeited on early exit
  const units = round8(pos.assetAmount - penaltyUnits + rewardUnits);
  const price = await getUsdPrice(pos.asset, plan?.price || pos.priceAtStake);
  const { amount: payout } = await usdToCurrency(units * price, user.currency);

  await withTransaction(async (session) => {
    const closed = await StakePosition.updateOne(
      { _id: pos._id, status: 'active' },
      {
        $set: { status: early ? 'cancelled' : 'completed', closedAt: new Date(), payout, penalty: penaltyUnits },
        $inc: { claimedRewards: rewardUnits }
      },
      { session }
    );
    if (closed.modifiedCount !== 1) throw new HttpError(409, 'This stake was already closed');
    if (plan) await StakingPlan.updateOne({ _id: plan._id }, [{ $set: { totalStaked: { $max: [0, { $subtract: ['$totalStaked', pos.assetAmount] }] } } }], { session });
    if (payout > 0) await creditUser(pos.user, payout, { session });
    await recordTransaction({
      userId: pos.user, amount: payout, currency: user.currency, type: 'staking',
      metadata: { action: early ? 'early_unstake' : 'unstake', asset: pos.asset, assetAmount: units, penaltyUnits, priceUsd: price, positionId: pos._id }, session, prefix: 'STK'
    });
  });

  res.json({
    success: true,
    message: early
      ? `Unstaked early: ${units} ${pos.asset} (${payout} ${user.currency}) returned, ${penaltyUnits} ${pos.asset} penalty`
      : `${units} ${pos.asset} (${payout} ${user.currency}) returned to your balance`,
    data: { units, payout, penaltyUnits, early }
  });
});

/* ------------------------------ Admin ------------------------------ */

const planFields = (body) => {
  const out = {};
  if (body.asset !== undefined) out.asset = asString(body.asset, 12).toUpperCase();
  for (const k of ['name', 'icon', 'description']) if (body[k] !== undefined) out[k] = asString(body[k], k === 'description' ? 1000 : 200);
  if (body.cycle !== undefined) {
    if (!CYCLE_DAYS[body.cycle]) throw new HttpError(400, 'cycle must be daily, weekly or monthly');
    out.cycle = body.cycle;
  }
  for (const k of ['apy', 'lockDays', 'minAmount', 'maxAmount', 'earlyUnstakePenaltyPercent', 'capacity', 'price', 'sortOrder']) {
    if (body[k] !== undefined) {
      const n = parseAmount(body[k], { allowZero: true, max: 1e12 });
      if (n === null) throw new HttpError(400, `Invalid ${k}`);
      out[k] = k === 'lockDays' || k === 'sortOrder' ? Math.floor(n) : n;
    }
  }
  for (const k of ['allowEarlyUnstake', 'isActive']) if (typeof body[k] === 'boolean') out[k] = body[k];
  if (out.minAmount !== undefined && out.maxAmount !== undefined && out.maxAmount < out.minAmount) {
    throw new HttpError(400, 'maxAmount must be at least minAmount');
  }
  return out;
};

export const adminListPlans = handler(async (_req, res) => {
  res.json({ success: true, data: await StakingPlan.find().sort({ sortOrder: 1, asset: 1 }) });
});

export const adminCreatePlan = handler(async (req, res) => {
  const fields = planFields(req.body);
  for (const k of ['asset', 'name', 'apy', 'minAmount', 'maxAmount']) {
    if (fields[k] === undefined || fields[k] === '') throw new HttpError(400, `${k} is required`);
  }
  res.status(201).json({ success: true, data: await StakingPlan.create(fields) });
});

export const adminUpdatePlan = handler(async (req, res) => {
  // New terms apply to new stakes; existing stakes keep the APY, cycle and lock they started with.
  const plan = await StakingPlan.findByIdAndUpdate(req.params.id, { $set: planFields(req.body) }, { new: true, runValidators: true });
  if (!plan) throw new HttpError(404, 'Pool not found');
  res.json({ success: true, data: plan });
});

export const adminDeletePlan = handler(async (req, res) => {
  if (await StakePosition.exists({ plan: req.params.id, status: 'active' })) throw new HttpError(400, 'Pool has active stakes. Deactivate it instead.');
  const plan = await StakingPlan.findByIdAndDelete(req.params.id);
  if (!plan) throw new HttpError(404, 'Pool not found');
  res.json({ success: true, message: 'Pool deleted' });
});

export const adminListPositions = handler(async (req, res) => {
  const { page, limit, skip } = paging(req.query);
  const filter = {};
  if (['active', 'completed', 'cancelled'].includes(req.query.status)) filter.status = req.query.status;
  const now = new Date();
  const [items, total] = await Promise.all([
    StakePosition.find(filter).populate('user', 'email firstName lastName accountId').populate('plan', 'name asset')
      .sort({ createdAt: -1 }).skip(skip).limit(limit),
    StakePosition.countDocuments(filter)
  ]);
  res.json({ success: true, data: { items: items.map((p) => presentPosition(p, null, 1, now)), total, page, limit } });
});
