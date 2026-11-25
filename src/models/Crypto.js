import mongoose from 'mongoose';

/**
 * Crypto wallets (separate from the fiat balance on User.balance).
 *
 *   CryptoAsset       a coin the platform supports: deposit address, on/off. Prices are
 *                     live (services/cryptoMarket.js), never stored as the truth.
 *   CryptoWallet      one user's quantity of one coin.
 *   CryptoDeposit     a crypto deposit the admin verifies; approval credits the wallet once.
 *   CryptoConversion  an executed fiat <-> crypto conversion (audit trail).
 */
const assetSchema = new mongoose.Schema({
  symbol: { type: String, required: true, unique: true, uppercase: true, trim: true, maxlength: 12 },
  name: { type: String, required: true, trim: true, maxlength: 60 },
  icon: { type: String, default: '' },
  network: { type: String, trim: true, maxlength: 60, default: '' },        // e.g. "Bitcoin", "ERC-20", "TRC-20"
  depositAddress: { type: String, trim: true, maxlength: 200, default: '' },
  depositMemo: { type: String, trim: true, maxlength: 100, default: '' },   // tag / memo for XRP, XLM, etc.
  minDeposit: { type: Number, default: 0, min: 0 },                          // in coin units
  enabled: { type: Boolean, default: false, index: true },
  sortOrder: { type: Number, default: 0 }
}, { timestamps: true });

const walletSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  symbol: { type: String, required: true, uppercase: true },
  balance: { type: Number, default: 0, min: 0 }
}, { timestamps: true });
walletSchema.index({ user: 1, symbol: 1 }, { unique: true });

const depositSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  symbol: { type: String, required: true, uppercase: true },
  amount: { type: Number, required: true, min: 0 },              // coin units the user says they sent
  network: { type: String, default: '' },
  address: { type: String, default: '' },                         // the address shown to the user
  memo: { type: String, default: '' },
  txHash: { type: String, trim: true, default: '' },
  proof: { type: String, default: '' },
  reference: { type: String, required: true, unique: true },
  priceAtSubmit: { type: Number, default: 0 },                    // per coin, user currency (for the admin's reference)
  currency: { type: String, uppercase: true },                    // user currency at submit
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  creditedAmount: { type: Number, default: 0 },                   // coin units actually credited (admin may correct)
  credited: { type: Boolean, default: false },                    // guard: a deposit is credited once
  transaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
  reviewedAt: Date,
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  note: { type: String, trim: true, maxlength: 500, default: '' }
}, { timestamps: true });
// The same on-chain transaction can't be submitted twice for a coin.
depositSchema.index({ symbol: 1, txHash: 1 }, { unique: true, partialFilterExpression: { txHash: { $type: 'string', $gt: '' }, status: { $in: ['pending', 'approved'] } } });

const conversionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  direction: { type: String, enum: ['crypto_to_fiat', 'fiat_to_crypto'], required: true },
  symbol: { type: String, required: true, uppercase: true },
  coinAmount: { type: Number, required: true },
  fiatAmount: { type: Number, required: true },
  currency: { type: String, required: true, uppercase: true },
  price: { type: Number, required: true },                        // per coin, user currency, used for the fill
  feePercent: { type: Number, default: 0 },
  fee: { type: Number, default: 0 },                              // in fiat
  reference: { type: String, required: true, unique: true }
}, { timestamps: true });

export const CryptoAsset = mongoose.model('CryptoAsset', assetSchema);
export const CryptoWallet = mongoose.model('CryptoWallet', walletSchema);
export const CryptoDeposit = mongoose.model('CryptoDeposit', depositSchema);
export const CryptoConversion = mongoose.model('CryptoConversion', conversionSchema);
