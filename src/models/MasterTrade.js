import mongoose from 'mongoose';

/**
 * A trade placed by a Trader. When opened, it is mirrored into every active
 * copy of that trader; when closed, every copied position settles at the same
 * exit price.
 */
const masterTradeSchema = new mongoose.Schema({
  trader: { type: mongoose.Schema.Types.ObjectId, ref: 'Trader', required: true, index: true },
  traderId: { type: String, required: true, index: true },
  symbol: { type: String, required: true, uppercase: true, trim: true, maxlength: 20 },
  side: { type: String, enum: ['buy', 'sell'], required: true },
  entryPrice: { type: Number, required: true, min: 0 },
  markPrice: { type: Number, min: 0 },         // latest price, for unrealised P/L
  markUpdatedAt: { type: Date },
  exitPrice: { type: Number, min: 0 },
  // Share of each copier's copy equity committed to this trade, in %.
  allocationPercent: { type: Number, required: true, min: 0.1, max: 100, default: 10 },
  leverage: { type: Number, min: 1, max: 100, default: 1 },
  status: { type: String, enum: ['open', 'closed', 'cancelled'], default: 'open', index: true },
  source: { type: String, enum: ['manual', 'auto'], default: 'manual' },   // placed by the admin or by the autopilot
  closeReason: { type: String, default: '' },                                 // e.g. take_profit, stop_loss, max_hold, signal, manual
  pnlPercent: { type: Number, default: 0 },    // on margin (leveraged), set at close
  copiedCount: { type: Number, default: 0 },
  notes: { type: String, trim: true, maxlength: 500, default: '' },
  openedAt: { type: Date, default: Date.now },
  closedAt: { type: Date }
}, { timestamps: true });

masterTradeSchema.index({ traderId: 1, status: 1, closedAt: 1 });

export default mongoose.model('MasterTrade', masterTradeSchema);
