import mongoose from 'mongoose';

/**
 * A real-estate project open for investment. Money fields are in the platform
 * base currency. `roi` is the total target return (%) over `durationMonths`.
 */
const propertySchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 140 },
  slug: { type: String, trim: true, lowercase: true, unique: true, sparse: true },
  summary: { type: String, trim: true, maxlength: 400, default: '' },          // one or two lines under the title
  overview: { type: String, trim: true, maxlength: 8000, default: '' },        // "Project overview"
  images: [{ type: String, trim: true }],
  location: {
    address: { type: String, trim: true, maxlength: 200 },
    city: { type: String, trim: true, maxlength: 80 },
    country: { type: String, trim: true, maxlength: 80 }
  },

  // Project breakdown
  propertyType: {
    type: String,
    enum: ['residential', 'commercial', 'industrial', 'hospitality', 'land', 'mixed_use', 'life_science', 'healthcare', 'retail', 'office'],
    default: 'commercial'
  },
  assetType: { type: String, trim: true, maxlength: 80, default: '' },         // e.g. "Life Science - Lab/R&D"
  stories: { type: Number, min: 0, max: 300, default: null },
  strategy: { type: String, trim: true, maxlength: 60, default: 'Fixed income' },
  objective: { type: String, trim: true, maxlength: 60, default: '' },         // e.g. "Opportunistic"
  minimumInvestment: { type: Number, required: true, min: 1 },
  roi: { type: Number, required: true, min: 0, max: 1000 },                    // % total over the term
  durationMonths: { type: Number, required: true, min: 1, max: 600 },
  fundingTarget: { type: Number, required: true, min: 1 },
  amountRaised: { type: Number, default: 0, min: 0 },

  whyProject: [{ type: String, trim: true, maxlength: 600 }],
  sponsor: {
    name: { type: String, trim: true, maxlength: 120, default: '' },
    about: { type: String, trim: true, maxlength: 2000, default: '' }
  },
  whySponsor: [{ type: String, trim: true, maxlength: 600 }],
  documents: [{
    _id: false,
    title: { type: String, trim: true, maxlength: 120 },
    url: { type: String, trim: true, maxlength: 500 }
  }],

  status: { type: String, enum: ['open', 'closed'], default: 'open', index: true },
  closedAt: { type: Date },
  featured: { type: Boolean, default: false },
  sortOrder: { type: Number, default: 0 }
}, { timestamps: true });

propertySchema.virtual('fundedPercent').get(function fundedPercent() {
  if (!this.fundingTarget) return 0;
  return Math.min(100, Math.round((this.amountRaised / this.fundingTarget) * 10000) / 100);
});
propertySchema.virtual('remaining').get(function remaining() {
  return Math.max(0, Math.round((this.fundingTarget - this.amountRaised) * 100) / 100);
});
propertySchema.set('toJSON', { virtuals: true });
propertySchema.set('toObject', { virtuals: true });

export const Property = mongoose.model('Property', propertySchema);

/** A user's investment in a project. Returns accrue evenly over the term. */
const propertyInvestmentSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  property: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true, index: true },
  amount: { type: Number, required: true, min: 0 },       // user currency
  baseAmount: { type: Number, required: true, min: 0 },   // base currency (counts toward funding)
  currency: { type: String, uppercase: true, required: true },
  roi: { type: Number, required: true },                  // % total over the term, locked at investment
  durationMonths: { type: Number, required: true },
  startAt: { type: Date, default: Date.now },
  maturityAt: { type: Date, required: true },
  incomeClaimed: { type: Number, default: 0, min: 0 },
  status: { type: String, enum: ['active', 'matured'], default: 'active', index: true },
  redeemedAt: { type: Date },
  payout: { type: Number, default: 0 }
}, { timestamps: true });

export const PropertyInvestment = mongoose.model('PropertyInvestment', propertyInvestmentSchema);
