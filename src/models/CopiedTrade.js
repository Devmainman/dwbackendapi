import mongoose from 'mongoose';

/** A copier's position mirroring one MasterTrade. */
const copiedTradeSchema = new mongoose.Schema({
  copyTradeId: { type: mongoose.Schema.Types.ObjectId, ref: 'CopyTrade', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  traderId: { type: String, required: true, index: true },
  traderUsername: { type: String, required: true },
  masterTradeId: { type: mongoose.Schema.Types.ObjectId, ref: 'MasterTrade', index: true },
  originalTradeId: { type: String, required: true },
  symbol: { type: String, required: true },
  side: { type: String, enum: ['buy', 'sell'], required: true },
  entryPrice: { type: Number, required: true },
  exitPrice: { type: Number },
  margin: { type: Number, default: 0 },      // funds committed from the copy, user currency
  leverage: { type: Number, default: 1 },
  quantity: { type: Number, default: 0 },    // margin * leverage / entryPrice
  profitLoss: { type: Number, default: 0 },  // gross, before commission
  profitPercentage: { type: Number, default: 0 },
  commission: { type: Number, default: 0 },
  status: { type: String, enum: ['open', 'closed', 'cancelled'], default: 'open', index: true },
  closedReason: {
    type: String,
    enum: ['trader_closed', 'manual', 'copy_stopped', 'cancelled', 'stop_loss', 'take_profit', 'legacy', 'other']
  },
  openedAt: { type: Date, default: Date.now },
  closedAt: { type: Date },
  metadata: { type: Object, default: {} }
}, {
  timestamps: true,
  toJSON: {
    virtuals: true,
    transform(doc, ret) {
      delete ret.__v;
      ret.id = ret._id;
      return ret;
    }
  }
});

copiedTradeSchema.index({ masterTradeId: 1, status: 1 });
copiedTradeSchema.index({ copyTradeId: 1, status: 1 });

export default mongoose.model('CopiedTrade', copiedTradeSchema);
