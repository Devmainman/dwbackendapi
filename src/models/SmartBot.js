import mongoose from 'mongoose';

/**
 * An AI Smart Trader bot the admin offers. Users subscribe (paid like signal
 * packages, reviewed in Bot Invoices); once active the bot places up to
 * `tradeLimit` trades for the user, one every `tradeIntervalMinutes`.
 * Money values are in the platform base currency and converted per user.
 */
const smartBotSchema = new mongoose.Schema({
  name: { type: String, trim: true, required: true, maxlength: 60 },
  description: { type: String, trim: true, maxlength: 400, default: '' },
  strategy: { type: String, trim: true, maxlength: 60, default: 'Trend following' },
  price: { type: Number, required: true, min: 0 },              // subscription price
  tradeLimit: { type: Number, required: true, min: 1, max: 100000 }, // total trades per subscription
  tradeIntervalMinutes: { type: Number, default: 60, min: 1, max: 10080 },
  minAllocation: { type: Number, default: 100, min: 0 },        // smallest capital a user can give the bot
  winRate: { type: Number, default: 70, min: 0, max: 100 },     // % of trades that win
  profitMin: { type: Number, default: 0.5, min: 0 },            // % of allocation on a winning trade
  profitMax: { type: Number, default: 2, min: 0 },
  lossMin: { type: Number, default: 0.3, min: 0 },              // % of allocation on a losing trade
  lossMax: { type: Number, default: 1, min: 0 },
  markets: { type: [String], default: ['BTC', 'ETH', 'SOL', 'BNB', 'XRP'] },
  status: { type: String, enum: ['available', 'unavailable'], default: 'available', index: true },
  sortOrder: { type: Number, default: 0 }
}, { timestamps: true });

export default mongoose.model('SmartBot', smartBotSchema);
