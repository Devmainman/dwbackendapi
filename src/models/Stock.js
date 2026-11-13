import mongoose from 'mongoose';

/** A tradable stock listing. Prices are quoted in the platform base currency. */
const stockAssetSchema = new mongoose.Schema({
  symbol: { type: String, required: true, unique: true, uppercase: true, trim: true, maxlength: 10 },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  exchange: { type: String, trim: true, default: 'NASDAQ' },
  sector: { type: String, trim: true, default: 'Technology' },
  logo: { type: String, trim: true, default: '' },
  description: { type: String, trim: true, maxlength: 2000, default: '' },
  price: { type: Number, required: true, min: 0 },
  previousClose: { type: Number, min: 0, default: 0 },
  marketCap: { type: Number, default: 0 },
  dividendYield: { type: Number, default: 0, min: 0 },
  priceHistory: [{
    _id: false,
    price: Number,
    at: { type: Date, default: Date.now }
  }],
  feePercent: { type: Number, default: 0.5, min: 0, max: 10 },
  isActive: { type: Boolean, default: true, index: true }
}, { timestamps: true });

stockAssetSchema.virtual('changePercent').get(function () {
  if (!this.previousClose) return 0;
  return Math.round(((this.price - this.previousClose) / this.previousClose) * 10000) / 100;
});
stockAssetSchema.set('toJSON', { virtuals: true });
stockAssetSchema.set('toObject', { virtuals: true });

export const StockAsset = mongoose.model('StockAsset', stockAssetSchema);

/** A user's position in one stock. Cost basis is kept in the user's currency. */
const stockHoldingSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  stock: { type: mongoose.Schema.Types.ObjectId, ref: 'StockAsset', required: true },
  shares: { type: Number, default: 0, min: 0 },
  costBasis: { type: Number, default: 0, min: 0 }, // total invested, user currency
  currency: { type: String, uppercase: true, required: true }
}, { timestamps: true });

stockHoldingSchema.index({ user: 1, stock: 1 }, { unique: true });

export const StockHolding = mongoose.model('StockHolding', stockHoldingSchema);

/** Immutable record of each buy / sell. */
const stockOrderSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  stock: { type: mongoose.Schema.Types.ObjectId, ref: 'StockAsset', required: true },
  symbol: { type: String, required: true },
  side: { type: String, enum: ['buy', 'sell'], required: true },
  shares: { type: Number, required: true, min: 0 },
  price: { type: Number, required: true },        // base currency, per share
  amount: { type: Number, required: true },       // user currency, gross
  fee: { type: Number, default: 0 },              // user currency
  currency: { type: String, uppercase: true, required: true },
  realizedPnl: { type: Number, default: 0 },
  status: { type: String, enum: ['filled', 'cancelled'], default: 'filled' }
}, { timestamps: true });

export const StockOrder = mongoose.model('StockOrder', stockOrderSchema);
