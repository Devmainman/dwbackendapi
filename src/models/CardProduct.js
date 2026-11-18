import mongoose from 'mongoose';

/**
 * A card the admin offers (Card Settings). Users browse these on the Cards page
 * and request one; prices are always read from here, never hardcoded.
 * Prices are in the platform base currency and converted for each user.
 */
export const CARD_NETWORKS = ['visa', 'mastercard', 'amex', 'discover', 'unionpay', 'verve', 'jcb', 'other'];
export const CARD_PRESETS = ['midnight', 'aurora', 'gold', 'rose', 'silver', 'emerald'];

const cardProductSchema = new mongoose.Schema({
  name: { type: String, trim: true, required: true, maxlength: 60 },
  type: { type: String, enum: ['virtual', 'physical'], required: true, index: true },
  network: { type: String, enum: CARD_NETWORKS, required: true },
  // Either an uploaded image (design) or one of the built-in looks (designPreset).
  design: { type: String, default: '' },
  designPreset: { type: String, enum: CARD_PRESETS, default: 'midnight' },
  description: { type: String, trim: true, maxlength: 300, default: '' },
  purchasePrice: { type: Number, required: true, min: 0 },
  activationFee: { type: Number, required: true, min: 0 },
  status: { type: String, enum: ['available', 'unavailable'], default: 'available', index: true },
  sortOrder: { type: Number, default: 0 }
}, { timestamps: true });

export default mongoose.model('CardProduct', cardProductSchema);
