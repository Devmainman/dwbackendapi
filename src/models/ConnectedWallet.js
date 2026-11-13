import mongoose from 'mongoose';

/**
 * An external self-custody wallet linked to a user's account.
 * Ownership of EVM wallets is proven with a signed message (no keys or seed
 * phrases are ever requested or stored). Non-EVM addresses can be saved
 * as unverified "watch" addresses.
 */
const connectedWalletSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  address: { type: String, required: true, trim: true },
  network: { type: String, enum: ['evm', 'bitcoin', 'solana', 'tron'], default: 'evm' },
  chainId: { type: Number, default: null },
  // Wallet app the address belongs to (e.g. 'metamask', 'trust-wallet', 'exodus'), lower-case slug.
  provider: { type: String, trim: true, lowercase: true, maxlength: 40, match: /^[a-z0-9-]{2,40}$/, default: 'other' },
  label: { type: String, trim: true, maxlength: 40, default: '' },
  verified: { type: Boolean, default: false },
  verifiedAt: { type: Date },
  isPrimary: { type: Boolean, default: false }
}, { timestamps: true });

connectedWalletSchema.index({ user: 1, network: 1, address: 1 }, { unique: true });

export default mongoose.model('ConnectedWallet', connectedWalletSchema);
