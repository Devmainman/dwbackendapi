import mongoose from 'mongoose';

/** One-time challenge a wallet must sign to prove ownership. Auto-expires. */
const walletNonceSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  nonce: { type: String, required: true },
  message: { type: String, required: true },
  expiresAt: { type: Date, required: true }
});

walletNonceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('WalletNonce', walletNonceSchema);
