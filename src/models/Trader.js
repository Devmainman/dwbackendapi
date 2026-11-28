import mongoose from 'mongoose';

/**
 * A strategy provider that users can copy. Performance figures are COMPUTED
 * from the trader's closed MasterTrades by the copy-trading engine; they are
 * not meant to be edited by hand.
 */
const traderSchema = new mongoose.Schema({
  traderId: { type: String, required: true, unique: true },
  username: { type: String, required: true, unique: true, trim: true, maxlength: 40 },
  fullName: { type: String, trim: true, maxlength: 80, default: '' },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  avatar: { type: String, default: '' },
  bio: { type: String, trim: true, maxlength: 1000, default: '' },
  country: { type: String, trim: true, maxlength: 60, default: '' },
  tradingExperience: {
    type: String,
    enum: ['beginner', 'intermediate', 'advanced', 'expert'],
    default: 'intermediate'
  },
  tradingStyle: {
    type: [String],
    enum: ['scalping', 'day', 'swing', 'position', 'arbitrage', 'algorithmic'],
    default: ['day']
  },
  markets: {
    type: [String],
    enum: ['crypto', 'forex', 'stocks', 'commodities', 'indices'],
    default: ['crypto']
  },
  verified: { type: Boolean, default: false },
  verificationLevel: {
    type: String,
    enum: ['unverified', 'basic', 'advanced', 'pro'],
    default: 'unverified'
  },

  // Computed by services/copyTradingEngine.js -> recomputeTraderStats()
  performance: {
    roi: { type: Number, default: 0 },              // % compounded return of the strategy
    winRate: { type: Number, default: 0 },          // % of closed trades in profit
    totalTrades: { type: Number, default: 0 },
    successfulTrades: { type: Number, default: 0 },
    maxDrawdown: { type: Number, default: 0 },      // % peak-to-trough on the equity curve
    monthlyProfit: { type: Number, default: 0 },    // % return over the last 30 days
    weeklyProfit: { type: Number, default: 0 },     // % return over the last 7 days
    dailyProfit: { type: Number, default: 0 },      // % return over the last 24 hours
    netProfit: { type: Number, default: 0 },        // realised profit paid to copiers (sum, base units)
    averageHoldHours: { type: Number, default: 0 },
    equityCurve: [{ _id: false, at: Date, value: Number }], // starts at 100
    lastTradeAt: { type: Date, default: null }
  },

  riskMetrics: {
    riskLevel: { type: String, enum: ['low', 'medium', 'high', 'very_high'], default: 'medium' }
  },

  socialStats: {
    activeCopiers: { type: Number, default: 0 },
    totalCopiers: { type: Number, default: 0 },
    totalCopiedAmount: { type: Number, default: 0 },
    followers: { type: Number, default: 0, min: 0 },      // shown total = baseFollowers + real follows
    baseFollowers: { type: Number, default: 0, min: 0 },  // starting audience, at least MIN_FOLLOWERS
    rating: { type: Number, default: 0, min: 0, max: 5 }
  },

  settings: {
    allowCopying: { type: Boolean, default: true },
    // Amount a user must allocate (at least) to copy this trader. Platform base currency; required for every trader.
    minCopyAmount: { type: Number, default: 50, min: 1, required: true },
    maxCopiers: { type: Number, default: 0, min: 0 },       // 0 = unlimited
    commissionRate: { type: Number, default: 10, min: 0, max: 50 } // % of each profitable trade
  },

  // Autopilot (services/traderAutopilot.js): trades this trader automatically from live
  // market data. Entries come from EMA/RSI signals on Binance candles, fills and exits
  // use the live price; every trade is copied to the trader's copiers like a manual one.
  autoTrading: {
    enabled: { type: Boolean, default: false },
    symbols: { type: [String], default: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'] },
    strategy: { type: String, enum: ['trend', 'reversal'], default: 'trend' },
    timeframe: { type: String, enum: ['5m', '15m', '1h', '4h'], default: '15m' },
    allocationPercent: { type: Number, default: 10, min: 0.1, max: 100 },
    leverage: { type: Number, default: 1, min: 1, max: 20 },
    takeProfitPercent: { type: Number, default: 2, min: 0.1, max: 100 },   // price move in the trade's favour
    stopLossPercent: { type: Number, default: 1, min: 0.1, max: 100 },     // price move against the trade
    maxHoldHours: { type: Number, default: 24, min: 0.25, max: 720 },
    maxOpenTrades: { type: Number, default: 2, min: 1, max: 20 },
    cooldownMinutes: { type: Number, default: 30, min: 0, max: 10080 },  // wait after closing a symbol before re-entering it
    state: { type: String, enum: ['off', 'scanning', 'in_trade', 'error'], default: 'off' },
    nextRunAt: { type: Date, default: null },
    lastRunAt: { type: Date, default: null },
    lastError: { type: String, default: '' },
    log: [{ _id: false, at: Date, text: String }]
  },

  lastActive: { type: Date, default: Date.now },
  joinedDate: { type: Date, default: Date.now },
  isActive: { type: Boolean, default: true },
  metadata: { type: Object, default: {} }
}, {
  timestamps: true,
  toJSON: {
    virtuals: true,
    transform(doc, ret) {
      delete ret.__v;
      ret.id = ret._id;
      delete ret._id;
      return ret;
    }
  }
});

/**
 * Verification badge shown to users:
 *   gold = verified at the "pro" level (elite traders), blue = verified, none = unverified.
 */
export const traderBadge = (t) => {
  if (!t?.verified) return 'none';
  return t.verificationLevel === 'pro' ? 'gold' : 'blue';
};
traderSchema.virtual('badge').get(function badge() { return traderBadge(this); });

traderSchema.index({ 'performance.roi': -1 });
traderSchema.index({ 'performance.winRate': -1 });
traderSchema.index({ 'socialStats.activeCopiers': -1 });
traderSchema.index({ isActive: 1, verified: 1 });

// Every trader shows at least 1.7k followers: each gets a starting audience between
// MIN_FOLLOWERS and MAX_START_FOLLOWERS, and real follows are added on top.
export const MIN_FOLLOWERS = 1700;
const MAX_START_FOLLOWERS = 4800;
export const startFollowers = () => MIN_FOLLOWERS + Math.floor(Math.random() * (MAX_START_FOLLOWERS - MIN_FOLLOWERS + 1));

traderSchema.pre('save', function setStartFollowers(next) {
  if (!this.socialStats) this.socialStats = {};
  if ((this.socialStats.baseFollowers || 0) < MIN_FOLLOWERS) {
    const old = this.socialStats.baseFollowers || 0;
    const base = startFollowers();
    this.socialStats.baseFollowers = base;
    this.socialStats.followers = base + Math.max(0, (this.socialStats.followers || 0) - old);
  }
  next();
});

const Trader = mongoose.model('Trader', traderSchema);

/** Gives traders created before the floor existed (or inserted without save hooks) their starting audience. Runs once per process. */
let floorDone = null;
export function ensureFollowerFloor() {
  if (!floorDone) {
    floorDone = (async () => {
      const low = await Trader.find({ $or: [{ 'socialStats.baseFollowers': { $exists: false } }, { 'socialStats.baseFollowers': { $lt: MIN_FOLLOWERS } }] })
        .select('traderId socialStats.baseFollowers').lean();
      if (!low.length) return;
      const { default: TraderFollow } = await import('./TraderFollow.js');
      await Trader.bulkWrite(await Promise.all(low.map(async (t) => {
        const base = startFollowers();
        const real = await TraderFollow.countDocuments({ traderId: t.traderId });
        return { updateOne: { filter: { _id: t._id }, update: { $set: { 'socialStats.baseFollowers': base, 'socialStats.followers': base + real } } } };
      })));
    })().catch((e) => { floorDone = null; console.error('ensureFollowerFloor failed', e.message); });
  }
  return floorDone;
}
export default Trader;
