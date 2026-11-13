import mongoose from 'mongoose';

/**
 * A user's copy of a trader: a ring-fenced sub-account.
 *  amount  = total principal the user has put in (initial + top-ups)
 *  cash    = funds not currently committed to open positions
 *  equity  = cash + margins of open positions (+ unrealised P/L for display)
 */
const copyTradeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  trader: { type: mongoose.Schema.Types.ObjectId, ref: 'Trader' },
  traderId: { type: String, required: true, index: true },
  traderUsername: { type: String, required: true },
  traderAvatar: { type: String, default: '' },
  currency: { type: String, uppercase: true, default: 'USD' },

  amount: { type: Number, required: true, min: 0 },
  cash: { type: Number, min: 0 },
  realizedPnl: { type: Number, default: 0 },     // after commission
  commissionPaid: { type: Number, default: 0 },

  status: { type: String, enum: ['active', 'paused', 'stopping', 'stopped'], default: 'active', index: true },
  // true while the copy is not stopped; a unique partial index stops duplicate copies of one trader.
  isOpen: { type: Boolean, default: true },

  settings: {
    stopLossPercent: { type: Number, min: 0, max: 100, default: null },   // auto-stop when equity falls this % below principal
    takeProfitPercent: { type: Number, min: 0, max: 1000, default: null }, // auto-stop when equity rises this % above principal
    copyOpenTrades: { type: Boolean, default: true }
  },

  performance: {
    totalTrades: { type: Number, default: 0 },
    successfulTrades: { type: Number, default: 0 }
  },

  startedAt: { type: Date, default: Date.now },
  stoppedAt: { type: Date },
  stopReason: { type: String, enum: ['user', 'stop_loss', 'take_profit', 'admin', 'trader_removed', null], default: null },
  payout: { type: Number, default: 0 }
}, { timestamps: true });

copyTradeSchema.index(
  { userId: 1, traderId: 1 },
  { unique: true, partialFilterExpression: { isOpen: true }, name: 'one_open_copy_per_trader' }
);

export default mongoose.model('CopyTrade', copyTradeSchema);
