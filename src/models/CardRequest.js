import mongoose from 'mongoose';

/**
 * One user's request for one card (Card Invoices). Both payments live here:
 * the purchase payment first, then the activation payment once the purchase is
 * approved. Each is reviewed separately by the admin.
 *
 * Overall `stage` (what the user / admin should do next):
 *   purchase_unpaid      -> user must pay the purchase price
 *   purchase_review      -> admin reviews the purchase payment
 *   activation_unpaid    -> purchase approved; user must pay the activation fee
 *   activation_review    -> admin reviews the activation payment
 *   active               -> card is active
 *   rejected / cancelled -> closed
 * A rejected payment sends the request back to the matching *_unpaid stage so the
 * user can pay again (the rejection reason is kept on the payment).
 */
export const STAGES = ['purchase_unpaid', 'purchase_review', 'activation_unpaid', 'activation_review', 'active', 'rejected', 'cancelled'];
export const OPEN_STAGES = ['purchase_unpaid', 'purchase_review', 'activation_unpaid', 'activation_review'];

const paymentSchema = new mongoose.Schema({
  status: { type: String, enum: ['unpaid', 'pending', 'approved', 'rejected'], default: 'unpaid' },
  amount: { type: Number, min: 0 },            // in the user's currency, set by the server
  currency: { type: String, uppercase: true },
  baseAmount: { type: Number, min: 0 },        // same amount in the platform base currency
  paymentMethod: { type: String, default: '' },
  proof: { type: String, default: '' },
  reference: { type: String, default: '' },
  transaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
  submittedAt: Date,
  reviewedAt: Date,
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  note: { type: String, trim: true, maxlength: 500, default: '' },
  attempts: { type: Number, default: 0 }
}, { _id: false });

const cardRequestSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'CardProduct', required: true },
  // Copy of the card as it was when requested, so later edits don't change old invoices.
  productSnapshot: {
    name: String,
    type: { type: String },
    network: String,
    design: String,
    designPreset: String,
    purchasePrice: Number,
    activationFee: Number,
    baseCurrency: String
  },
  holder: {
    fullName: { type: String, trim: true, maxlength: 60, required: true },
    email: { type: String, trim: true, maxlength: 120 },
    phone: { type: String, trim: true, maxlength: 30 },
    dateOfBirth: { type: String, trim: true, maxlength: 20 },
    address: {
      street: { type: String, trim: true, maxlength: 120 },
      city: { type: String, trim: true, maxlength: 60 },
      state: { type: String, trim: true, maxlength: 60 },
      postalCode: { type: String, trim: true, maxlength: 20 },
      country: { type: String, trim: true, maxlength: 60 }
    }
  },
  stage: { type: String, enum: STAGES, default: 'purchase_unpaid', index: true },
  purchase: { type: paymentSchema, default: () => ({}) },
  activation: { type: paymentSchema, default: () => ({}) },
  // Filled in by the admin when the card is issued (display-safe data only).
  card: {
    last4: { type: String, match: /^\d{4}$/ },
    expiry: { type: String, maxlength: 7 }
  },
  activatedAt: Date,
  cancelledAt: Date,
  adminNote: { type: String, trim: true, maxlength: 500, default: '' }
}, { timestamps: true });

cardRequestSchema.index({ user: 1, product: 1, stage: 1 });
cardRequestSchema.index({ stage: 1, updatedAt: -1 });

export default mongoose.model('CardRequest', cardRequestSchema);
