import mongoose from 'mongoose';

export const CYCLE_DAYS = { daily: 1, weekly: 7, monthly: 30 };

/**
 * A staking pool for one crypto asset (e.g. AVAX · Avalanche).
 * minAmount / maxAmount / capacity are in units of the asset.
 */
const stakingPlanSchema = new mongoose.Schema({
  asset: { type: String, required: true, uppercase: true, trim: true, maxlength: 12 },   // AVAX
  name: { type: String, required: true, trim: true, maxlength: 80 },                     // Avalanche
  icon: { type: String, trim: true, default: '' },
  apy: { type: Number, required: true, min: 0, max: 1000 },                              // yearly %, paid per cycle
  cycle: { type: String, enum: Object.keys(CYCLE_DAYS), default: 'daily' },              // how often rewards are earned
  lockDays: { type: Number, min: 0, max: 3650, default: 0 },                             // 0 = flexible
  minAmount: { type: Number, required: true, min: 0 },
  maxAmount: { type: Number, required: true, min: 0 },
  price: { type: Number, min: 0, default: 0 },          // fallback USD price when no live price exists
  allowEarlyUnstake: { type: Boolean, default: true },
  earlyUnstakePenaltyPercent: { type: Number, default: 10, min: 0, max: 100 },
  capacity: { type: Number, default: 0, min: 0 },       // 0 = unlimited (asset units)
  totalStaked: { type: Number, default: 0, min: 0 },    // asset units
  description: { type: String, trim: true, maxlength: 1000, default: '' },
  sortOrder: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true, index: true }
}, { timestamps: true });

export const StakingPlan = mongoose.model('StakingPlan', stakingPlanSchema);

/** A user's stake. Rewards are earned in the asset for each completed cycle. */
const stakePositionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  plan: { type: mongoose.Schema.Types.ObjectId, ref: 'StakingPlan', required: true },
  asset: { type: String, required: true },
  assetName: { type: String, default: '' },
  assetAmount: { type: Number, required: true, min: 0 },   // units staked
  priceAtStake: { type: Number, required: true, min: 0 },  // USD per unit
  amount: { type: Number, required: true, min: 0 },        // what the user paid, user currency
  currency: { type: String, uppercase: true, required: true },
  apy: { type: Number, required: true },
  cycle: { type: String, enum: Object.keys(CYCLE_DAYS), default: 'daily' },
  lockDays: { type: Number, required: true },
  startAt: { type: Date, default: Date.now },
  endAt: { type: Date, default: null },
  claimedRewards: { type: Number, default: 0, min: 0 },    // asset units already paid out
  claimedValue: { type: Number, default: 0, min: 0 },      // user currency paid out for rewards
  lastClaimAt: { type: Date, default: null },
  status: { type: String, enum: ['active', 'completed', 'cancelled'], default: 'active', index: true },
  closedAt: { type: Date },
  payout: { type: Number, default: 0 },                    // user currency returned on unstake
  penalty: { type: Number, default: 0 }                    // asset units withheld on early exit
}, { timestamps: true });

export const StakePosition = mongoose.model('StakePosition', stakePositionSchema);
