import mongoose from 'mongoose';

/**
 * A live-market position. `margin` is taken from the user's balance; exposure is
 * margin × leverage. Profit/loss follows the server's market price and can never
 * exceed a loss of the margin (positions are closed at liquidation).
 */
const marketPositionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  symbol: { type: String, required: true },        // "BTC/USDT"
  base: { type: String, required: true },
  quote: { type: String, required: true },
  kind: { type: String, enum: ['crypto', 'forex'], required: true },
  side: { type: String, enum: ['long', 'short'], required: true },
  margin: { type: Number, required: true, min: 0 }, // user currency
  currency: { type: String, uppercase: true, required: true },
  leverage: { type: Number, min: 1, max: 100, default: 1 },
  entryPrice: { type: Number, required: true },
  quantity: { type: Number, required: true },       // units of base (exposure / entryPrice, in quote terms)
  takeProfit: { type: Number, default: null },
  stopLoss: { type: Number, default: null },
  liquidationPrice: { type: Number, required: true },
  status: { type: String, enum: ['open', 'closing', 'closed'], default: 'open' },
  exitPrice: { type: Number },
  pnl: { type: Number, default: 0 },
  pnlPercent: { type: Number, default: 0 },
  payout: { type: Number, default: 0 },
  closeReason: { type: String, enum: ['manual', 'take_profit', 'stop_loss', 'liquidated', 'admin', null], default: null },
  openedAt: { type: Date, default: Date.now },
  closedAt: { type: Date }
}, { timestamps: true });

marketPositionSchema.index({ user: 1, status: 1, openedAt: -1 });
marketPositionSchema.index({ status: 1 });

export default mongoose.model('MarketPosition', marketPositionSchema);
