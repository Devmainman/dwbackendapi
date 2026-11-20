import mongoose from 'mongoose';

/** Help Center: FAQ categories (with an optional image) and their questions. Managed in the admin panel. */
const faqCategorySchema = new mongoose.Schema({
  name: { type: String, trim: true, required: true, maxlength: 60 },
  slug: { type: String, trim: true, lowercase: true, required: true, unique: true, maxlength: 80 },
  description: { type: String, trim: true, maxlength: 240, default: '' },
  image: { type: String, default: '' },
  status: { type: String, enum: ['draft', 'published'], default: 'published', index: true },
  sortOrder: { type: Number, default: 0 }
}, { timestamps: true });

const faqItemSchema = new mongoose.Schema({
  category: { type: mongoose.Schema.Types.ObjectId, ref: 'FaqCategory', required: true, index: true },
  question: { type: String, trim: true, required: true, maxlength: 300 },
  // Answer in simple Markdown (**bold**, lists, [links](url)), like blog articles.
  answer: { type: String, required: true, maxlength: 20000 },
  status: { type: String, enum: ['draft', 'published'], default: 'published', index: true },
  sortOrder: { type: Number, default: 0 }
}, { timestamps: true });

faqItemSchema.index({ category: 1, status: 1, sortOrder: 1 });

export const FaqCategory = mongoose.model('FaqCategory', faqCategorySchema);
export const FaqItem = mongoose.model('FaqItem', faqItemSchema);
