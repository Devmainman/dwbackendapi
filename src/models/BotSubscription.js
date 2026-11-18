import mongoose from 'mongoose';

/**
 * A user's subscription to an AI Smart Trader bot (shown in admin Bot Invoices).
 * status: awaiting_payment -> pending (payment in review) -> active -> completed
 *         (or rejected / stopped / cancelled)
 * `tradesUsed` counts trades placed; the bot stops when it reaches `tradeLimit`.
 */
export const OPEN_SUB_STATUSES = ['awaiting_payment', 'pending', 'active'];

const botSubscriptionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  bot: { type: mongoose.Schema.Types.ObjectId, ref: 'SmartBot', required: true },
  botSnapshot: {
    name: String, strategy: String, tradeLimit: Number, tradeIntervalMinutes: Number,
    winRate: Number, profitMin: Number, profitMax: Number, lossMin: Number, lossMax: Number, markets: [String],
    price: Number, baseCurrency: String
  },
  status: { type: String, enum: ['awaiting_payment', 'pending', 'active', 'completed', 'rejected', 'stopped', 'cancelled'], default: 'awaiting_payment', index: true },
  allocation: { type: Number, required: true, min: 0 }, // capital the bot trades with, in `currency`
  currency: { type: String, uppercase: true, required: true },
  tradeLimit: { type: Number, required: true, min: 1 },
  tradesUsed: { type: Number, default: 0, min: 0 },
  wins: { type: Number, default: 0 },
  losses: { type: Number, default: 0 },
  totalPnl: { type: Number, default: 0 },
  nextTradeAt: { type: Date, index: true },
  startedAt: Date,
  completedAt: Date,
  payment: {
    status: { type: String, enum: ['unpaid', 'pending', 'approved', 'rejected'], default: 'unpaid' },
    amount: Number,
    currency: String,
    paymentMethod: { type: String, default: '' },
    proof: { type: String, default: '' },
    reference: { type: String, default: '' },
    transaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
    submittedAt: Date,
    reviewedAt: Date,
    note: { type: String, default: '' }
  }
}, { timestamps: true });

botSubscriptionSchema.index({ status: 1, nextTradeAt: 1 });

export default mongoose.model('BotSubscription', botSubscriptionSchema);
