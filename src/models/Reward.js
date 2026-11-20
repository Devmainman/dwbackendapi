import mongoose from 'mongoose';

/**
 * Trader Rewards. The admin creates milestones (required profit -> reward); users
 * whose trading profit reaches a milestone claim it, pay the claim fee (if any)
 * through the normal payment methods, and the admin approves the reward invoice,
 * which credits the reward to the user's balance. Amounts are in the platform base
 * currency and converted for each user.
 */
const milestoneSchema = new mongoose.Schema({
  name: { type: String, trim: true, required: true, maxlength: 80 },
  requiredProfit: { type: Number, required: true, min: 0 },
  rewardAmount: { type: Number, required: true, min: 0 },
  claimFee: { type: Number, default: 0, min: 0 },
  prize: { type: String, trim: true, maxlength: 300, default: '' },     // optional extra prize details
  description: { type: String, trim: true, maxlength: 300, default: '' },
  status: { type: String, enum: ['active', 'hidden'], default: 'active', index: true },
  sortOrder: { type: Number, default: 0 }
}, { timestamps: true });

/*
 * Claim stages:
 *   fee_unpaid -> user must pay the claim fee
 *   review     -> reward invoice waiting for the admin (fee paid, or no fee)
 *   approved   -> reward credited to the balance
 *   rejected   -> closed by the admin (the user may claim again)
 * A rejected fee payment (not the whole claim) sends the claim back to fee_unpaid.
 */
export const CLAIM_STAGES = ['fee_unpaid', 'review', 'approved', 'rejected'];

const paymentSchema = new mongoose.Schema({
  status: { type: String, enum: ['unpaid', 'pending', 'approved', 'rejected', 'not_required'], default: 'unpaid' },
  amount: Number,           // user currency
  currency: String,
  baseAmount: Number,       // base currency
  paymentMethod: { type: String, default: '' },
  proof: { type: String, default: '' },
  reference: { type: String, default: '' },
  transaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
  submittedAt: Date,
  note: { type: String, default: '' },
  attempts: { type: Number, default: 0 }
}, { _id: false });

const claimSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  milestone: { type: mongoose.Schema.Types.ObjectId, ref: 'RewardMilestone', required: true },
  snapshot: {
    name: String, requiredProfit: Number, rewardAmount: Number, claimFee: Number, prize: String, baseCurrency: String
  },
  profitAtClaim: { type: Number, default: 0 },   // base currency
  stage: { type: String, enum: CLAIM_STAGES, default: 'review', index: true },
  // true while the claim counts as the user's claim for this milestone (only one at a time)
  active: { type: Boolean, default: true },
  invoiceNumber: { type: String, default: '' },
  payment: { type: paymentSchema, default: () => ({}) },
  reward: {
    amount: Number, currency: String, creditedAt: Date,
    transaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' }
  },
  reviewedAt: Date,
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  note: { type: String, trim: true, maxlength: 500, default: '' }
}, { timestamps: true });

claimSchema.index({ user: 1, milestone: 1 }, { unique: true, partialFilterExpression: { active: true } });
claimSchema.index({ stage: 1, updatedAt: -1 });

export const RewardMilestone = mongoose.model('RewardMilestone', milestoneSchema);
export const RewardClaim = mongoose.model('RewardClaim', claimSchema);
