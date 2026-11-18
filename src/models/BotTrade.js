import mongoose from 'mongoose';

/** One trade an AI Smart Trader placed for a user. */
const botTradeSchema = new mongoose.Schema({
  subscription: { type: mongoose.Schema.Types.ObjectId, ref: 'BotSubscription', required: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  number: { type: Number, required: true },  // 1..tradeLimit
  market: { type: String, required: true },   // e.g. BTC/USDT
  side: { type: String, enum: ['long', 'short'], required: true },
  entryPrice: Number,
  exitPrice: Number,
  result: { type: String, enum: ['win', 'loss'], required: true },
  pnlPercent: Number,
  pnl: { type: Number, required: true },     // in `currency`
  currency: String,
  openedAt: Date,
  closedAt: Date
}, { timestamps: true });

botTradeSchema.index({ subscription: 1, number: 1 }, { unique: true });

export default mongoose.model('BotTrade', botTradeSchema);
