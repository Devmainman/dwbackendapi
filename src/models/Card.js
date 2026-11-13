import mongoose from 'mongoose';

/**
 * Debit card issued to a user. Full card numbers and CVVs are NEVER stored
 * here: an issuing provider holds them (providerCardId links the two).
 * Only display-safe data (last 4 digits, expiry) is persisted.
 */
const cardSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: ['virtual', 'physical'], required: true },
  brand: { type: String, enum: ['visa', 'mastercard'], default: 'visa' },
  holderName: { type: String, trim: true, maxlength: 60, required: true },
  label: { type: String, trim: true, maxlength: 40, default: '' },
  color: { type: String, enum: ['midnight', 'aurora', 'gold', 'rose'], default: 'midnight' },
  last4: { type: String, match: /^\d{4}$/ },
  expiryMonth: { type: Number, min: 1, max: 12 },
  expiryYear: { type: Number },
  currency: { type: String, uppercase: true, required: true },
  balance: { type: Number, default: 0, min: 0 },
  spendingLimit: { type: Number, default: 5000, min: 0 },
  issuanceFee: { type: Number, default: 0, min: 0 },
  status: {
    type: String,
    enum: ['pending', 'active', 'frozen', 'rejected', 'cancelled'],
    default: 'pending',
    index: true
  },
  shippingAddress: {
    street: { type: String, trim: true, maxlength: 120 },
    city: { type: String, trim: true, maxlength: 60 },
    state: { type: String, trim: true, maxlength: 60 },
    postalCode: { type: String, trim: true, maxlength: 20 },
    country: { type: String, trim: true, maxlength: 60 }
  },
  providerCardId: { type: String, default: null },
  adminNote: { type: String, trim: true, maxlength: 500 },
  activatedAt: { type: Date },
  cancelledAt: { type: Date }
}, { timestamps: true });

cardSchema.virtual('maskedNumber').get(function () {
  return this.last4 ? `•••• •••• •••• ${this.last4}` : 'Pending issuance';
});
cardSchema.set('toJSON', { virtuals: true });
cardSchema.set('toObject', { virtuals: true });

export default mongoose.model('Card', cardSchema);
