import mongoose from 'mongoose';

const simulatedTradeSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  side: { type: String, enum: ['buy', 'sell'], required: true }, // originally entry is 'buy'. We will keep 'buy' entries as open positions.
  amount: { type: Number, required: true }, // amount in user's account currency they used to open
  quantity: { type: Number, required: true }, // units purchased
  entryPrice: { type: Number, required: true },
  exitPrice: { type: Number, default: null },
  status: { type: String, enum: ['open', 'closed'], default: 'open' },
  profit: { type: Number, default: 0 }, // pnl after close
  metadata: { type: Object, default: {} },
  openedAt: { type: Date, default: Date.now },
  closedAt: { type: Date }
}, { timestamps: true });

simulatedTradeSchema.index({ user: 1, status: 1 });

const SimulatedTrade = mongoose.model('SimulatedTrade', simulatedTradeSchema);
export default SimulatedTrade;
