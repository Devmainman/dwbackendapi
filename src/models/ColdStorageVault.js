import mongoose from 'mongoose';

/**
 * A user's cold-storage vault. Funds moved here leave the spendable balance and
 * can only come back through a delayed unlock (and, for time-locked vaults,
 * not before the lock expires). This protects users against account takeover:
 * an attacker cannot drain vaulted funds instantly.
 */
const coldStorageVaultSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, trim: true, maxlength: 60, default: 'My Vault' },
  asset: { type: String, trim: true, uppercase: true, maxlength: 10, default: 'USD' },
  currency: { type: String, uppercase: true, required: true },
  amount: { type: Number, default: 0, min: 0 },
  lockType: { type: String, enum: ['flexible', 'time_locked'], default: 'flexible' },
  lockDays: { type: Number, default: 0, min: 0, max: 3650 },
  lockedUntil: { type: Date, default: null },
  status: {
    type: String,
    enum: ['active', 'unlock_requested', 'closed'],
    default: 'active',
    index: true
  },
  unlockAmount: { type: Number, default: 0, min: 0 },
  unlockRequestedAt: { type: Date, default: null },
  unlockAvailableAt: { type: Date, default: null },
  adminHold: { type: Boolean, default: false },
  adminNote: { type: String, trim: true, maxlength: 500 }
}, { timestamps: true });

coldStorageVaultSchema.index({ user: 1, status: 1 });

export default mongoose.model('ColdStorageVault', coldStorageVaultSchema);
