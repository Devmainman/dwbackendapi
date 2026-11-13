import mongoose from 'mongoose';

/**
 * A trading-package position ("bot trade"). The stake is debited when it opens;
 * profit accrues per completed interval and stake + profit are paid out once at
 * the end (see services/botTradeEngine.js).
 */
const tradeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  packageId: { type: mongoose.Schema.Types.ObjectId, ref: 'TradePackage' },
  name: { type: String, required: true },
  amount: { type: Number, required: true, min: 0 },        // stake, user currency
  currency: { type: String, default: 'USD' },
  rate: { type: Number, default: 0 },                        // % per interval
  interval: { type: String, default: 'hour' },               // see INTERVAL_MINUTES
  durationHours: { type: Number, default: 0 },
  profit: { type: Number, required: true, default: 0 },     // expected total profit for the full term
  earned: { type: Number, default: 0 },                      // profit accrued so far (snapshot)
  status: {
    type: String,
    enum: ['pending', 'in-progress', 'completed', 'paused', 'terminated'],
    default: 'in-progress'
  },
  progress: { type: Number, min: 0, max: 100, default: 0 },
  startDate: { type: Date, default: Date.now },
  endDate: Date,
  active: { type: Boolean, default: true },
  settledAt: { type: Date, default: null },
  payout: { type: Number, default: 0 },
  closeReason: { type: String, enum: ['matured', 'cancelled', 'admin_completed', 'admin_terminated', null], default: null }
}, { timestamps: true });

tradeSchema.index({ userId: 1, status: 1 });
tradeSchema.index({ status: 1, endDate: 1 });
tradeSchema.index({ startDate: -1 });

const Trade = mongoose.model('Trade', tradeSchema);
export default Trade;
