import mongoose from 'mongoose';

/** Blog categories and articles, managed in the admin panel and shown on the public site (/blog). */
const blogCategorySchema = new mongoose.Schema({
  name: { type: String, trim: true, required: true, maxlength: 40 },
  slug: { type: String, trim: true, lowercase: true, required: true, unique: true, maxlength: 60 },
  description: { type: String, trim: true, maxlength: 200, default: '' },
  sortOrder: { type: Number, default: 0 }
}, { timestamps: true });

const blogPostSchema = new mongoose.Schema({
  title: { type: String, trim: true, required: true, maxlength: 140 },
  slug: { type: String, trim: true, lowercase: true, required: true, unique: true, maxlength: 160 },
  excerpt: { type: String, trim: true, maxlength: 300, default: '' },
  // Article body in simple Markdown (## headings, **bold**, *italic*, lists, [links](url), > quotes).
  content: { type: String, default: '', maxlength: 100000 },
  coverImage: { type: String, default: '' },
  category: { type: mongoose.Schema.Types.ObjectId, ref: 'BlogCategory', default: null, index: true },
  authorName: { type: String, trim: true, maxlength: 60, default: '' },
  status: { type: String, enum: ['draft', 'published'], default: 'draft', index: true },
  featured: { type: Boolean, default: false },
  publishedAt: { type: Date, index: true },
  readMinutes: { type: Number, default: 1 },
  views: { type: Number, default: 0 }
}, { timestamps: true });

blogPostSchema.index({ status: 1, publishedAt: -1 });

export const BlogCategory = mongoose.model('BlogCategory', blogCategorySchema);
export const BlogPost = mongoose.model('BlogPost', blogPostSchema);
