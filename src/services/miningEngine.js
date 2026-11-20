// Mining economics in one place.
//   Each machine earns `dailyYieldPercent` of its price per day while a session runs.
//   Boosters multiply earnings during the time they overlap the session.
//   The pool fee is deducted. Sessions run for at most MAX_SESSION_HOURS, then stop on their own.
// All values are kept in the user's currency (prices below are in the platform base currency).
import MiningPool from '../models/MiningPool.js';
import Setting from '../models/Setting.js';
import MiningSession from '../models/MiningSession.js';
import MiningBooster from '../models/MiningBooster.js';
import MiningReward from '../models/MiningReward.js';
import MiningEquipment from '../models/MiningEquipment.js';
import User from '../models/User.js';
import { round2, round8 } from '../utils/money.js';
import { convertFromBase } from '../utils/wallet.js';
import { rateBetween } from './fx.js';
import { getUsdPrice, usdToCurrency } from './priceService.js';
import { notifyUser } from './notificationService.js';

export const MAX_SESSION_HOURS = 24;

export const EQUIPMENT_CATALOG = {
  cpu_1: { name: 'Cloud CPU Node', type: 'CPU', hashRate: 5, powerConsumption: 65, efficiency: 13, price: 99, dailyYieldPercent: 0.2 },
  gpu_2: { name: 'NVIDIA RTX 4080', type: 'GPU', hashRate: 85, powerConsumption: 320, efficiency: 3.76, price: 1199, dailyYieldPercent: 0.28 },
  gpu_1: { name: 'NVIDIA RTX 4090', type: 'GPU', hashRate: 120, powerConsumption: 450, efficiency: 3.75, price: 1599, dailyYieldPercent: 0.3 },
  asic_1: { name: 'Bitmain Antminer S19', type: 'ASIC', hashRate: 110, powerConsumption: 3250, efficiency: 29.5, price: 2899, dailyYieldPercent: 0.35 }
};

export const BOOSTER_CATALOG = {
  hash_boost: { name: 'Hash Rate Boost', type: 'hash_rate', multiplier: 1.5, duration: 3600, price: 10, description: '+50% earnings for 1 hour' },
  energy_saver: { name: 'Energy Saver', type: 'energy', multiplier: 1.1, duration: 7200, price: 15, description: '+10% net earnings for 2 hours' },
  double_rewards: { name: 'Double Rewards', type: 'rewards', multiplier: 2, duration: 1800, price: 25, description: '2× earnings for 30 minutes' }
};

/**
 * The shop the admin manages (Settings.miningCatalog), on top of the starter items above:
 *   { equipment: { gpu_1: { price, dailyYieldPercent, name, ... , enabled, deleted }, custom_ab12: { custom: true, ...full item } },
 *     boosters:  { hash_boost: { price, multiplier, ... }, ... } }
 * Starter items can be edited, hidden (enabled: false) or removed (deleted: true).
 * Items the admin adds are stored whole with custom: true.
 * Hidden or removed items leave the shop, but machines users already own keep earning.
 */
let catalogCache = null;
export const invalidateCatalog = () => { catalogCache = null; };
const REQUIRED = {
  equipment: ['name', 'type', 'hashRate', 'powerConsumption', 'price', 'dailyYieldPercent'],
  boosters: ['name', 'type', 'multiplier', 'duration', 'price']
};
export const getCatalog = async ({ includeDisabled = false } = {}) => {
  if (!catalogCache || Date.now() - catalogCache.at > 30e3) {
    const s = await Setting.findOne().select('miningCatalog').lean();
    const o = s?.miningCatalog || {};
    const merge = (kind, base, over = {}) => {
      const out = {};
      for (const [id, t] of Object.entries(base)) out[id] = { ...t, enabled: true, ...(over[id] || {}) };
      for (const [id, t] of Object.entries(over)) {
        if (base[id] || !t?.custom) continue;
        if (REQUIRED[kind].every((k) => t[k] !== undefined && t[k] !== '')) out[id] = { enabled: true, ...t };
      }
      for (const [id, t] of Object.entries(out)) {
        if (t.deleted) delete out[id];
        else if (kind === 'equipment' && !t.efficiency && t.hashRate > 0) t.efficiency = round2(t.powerConsumption / t.hashRate);
      }
      return out;
    };
    catalogCache = { at: Date.now(), equipment: merge('equipment', EQUIPMENT_CATALOG, o.equipment), boosters: merge('boosters', BOOSTER_CATALOG, o.boosters) };
  }
  const pick = (m) => (includeDisabled ? m : Object.fromEntries(Object.entries(m).filter(([, t]) => t.enabled !== false)));
  return { equipment: pick(catalogCache.equipment), boosters: pick(catalogCache.boosters) };
};

const DEFAULT_POOLS = [
  { name: 'Atlas BTC Pool', url: 'stratum+tcp://btc.atlaspool.example:3333', fee: 1.5, minPayout: 0.001, algorithm: 'SHA-256', supportedCoins: ['BTC'], paymentMethod: 'PPS', location: { city: 'Global' }, status: 'active' },
  { name: 'Nova ETC Pool', url: 'stratum+tcp://etc.novapool.example:4444', fee: 1, minPayout: 0.05, algorithm: 'Ethash', supportedCoins: ['ETC'], paymentMethod: 'PPLNS', location: { country: 'EU' }, status: 'active' },
  { name: 'Lumen LTC Pool', url: 'stratum+tcp://ltc.lumenpool.example:3333', fee: 2, minPayout: 0.01, algorithm: 'Scrypt', supportedCoins: ['LTC'], paymentMethod: 'PPS', location: { country: 'US' }, status: 'active' }
];

/**
 * Starter pools are added once, on a brand-new platform. After that the admin owns
 * the list: pools they delete stay deleted, even if they delete them all.
 */
let poolsSeeded = false;
export const ensureDefaultPools = async () => {
  if (poolsSeeded) return;
  const s = await Setting.findOne().select('miningCatalog.poolsSeeded').lean();
  if (!s?.miningCatalog?.poolsSeeded) {
    if (!(await MiningPool.exists({}))) await MiningPool.insertMany(DEFAULT_POOLS);
    await Setting.updateOne({}, { $set: { 'miningCatalog.poolsSeeded': true } }, { upsert: true });
  }
  poolsSeeded = true;
};

/** Daily earnings of one machine in the user's currency. */
export const machineDailyYield = async (eq, currency) => {
  // A machine keeps the yield it was bought with, whatever the admin later changes in the shop.
  if (eq.metadata?.dailyYield) {
    if (!eq.metadata.currency || eq.metadata.currency === currency) return eq.metadata.dailyYield;
    return round2(eq.metadata.dailyYield * (await rateBetween(eq.metadata.currency, currency)));
  }
  const { equipment: cat } = await getCatalog({ includeDisabled: true });
  const tpl = cat[eq.metadata?.catalogId] || Object.values(cat).find((t) => t.name === eq.name);
  const pct = tpl?.dailyYieldPercent ?? 0.3;
  if (eq.metadata?.priceLocal) return round2(eq.metadata.priceLocal * (pct / 100));
  const { amount } = await convertFromBase(eq.purchasePrice || tpl?.price || 0, currency);
  return round2(amount * (pct / 100));
};

/** Earnings (user currency) for a session over [start, until], including boosters and pool fee. */
export const sessionEarnings = async (session, until = new Date()) => {
  const start = new Date(session.startedAt).getTime();
  const end = Math.min(until.getTime(), new Date(session.metadata?.endsAt || start + MAX_SESSION_HOURS * 3600e3).getTime());
  const seconds = Math.max(0, (end - start) / 1000);
  const perSecond = (session.metadata?.dailyYield || 0) / 86400;
  let earned = perSecond * seconds;

  const boosters = await MiningBooster.find({
    userId: session.userId,
    activatedAt: { $lt: new Date(end) },
    expiresAt: { $gt: new Date(start) }
  }).lean();
  for (const b of boosters) {
    const from = Math.max(start, new Date(b.activatedAt).getTime());
    const to = Math.min(end, new Date(b.expiresAt).getTime());
    if (to > from) earned += perSecond * ((to - from) / 1000) * Math.max(0, (b.multiplier || 1) - 1);
  }
  const fee = (session.metadata?.poolFee || 0) / 100;
  // Rate right now (boosters running at `until`), for live counters between refreshes.
  const at = until.getTime();
  const boostNow = end >= at ? boosters
    .filter((b) => new Date(b.activatedAt).getTime() <= at && new Date(b.expiresAt).getTime() > at)
    .reduce((m, b) => m + Math.max(0, (b.multiplier || 1) - 1), 0) : -1;
  const ratePerSecond = boostNow < 0 ? 0 : perSecond * (1 + boostNow) * (1 - fee);
  return { gross: round2(earned), net: round2(earned * (1 - fee)), netExact: Math.round(earned * (1 - fee) * 1e6) / 1e6, ratePerSecond, seconds };
};

/** Finish a session: record its reward (pending until claimed). Safe to call twice. */
export const finishSession = async (sessionId, reason = 'stopped') => {
  const session = await MiningSession.findOneAndUpdate({ _id: sessionId, status: 'active' }, { $set: { status: 'completed' } }, { new: true });
  if (!session) return null;
  const endedAt = new Date(Math.min(Date.now(), new Date(session.metadata?.endsAt || Date.now()).getTime()));
  const { net, seconds } = await sessionEarnings(session, endedAt);
  const coin = session.metadata?.coin || 'BTC';
  const currency = session.metadata?.currency || 'USD';
  const coinUsd = await getUsdPrice(coin, null);
  const fx = await usdToCurrency(1, currency);
  const coinAmount = coinUsd ? round8(net / (coinUsd * fx.rate)) : 0;

  session.endedAt = endedAt;
  session.duration = Math.round(seconds);
  session.earnings = net;
  session.rewards = [{ coin, amount: coinAmount, value: net }];
  session.metadata = { ...(session.metadata || {}), stopReason: reason };
  await session.save();
  await MiningEquipment.updateMany({ userId: session.userId, miningSessionId: session._id }, { $set: { miningSessionId: null }, $inc: { totalRuntime: Math.round(seconds) } });

  let reward = null;
  if (net > 0) {
    reward = await MiningReward.create({
      userId: session.userId, sessionId: session._id, poolId: session.poolId, coin, amount: coinAmount, value: net,
      status: 'pending', metadata: { currency }
    });
  }
  if (reason === 'auto') {
    await notifyUser(session.userId, {
      type: 'system',
      title: 'Mining session finished',
      content: `Your ${MAX_SESSION_HOURS}-hour session earned ${net} ${currency}. Claim it and start a new session to keep mining.`,
      link: '/mining',
      dedupeKey: `mining-session:${session._id}`
    });
  }
  return { session, reward };
};

/** Auto-stop sessions that reached their maximum length. */
export const finishExpiredSessions = async () => {
  const due = await MiningSession.find({ status: 'active', 'metadata.endsAt': { $lte: new Date() } }).select('_id').lean();
  for (const s of due) {
    // eslint-disable-next-line no-await-in-loop
    await finishSession(s._id, 'auto').catch((err) => console.error('Mining auto-stop failed:', err.message));
  }
  // Sessions from the old code have no end time: cap them at MAX_SESSION_HOURS from their start.
  const legacy = await MiningSession.find({ status: 'active', 'metadata.endsAt': { $exists: false } }).select('_id startedAt').lean();
  for (const s of legacy) {
    // eslint-disable-next-line no-await-in-loop
    await MiningSession.updateOne({ _id: s._id }, { $set: { 'metadata.endsAt': new Date(new Date(s.startedAt).getTime() + MAX_SESSION_HOURS * 3600e3), 'metadata.legacy': true } });
  }
  return due.length;
};

export const startMiningJob = () => {
  const tick = () => finishExpiredSessions().catch((err) => console.error('Mining job:', err.message));
  setTimeout(tick, 4000);
  return setInterval(tick, 60 * 1000);
};

export const userCurrency = async (userId) => (await User.findById(userId).select('currency').lean())?.currency || 'USD';
