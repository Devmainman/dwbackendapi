import express from 'express';
import { authenticate, isAdmin } from '../middleware/auth.js';
import {
  adminListCategories, adminSaveCategory, adminDeleteCategory,
  adminListPosts, adminGetPost, adminSavePost, adminDeletePost,
  publicCategories, publicPosts, publicPost
} from '../controllers/blogController.js';

/* Public: /api/public/blog (no login) */
export const publicBlogRouter = express.Router();
publicBlogRouter.get('/categories', publicCategories);
publicBlogRouter.get('/posts', publicPosts);
publicBlogRouter.get('/posts/:slug', publicPost);

/* Admin: /api/admin/blog */
export const adminBlogRouter = express.Router();
adminBlogRouter.use(authenticate, isAdmin);
adminBlogRouter.get('/categories', adminListCategories);
adminBlogRouter.post('/categories', adminSaveCategory);
adminBlogRouter.put('/categories/:id', adminSaveCategory);
adminBlogRouter.delete('/categories/:id', adminDeleteCategory);
adminBlogRouter.get('/posts', adminListPosts);
adminBlogRouter.get('/posts/:id', adminGetPost);
adminBlogRouter.post('/posts', adminSavePost);
adminBlogRouter.put('/posts/:id', adminSavePost);
adminBlogRouter.delete('/posts/:id', adminDeletePost);
