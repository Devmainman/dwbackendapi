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
    followers: { type: Number, default: 0, min: 0 },
    rating: { type: Number, default: 0, min: 0, max: 5 }
  },

  settings: {
    allowCopying: { type: Boolean, default: true },
    // Amount a user must allocate (at least) to copy this trader. Platform base currency; required for every trader.
    minCopyAmount: { type: Number, default: 50, min: 1, required: true },
    maxCopiers: { type: Number, default: 0, min: 0 },       // 0 = unlimited
    commissionRate: { type: Number, default: 10, min: 0, max: 50 } // % of each profitable trade
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

const Trader = mongoose.model('Trader', traderSchema);
export default Trader;
