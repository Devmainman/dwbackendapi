// Blog: admin manages categories and articles; the public site reads published ones.
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { BlogCategory, BlogPost } from '../models/Blog.js';
import { asString } from '../utils/validation.js';
import { HttpError } from '../utils/wallet.js';
import { handler, paging } from '../services/productService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const oid = (id) => { if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, 'Invalid id'); return id; };
export const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 150);
const readTime = (text) => Math.max(1, Math.round(String(text || '').split(/\s+/).filter(Boolean).length / 220));

/** A slug that no other post/category uses (adds -2, -3, ...). */
const uniqueSlug = async (Model, base, exceptId) => {
  const root = slugify(base) || 'post';
  for (let i = 1; i < 200; i++) {
    const slug = i === 1 ? root : `${root}-${i}`;
    const clash = await Model.findOne({ slug, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }).select('_id').lean();
    if (!clash) return slug;
  }
  return `${root}-${Date.now()}`;
};

/* ============================ Categories ============================ */

export const adminListCategories = handler(async (_req, res) => {
  const [cats, counts] = await Promise.all([
    BlogCategory.find().sort({ sortOrder: 1, name: 1 }).lean(),
    BlogPost.aggregate([{ $group: { _id: '$category', n: { $sum: 1 } } }])
  ]);
  const by = Object.fromEntries(counts.map((c) => [String(c._id), c.n]));
  res.json({ success: true, data: cats.map((c) => ({ ...c, posts: by[String(c._id)] || 0 })) });
});

export const adminSaveCategory = handler(async (req, res) => {
  const name = asString(req.body.name, 40);
  if (!name) throw new HttpError(400, 'Category name is required');
  const description = asString(req.body.description, 200);
  const id = req.params.id ? oid(req.params.id) : null;
  const slug = await uniqueSlug(BlogCategory, req.body.slug || name, id);
  const data = { name, description, slug };
  const cat = id
    ? await BlogCategory.findByIdAndUpdate(id, { $set: data }, { new: true, runValidators: true })
    : await BlogCategory.create(data);
  if (!cat) throw new HttpError(404, 'Category not found');
  res.status(id ? 200 : 201).json({ success: true, data: cat });
});

export const adminDeleteCategory = handler(async (req, res) => {
  const id = oid(req.params.id);
  const cat = await BlogCategory.findByIdAndDelete(id);
  if (!cat) throw new HttpError(404, 'Category not found');
  await BlogPost.updateMany({ category: id }, { $set: { category: null } }); // posts stay, uncategorised
  res.json({ success: true });
});

/* ============================ Posts (admin) ============================ */

export const adminListPosts = handler(async (req, res) => {
  const { page, limit, skip } = paging(req.query, 20);
  const q = {};
  if (['draft', 'published'].includes(req.query.status)) q.status = req.query.status;
  if (req.query.category && mongoose.Types.ObjectId.isValid(req.query.category)) q.category = req.query.category;
  if (req.query.search) q.title = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const [items, total] = await Promise.all([
    BlogPost.find(q).select('-content').sort({ updatedAt: -1 }).skip(skip).limit(limit).populate('category', 'name slug').lean(),
    BlogPost.countDocuments(q)
  ]);
  res.json({ success: true, data: { items, total, page, limit } });
});

export const adminGetPost = handler(async (req, res) => {
  const post = await BlogPost.findById(oid(req.params.id)).populate('category', 'name slug').lean();
  if (!post) throw new HttpError(404, 'Article not found');
  res.json({ success: true, data: post });
});

export const adminSavePost = handler(async (req, res) => {
  const b = req.body;
  const id = req.params.id ? oid(req.params.id) : null;
  const existing = id ? await BlogPost.findById(id).lean() : null;
  if (id && !existing) throw new HttpError(404, 'Article not found');

  const title = asString(b.title, 140);
  if (!title) throw new HttpError(400, 'Give the article a title');
  const content = typeof b.content === 'string' ? b.content.slice(0, 100000) : '';
  const status = b.status === 'published' ? 'published' : 'draft';
  if (status === 'published' && content.trim().length < 20) throw new HttpError(400, 'Write the article before publishing it');
  let category = null;
  if (b.category) {
    if (!mongoose.Types.ObjectId.isValid(b.category) || !(await BlogCategory.exists({ _id: b.category }))) throw new HttpError(400, 'Choose a valid category');
    category = b.category;
  }

  const data = {
    title,
    excerpt: asString(b.excerpt, 300) || content.replace(/[#*>`_[\]()-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180),
    content,
    category,
    authorName: asString(b.authorName, 60),
    status,
    featured: b.featured === true || b.featured === 'true',
    readMinutes: readTime(content),
    slug: await uniqueSlug(BlogPost, b.slug || (existing?.slug && !b.slug ? existing.slug : title), id)
  };
  if (status === 'published' && !existing?.publishedAt) data.publishedAt = new Date();
  if (b.removeCover === 'true') data.coverImage = '';
  if (req.files?.coverImage) {
    const f = req.files.coverImage;
    const name = `${uuidv4()}${path.extname(f.name || '') || '.jpg'}`;
    await f.mv(path.join(__dirname, '../uploads/blog', name));
    data.coverImage = `/uploads/blog/${name}`;
  }
  const post = id
    ? await BlogPost.findByIdAndUpdate(id, { $set: data }, { new: true, runValidators: true })
    : await BlogPost.create(data);
  res.status(id ? 200 : 201).json({ success: true, data: post });
});

export const adminDeletePost = handler(async (req, res) => {
  const post = await BlogPost.findByIdAndDelete(oid(req.params.id));
  if (!post) throw new HttpError(404, 'Article not found');
  res.json({ success: true });
});

/* ============================ Public ============================ */

export const publicCategories = handler(async (_req, res) => {
  const [cats, counts] = await Promise.all([
    BlogCategory.find().sort({ sortOrder: 1, name: 1 }).lean(),
    BlogPost.aggregate([{ $match: { status: 'published' } }, { $group: { _id: '$category', n: { $sum: 1 } } }])
  ]);
  const by = Object.fromEntries(counts.map((c) => [String(c._id), c.n]));
  res.json({ success: true, data: cats.map((c) => ({ name: c.name, slug: c.slug, description: c.description, posts: by[String(c._id)] || 0 })).filter((c) => c.posts > 0) });
});

export const publicPosts = handler(async (req, res) => {
  const { page, limit, skip } = paging(req.query, 12);
  const q = { status: 'published' };
  if (req.query.category) {
    const cat = await BlogCategory.findOne({ slug: String(req.query.category).toLowerCase() }).select('_id').lean();
    if (!cat) return res.json({ success: true, data: { items: [], total: 0, page, limit } });
    q.category = cat._id;
  }
  const [items, total] = await Promise.all([
    BlogPost.find(q).select('title slug excerpt coverImage category authorName publishedAt readMinutes featured').sort({ featured: -1, publishedAt: -1 }).skip(skip).limit(limit).populate('category', 'name slug').lean(),
    BlogPost.countDocuments(q)
  ]);
  res.json({ success: true, data: { items, total, page, limit } });
});

export const publicPost = handler(async (req, res) => {
  const post = await BlogPost.findOneAndUpdate({ slug: String(req.params.slug).toLowerCase(), status: 'published' }, { $inc: { views: 1 } }, { new: true })
    .select('-views').populate('category', 'name slug').lean();
  if (!post) throw new HttpError(404, 'Article not found');
  const related = await BlogPost.find({ status: 'published', _id: { $ne: post._id }, ...(post.category ? { category: post.category._id } : {}) })
    .select('title slug excerpt coverImage publishedAt readMinutes category').sort({ publishedAt: -1 }).limit(3).populate('category', 'name slug').lean();
  res.json({ success: true, data: { post, related } });
});
