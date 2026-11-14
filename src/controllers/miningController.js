// Mining: buy machines, run sessions in a pool, earn per the machines' daily yield,
// boost with boosters, and claim rewards to your balance. Economics: services/miningEngine.js
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import User from '../models/User.js';
import Setting from '../models/Setting.js';
import MiningSession from '../models/MiningSession.js';
import MiningEquipment from '../models/MiningEquipment.js';
import MiningReward from '../models/MiningReward.js';
import MiningPool from '../models/MiningPool.js';
import MiningBooster from '../models/MiningBooster.js';
import { round2 } from '../utils/money.js';
import { rateBetween } from '../services/fx.js';
import { withTransaction, debitUser, creditUser, recordTransaction, convertFromBase, HttpError } from '../utils/wallet.js';
import { handler, loadActiveUser } from '../services/productService.js';
import {
  getCatalog as loadCatalog, MAX_SESSION_HOURS, ensureDefaultPools,
  machineDailyYield, sessionEarnings, finishSession
} from '../services/miningEngine.js';

const err = (status, message) => new HttpError(status, message);

/** GET /api/mining/catalog — machines and boosters for sale, priced in the user's currency */
export const getCatalog = handler(async (req, res) => {
  const user = await User.findById(req.user.id).select('currency balance').lean();
  const { rate } = await convertFromBase(1, user.currency);
  const { equipment: EQUIPMENT, boosters: BOOSTERS } = await loadCatalog();
  res.json({
    success: true,
    currency: user.currency,
    balance: user.balance,
    maxSessionHours: MAX_SESSION_HOURS,
    equipment: Object.entries(EQUIPMENT).map(([id, t]) => ({
      id, name: t.name, type: t.type, hashRate: t.hashRate, powerConsumption: t.powerConsumption,
      price: round2(t.price * rate), dailyYieldPercent: t.dailyYieldPercent, dailyEarnings: round2(t.price * rate * (t.dailyYieldPercent / 100))
    })),
    boosters: Object.entries(BOOSTERS).map(([id, b]) => ({
      id, name: b.name, type: b.type, multiplier: b.multiplier, duration: b.duration, description: b.description, price: round2(b.price * rate)
    }))
  });
});

/** POST /api/mining/start  { poolId } */
export const startMining = handler(async (req, res) => {
  const user = await loadActiveUser(req.user.id);
  await ensureDefaultPools();
  const poolId = req.body.poolId || user.mining?.defaultPool;
  const pool = mongoose.Types.ObjectId.isValid(poolId) ? await MiningPool.findOne({ _id: poolId, status: 'active' }) : await MiningPool.findOne({ status: 'active' });
  if (!pool) throw err(404, 'Choose an active mining pool');

  const equipment = await MiningEquipment.find({ userId: user._id, status: 'active' });
  if (!equipment.length) throw err(400, 'Buy or activate a machine first');

  let dailyYield = 0;
  for (const eq of equipment) {
    // eslint-disable-next-line no-await-in-loop
    dailyYield += await machineDailyYield(eq, user.currency);
  }
  const startedAt = new Date();

  const session = await withTransaction(async (s) => {
    // Signal cost rule kept from the platform settings.
    const settings = await Setting.findOne().select('signalStrength').lean();
    const cost = Number(settings?.signalStrength?.mining) || 0;
    if (cost > 0) {
      const ok = await User.updateOne({ _id: user._id, tradingSignalStrength: { $gte: cost } }, { $inc: { tradingSignalStrength: -cost } }, { session: s });
      if (ok.modifiedCount !== 1) throw err(400, `Not enough signal strength (needs ${cost}%)`);
    }
    if (await MiningSession.exists({ userId: user._id, status: 'active' }).session(s)) throw err(400, 'You are already mining');
    const [created] = await MiningSession.create([{
      userId: user._id,
      poolId: pool._id,
      equipment: equipment.map((e) => e._id),
      hashRate: equipment.reduce((sum, e) => sum + e.hashRate, 0),
      powerConsumption: equipment.reduce((sum, e) => sum + e.powerConsumption, 0),
      status: 'active',
      startedAt,
      metadata: {
        endsAt: new Date(startedAt.getTime() + MAX_SESSION_HOURS * 3600e3),
        dailyYield: round2(dailyYield),
        currency: user.currency,
        poolFee: pool.fee || 0,
        coin: pool.supportedCoins?.[0] || 'BTC'
      }
    }], { session: s });
    await MiningEquipment.updateMany({ userId: user._id, status: 'active' }, { $set: { miningSessionId: created._id } }, { session: s });
    return created;
  });

  res.json({
    success: true,
    message: 'Mining started',
    session: {
      id: session._id, hashRate: session.hashRate, powerConsumption: session.powerConsumption,
      pool: pool.name, startedAt: session.startedAt, endsAt: session.metadata.endsAt, dailyEarnings: session.metadata.dailyYield
    }
  });
});

/** POST /api/mining/stop */
export const stopMining = handler(async (req, res) => {
  const active = await MiningSession.findOne({ userId: req.user.id, status: 'active' });
  if (!active) throw err(404, 'You are not mining right now');
  const result = await finishSession(active._id, 'stopped');
  if (!result) throw err(409, 'Session already ended');
  const { session, reward } = result;
  res.json({
    success: true,
    message: reward ? `Session ended: ${session.earnings} ${session.metadata.currency} ready to claim` : 'Session ended',
    session: { id: session._id, duration: session.duration, earnings: session.earnings, rewards: session.rewards }
  });
});

/** GET /api/mining/stats */
export const getMiningStats = handler(async (req, res) => {
  const userId = req.user.id;
  const currency = (await User.findById(userId).select('currency').lean())?.currency || 'USD';
  let active = await MiningSession.findOne({ userId, status: 'active' }).populate('poolId', 'name fee supportedCoins');
  if (active && new Date(active.metadata?.endsAt) <= new Date()) {
    await finishSession(active._id, 'auto');
    active = null;
  }
  const [equipment, claimed, pending, sessions] = await Promise.all([
    MiningEquipment.find({ userId }).lean(),
    MiningReward.find({ userId, status: 'claimed' }).select('value amount claimedAt').lean(),
    MiningReward.find({ userId, status: 'pending' }).select('value').lean(),
    MiningSession.find({ userId }).select('duration').lean()
  ]);
  const activeEq = equipment.filter((e) => e.status === 'active');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const live = active ? await sessionEarnings(active) : null;
  let dailyYield = 0;
  for (const eq of activeEq) {
    // eslint-disable-next-line no-await-in-loop
    dailyYield += await machineDailyYield(eq, currency);
  }

  res.json({
    success: true,
    stats: {
      currency,
      hashRate: activeEq.reduce((s, e) => s + e.hashRate, 0),
      powerConsumption: activeEq.reduce((s, e) => s + e.powerConsumption, 0),
      temperature: activeEq.length ? round2(activeEq.reduce((s, e) => s + (e.temperature || 0), 0) / activeEq.length) : 0,
      efficiency: 0,
      machines: equipment.length,
      activeMachines: activeEq.length,
      dailyEarnings: round2(dailyYield),
      coinsMined: round2(claimed.reduce((s, r) => s + (r.amount || 0), 0) * 1e8) / 1e8,
      earningsToday: round2(claimed.filter((r) => r.claimedAt >= today).reduce((s, r) => s + r.value, 0)),
      totalEarnings: round2(claimed.reduce((s, r) => s + r.value, 0)),
      pendingRewards: round2(pending.reduce((s, r) => s + r.value, 0)),
      activeTime: sessions.reduce((s, x) => s + (x.duration || 0), 0) + (live?.seconds || 0),
      isMining: !!active,
      activeSession: active ? {
        id: active._id,
        startedAt: active.startedAt,
        endsAt: active.metadata?.endsAt,
        hashRate: active.hashRate,
        poolId: active.poolId?._id,
        pool: active.poolId?.name,
        poolFee: active.metadata?.poolFee || 0,
        dailyEarnings: active.metadata?.dailyYield || 0,
        earnedSoFar: live?.net || 0
      } : null
    }
  });
});

/** GET /api/mining/equipment */
export const getEquipment = handler(async (req, res) => {
  const currency = (await User.findById(req.user.id).select('currency').lean())?.currency || 'USD';
  const equipment = await MiningEquipment.find({ userId: req.user.id }).sort({ createdAt: -1 });
  const out = [];
  for (const eq of equipment) {
    // eslint-disable-next-line no-await-in-loop
    const daily = await machineDailyYield(eq, currency);
    out.push({
      id: eq._id, name: eq.name, type: eq.type, hashRate: eq.hashRate, powerConsumption: eq.powerConsumption,
      efficiency: eq.efficiency, status: eq.status, temperature: eq.temperature, purchasePrice: eq.metadata?.priceLocal ?? eq.purchasePrice,
      dailyEarnings: daily, totalRuntime: eq.totalRuntime, miningSessionId: eq.miningSessionId, createdAt: eq.createdAt
    });
  }
  res.json({ success: true, equipment: out });
});

/** POST /api/mining/purchase-equipment  { equipmentId } */
export const purchaseEquipment = handler(async (req, res) => {
  const tpl = (await loadCatalog()).equipment[req.body.equipmentId];
  if (!tpl) throw err(404, 'Machine not found');
  const user = await loadActiveUser(req.user.id);
  const { amount: price } = await convertFromBase(tpl.price, user.currency);
  const equipment = await withTransaction(async (s) => {
    await debitUser(user._id, price, { session: s });
    const [eq] = await MiningEquipment.create([{
      userId: user._id, name: tpl.name, type: tpl.type, hashRate: tpl.hashRate, powerConsumption: tpl.powerConsumption,
      efficiency: tpl.efficiency, status: 'active', purchasePrice: tpl.price,
      metadata: { catalogId: req.body.equipmentId, priceLocal: price, currency: user.currency, dailyYield: round2(price * (tpl.dailyYieldPercent / 100)) }
    }], { session: s });
    await recordTransaction({ userId: user._id, amount: price, currency: user.currency, type: 'mining', metadata: { action: 'buy_machine', machine: tpl.name, equipmentId: eq._id }, session: s, prefix: 'MIN' });
    return eq;
  });
  res.json({ success: true, message: `${tpl.name} added to your rig`, equipment: { id: equipment._id, name: equipment.name, hashRate: equipment.hashRate, status: equipment.status } });
});

const setEquipmentStatus = async (userId, filter, status) => {
  if (await MiningSession.exists({ userId, status: 'active' })) throw err(400, 'Stop mining before changing machines');
  return MiningEquipment.updateMany({ userId, ...filter }, { $set: { status } });
};

/** POST /api/mining/activate-equipment  { equipmentId, active? } */
export const activateEquipment = handler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.body.equipmentId)) throw err(400, 'Invalid machine');
  const r = await setEquipmentStatus(req.user.id, { _id: req.body.equipmentId }, req.body.active === false ? 'idle' : 'active');
  if (!r.matchedCount) throw err(404, 'Machine not found');
  res.json({ success: true, message: req.body.active === false ? 'Machine paused' : 'Machine activated' });
});

/** POST /api/mining/activate-all-equipment */
export const activateAllEquipment = handler(async (req, res) => {
  const r = await setEquipmentStatus(req.user.id, { status: { $ne: 'maintenance' } }, 'active');
  res.json({ success: true, message: `${r.modifiedCount} machine(s) activated` });
});

/** GET /api/mining/rewards?status=pending|claimed */
export const getRewards = handler(async (req, res) => {
  const status = req.query.status === 'claimed' ? 'claimed' : 'pending';
  const rewards = await MiningReward.find({ userId: req.user.id, status }).sort({ createdAt: -1 }).limit(Math.min(100, parseInt(req.query.limit, 10) || 20));
  res.json({
    success: true,
    rewards: rewards.map((r) => ({ id: r._id, coin: r.coin, amount: r.amount, value: r.value, currency: r.metadata?.currency, status: r.status, sessionId: r.sessionId, createdAt: r.createdAt, claimedAt: r.claimedAt }))
  });
});

/** POST /api/mining/claim-rewards — claims every pending reward exactly once */
export const claimRewards = handler(async (req, res) => {
  const claimId = uuidv4();
  const total = await withTransaction(async (s) => {
    const marked = await MiningReward.updateMany(
      { userId: req.user.id, status: 'pending' },
      { $set: { status: 'claimed', claimedAt: new Date(), 'metadata.claimId': claimId } },
      { session: s }
    );
    if (!marked.modifiedCount) throw err(400, 'No rewards to claim yet');
    const claimed = await MiningReward.find({ userId: req.user.id, 'metadata.claimId': claimId }).session(s).lean();
    // Rewards are stored in the currency the session ran in; convert each into today's account currency.
    const holder = await User.findById(req.user.id).select('currency').session(s).lean();
    let sum = 0;
    for (const r of claimed) {
      // eslint-disable-next-line no-await-in-loop
      sum += (r.value || 0) * (await rateBetween(r.metadata?.currency || holder.currency, holder.currency));
    }
    sum = round2(sum);
    if (sum > 0) {
      await creditUser(req.user.id, sum, { session: s });
      await recordTransaction({ userId: req.user.id, amount: sum, currency: holder.currency, type: 'mining', metadata: { action: 'claim_rewards', count: claimed.length, claimId }, session: s, prefix: 'MIN' });
    }
    return { sum, count: claimed.length };
  });
  res.json({ success: true, message: `${total.sum} added to your balance`, amount: total.sum, count: total.count });
});

/** GET /api/mining/boosters */
export const getBoosters = handler(async (req, res) => {
  const now = new Date();
  const boosters = await MiningBooster.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(50);
  const present = (b) => ({
    id: b._id, name: b.name, type: b.type, multiplier: b.multiplier, duration: b.duration, price: b.price,
    status: b.expiresAt > now ? 'active' : 'expired', activatedAt: b.activatedAt, expiresAt: b.expiresAt, createdAt: b.createdAt
  });
  res.json({ success: true, boosters: boosters.map(present), activeBoosters: boosters.filter((b) => b.expiresAt > now).map(present) });
});

/** POST /api/mining/activate-booster  { boosterId } */
export const activateBooster = handler(async (req, res) => {
  const tpl = (await loadCatalog()).boosters[req.body.boosterId];
  if (!tpl) throw err(404, 'Booster not found');
  const user = await loadActiveUser(req.user.id);
  const { amount: price } = await convertFromBase(tpl.price, user.currency);
  const now = new Date();
  const booster = await withTransaction(async (s) => {
    if (await MiningBooster.exists({ userId: user._id, type: tpl.type, expiresAt: { $gt: now } }).session(s)) {
      throw err(400, `${tpl.name} is already running`);
    }
    await debitUser(user._id, price, { session: s });
    const [b] = await MiningBooster.create([{
      userId: user._id, name: tpl.name, type: tpl.type, multiplier: tpl.multiplier, duration: tpl.duration, price,
      status: 'active', activatedAt: now, expiresAt: new Date(now.getTime() + tpl.duration * 1000), metadata: { currency: user.currency }
    }], { session: s });
    await recordTransaction({ userId: user._id, amount: price, currency: user.currency, type: 'mining', metadata: { action: 'booster', booster: tpl.name, boosterId: b._id }, session: s, prefix: 'MIN' });
    return b;
  });
  res.json({ success: true, message: `${tpl.name} active until ${booster.expiresAt.toLocaleTimeString()}`, booster: { id: booster._id, name: booster.name, expiresAt: booster.expiresAt } });
});

/** GET /api/mining/history */
export const getMiningHistory = handler(async (req, res) => {
  const sessions = await MiningSession.find({ userId: req.user.id }).sort({ startedAt: -1 }).limit(Math.min(50, parseInt(req.query.limit, 10) || 10)).populate('poolId', 'name fee');
  res.json({
    success: true,
    history: sessions.map((s) => ({
      id: s._id, startedAt: s.startedAt, endedAt: s.endedAt, duration: s.duration, status: s.status,
      hashRate: s.hashRate, earnings: s.earnings, currency: s.metadata?.currency, pool: s.poolId?.name || 'Unknown', equipmentCount: s.equipment?.length || 0
    }))
  });
});

/** GET /api/mining/pools */
export const getPools = handler(async (req, res) => {
  await ensureDefaultPools();
  const user = await User.findById(req.user.id).select('mining.defaultPool').lean();
  const pools = await MiningPool.find({ status: 'active' }).sort({ fee: 1 });
  res.json({
    success: true,
    pools: pools.map((p) => ({
      id: p._id, name: p.name, fee: p.fee, minPayout: p.minPayout, miners: p.miners, uptime: p.uptime,
      algorithm: p.algorithm, coin: p.supportedCoins?.[0] || 'BTC', url: p.url, location: p.location, status: p.status,
      isDefault: String(user?.mining?.defaultPool || '') === String(p._id)
    }))
  });
});

/** POST /api/mining/switch-pool  { poolId } — applies to your next session */
export const switchPool = handler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.body.poolId)) throw err(400, 'Invalid pool');
  const pool = await MiningPool.findOne({ _id: req.body.poolId, status: 'active' });
  if (!pool) throw err(404, 'Pool not found');
  await User.updateOne({ _id: req.user.id }, { $set: { 'mining.defaultPool': pool._id } });
  const mining = await MiningSession.exists({ userId: req.user.id, status: 'active' });
  res.json({ success: true, message: mining ? `${pool.name} will be used from your next session` : `${pool.name} selected` });
});
