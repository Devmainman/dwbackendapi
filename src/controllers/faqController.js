// Help Center (FAQ): the admin manages categories (name, optional image) and the
// questions in each; the public site shows published ones on /help and the landing page.
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { FaqCategory, FaqItem } from '../models/Faq.js';
import { asString } from '../utils/validation.js';
import { HttpError } from '../utils/wallet.js';
import { handler } from '../services/productService.js';
import { slugify } from './blogController.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const oid = (id) => { if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, 'Invalid id'); return id; };
const STATUSES = ['draft', 'published'];
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'];

const uniqueSlug = async (base, exceptId) => {
  const root = slugify(base) || 'help';
  for (let i = 1; i < 200; i++) {
    const slug = i === 1 ? root : `${root}-${i}`;
    // eslint-disable-next-line no-await-in-loop
    if (!(await FaqCategory.exists({ slug, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }))) return slug;
  }
  return `${root}-${Date.now()}`;
};

const saveImage = async (file) => {
  if (!IMAGE_TYPES.includes(file.mimetype)) throw new HttpError(400, 'The image must be PNG, JPG, WEBP, GIF or SVG');
  if (file.size > 5 * 1024 * 1024) throw new HttpError(400, 'The image must be 5 MB or smaller');
  const name = `${uuidv4()}${path.extname(file.name || '').toLowerCase() || '.png'}`;
  await file.mv(path.join(__dirname, '../uploads/faq', name));
  return `/uploads/faq/${name}`;
};

/* ============================ Admin: categories ============================ */

export const adminListCategories = handler(async (_req, res) => {
  const [cats, counts] = await Promise.all([
    FaqCategory.find().sort({ sortOrder: 1, createdAt: 1 }).lean(),
    FaqItem.aggregate([{ $group: { _id: '$category', total: { $sum: 1 }, published: { $sum: { $cond: [{ $eq: ['$status', 'published'] }, 1, 0] } } } }])
  ]);
  const by = Object.fromEntries(counts.map((c) => [String(c._id), c]));
  res.json({ success: true, data: cats.map((c) => ({ ...c, questions: by[String(c._id)]?.total || 0, published: by[String(c._id)]?.published || 0 })) });
});

/** POST /categories, PUT /categories/:id  (multipart: name, description?, status?, sortOrder?, image?, removeImage?) */
export const adminSaveCategory = handler(async (req, res) => {
  const id = req.params.id ? oid(req.params.id) : null;
  const existing = id ? await FaqCategory.findById(id) : null;
  if (id && !existing) throw new HttpError(404, 'Category not found');
  const data = {};
  if (req.body.name !== undefined || !id) {
    data.name = asString(req.body.name, 60);
    if (data.name.length < 2) throw new HttpError(400, 'Enter a category name');
    data.slug = await uniqueSlug(data.name, id);
  }
  if (req.body.description !== undefined) data.description = asString(req.body.description, 240);
  if (req.body.status !== undefined) {
    if (!STATUSES.includes(req.body.status)) throw new HttpError(400, 'Status must be draft or published');
    data.status = req.body.status;
  }
  if (req.body.sortOrder !== undefined && req.body.sortOrder !== '') data.sortOrder = Number(req.body.sortOrder) || 0;
  if (req.files?.image) data.image = await saveImage(req.files.image);
  else if (req.body.removeImage === 'true' || req.body.removeImage === true) data.image = '';
  const cat = id
    ? await FaqCategory.findByIdAndUpdate(id, { $set: data }, { new: true, runValidators: true })
    : await FaqCategory.create(data);
  res.status(id ? 200 : 201).json({ success: true, message: id ? `${cat.name} saved` : `${cat.name} created`, data: cat });
});

/** DELETE /categories/:id — removes the category and its questions */
export const adminDeleteCategory = handler(async (req, res) => {
  const id = oid(req.params.id);
  const cat = await FaqCategory.findByIdAndDelete(id);
  if (!cat) throw new HttpError(404, 'Category not found');
  const { deletedCount } = await FaqItem.deleteMany({ category: id });
  res.json({ success: true, message: `${cat.name} deleted${deletedCount ? ` with ${deletedCount} question${deletedCount === 1 ? '' : 's'}` : ''}` });
});

/* ============================ Admin: questions ============================ */

export const adminListItems = handler(async (req, res) => {
  const filter = {};
  if (req.query.category) filter.category = oid(req.query.category);
  const items = await FaqItem.find(filter).sort({ sortOrder: 1, createdAt: 1 }).populate('category', 'name').lean();
  res.json({ success: true, data: items });
});

/** POST /items, PUT /items/:id  { category, question, answer, status?, sortOrder? } */
export const adminSaveItem = handler(async (req, res) => {
  const id = req.params.id ? oid(req.params.id) : null;
  const data = {};
  const errors = [];
  if (req.body.category !== undefined || !id) {
    if (!mongoose.Types.ObjectId.isValid(req.body.category) || !(await FaqCategory.exists({ _id: req.body.category }))) errors.push('Choose a category');
    else data.category = req.body.category;
  }
  if (req.body.question !== undefined || !id) {
    data.question = asString(req.body.question, 300);
    if (data.question.length < 3) errors.push('Enter the question');
  }
  if (req.body.answer !== undefined || !id) {
    data.answer = String(req.body.answer ?? '').trim().slice(0, 20000);
    if (!data.answer) errors.push('Every question needs an answer');
  }
  if (req.body.status !== undefined) {
    if (!STATUSES.includes(req.body.status)) errors.push('Status must be draft or published');
    else data.status = req.body.status;
  }
  if (req.body.sortOrder !== undefined && req.body.sortOrder !== '') data.sortOrder = Number(req.body.sortOrder) || 0;
  if (errors.length) throw new HttpError(400, errors.join('. '));
  const item = id
    ? await FaqItem.findByIdAndUpdate(id, { $set: data }, { new: true, runValidators: true })
    : await FaqItem.create(data);
  if (!item) throw new HttpError(404, 'Question not found');
  res.status(id ? 200 : 201).json({ success: true, message: id ? 'Question saved' : 'Question added', data: item });
});

export const adminDeleteItem = handler(async (req, res) => {
  const item = await FaqItem.findByIdAndDelete(oid(req.params.id));
  if (!item) throw new HttpError(404, 'Question not found');
  res.json({ success: true, message: 'Question deleted' });
});

/* ============================ Public ============================ */

/** GET /api/public/faq/categories — published categories that have published questions */
export const publicCategories = handler(async (_req, res) => {
  const [cats, counts] = await Promise.all([
    FaqCategory.find({ status: 'published' }).sort({ sortOrder: 1, createdAt: 1 }).lean(),
    FaqItem.aggregate([{ $match: { status: 'published' } }, { $group: { _id: '$category', n: { $sum: 1 } } }])
  ]);
  const by = Object.fromEntries(counts.map((c) => [String(c._id), c.n]));
  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    success: true,
    data: cats.filter((c) => by[String(c._id)]).map((c) => ({ id: c._id, name: c.name, slug: c.slug, description: c.description, image: c.image, questions: by[String(c._id)] }))
  });
});

/** GET /api/public/faq/categories/:slug — one category with its questions and answers */
export const publicCategory = handler(async (req, res) => {
  const cat = await FaqCategory.findOne({ slug: asString(req.params.slug, 80).toLowerCase(), status: 'published' }).lean();
  if (!cat) throw new HttpError(404, 'This help topic was not found');
  const items = await FaqItem.find({ category: cat._id, status: 'published' }).sort({ sortOrder: 1, createdAt: 1 }).lean();
  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    success: true,
    data: {
      category: { id: cat._id, name: cat.name, slug: cat.slug, description: cat.description, image: cat.image },
      items: items.map((i) => ({ id: i._id, question: i.question, answer: i.answer, updatedAt: i.updatedAt }))
    }
  });
});

/** GET /api/public/faq/search?q= — published questions matching the words */
export const publicSearch = handler(async (req, res) => {
  const q = asString(req.query.q, 80);
  if (q.length < 2) return res.json({ success: true, data: [] });
  const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const items = await FaqItem.find({ status: 'published', $or: [{ question: rx }, { answer: rx }] }).limit(20).populate('category', 'name slug status').lean();
  res.json({
    success: true,
    data: items.filter((i) => i.category?.status === 'published').map((i) => ({ id: i._id, question: i.question, answer: i.answer, category: { name: i.category.name, slug: i.category.slug } }))
  });
});
