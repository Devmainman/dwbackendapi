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
 *   active               -> card is active (the admin issued its details first)
 *   frozen               -> active card temporarily blocked by the admin
 *   terminated           -> card closed for good by the admin
 *   rejected / cancelled -> closed
 * A rejected payment sends the request back to the matching *_unpaid stage so the
 * user can pay again (the rejection reason is kept on the payment).
 */
export const STAGES = ['purchase_unpaid', 'purchase_review', 'activation_unpaid', 'activation_review', 'active', 'frozen', 'terminated', 'rejected', 'cancelled'];
/** Stages where the admin may issue or edit the card details (purchase approved). */
export const ISSUABLE_STAGES = ['activation_unpaid', 'activation_review', 'active', 'frozen'];
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
  // Filled in by the admin once the purchase is approved. The full number and
  // CVV are AES-256-GCM ciphertext (services/cardVault.js) and never selected
  // by default; everything else here is display-safe.
  card: {
    last4: { type: String, match: /^\d{4}$/ },
    expiry: { type: String, maxlength: 7 },           // "MM/YY", for display
    expiryMonth: { type: Number, min: 1, max: 12 },
    expiryYear: { type: Number },
    holderName: { type: String, trim: true, maxlength: 60 },
    network: { type: String },
    panEnc: { type: String, select: false },
    cvvEnc: { type: String, select: false },
    issuedAt: Date,
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    updatedAt: Date
  },
  // Card PIN: bcrypt hash only. Wrong attempts lock PIN changes for a while.
  pin: {
    hash: { type: String, select: false },
    setAt: Date,
    failedAttempts: { type: Number, default: 0 },
    lockedUntil: Date
  },
  frozenAt: Date,
  terminatedAt: Date,
  statusNote: { type: String, trim: true, maxlength: 300, default: '' },
  activatedAt: Date,
  cancelledAt: Date,
  adminNote: { type: String, trim: true, maxlength: 500, default: '' }
}, { timestamps: true });

cardRequestSchema.index({ user: 1, product: 1, stage: 1 });
cardRequestSchema.index({ stage: 1, updatedAt: -1 });

export default mongoose.model('CardRequest', cardRequestSchema);
