import express from 'express';
import { authenticate, isAdmin } from '../middleware/auth.js';
import {
  adminListCategories, adminSaveCategory, adminDeleteCategory,
  adminListItems, adminSaveItem, adminDeleteItem,
  publicCategories, publicCategory, publicSearch
} from '../controllers/faqController.js';

/* Public: /api/public/faq (no login) */
export const publicFaqRouter = express.Router();
publicFaqRouter.get('/categories', publicCategories);
publicFaqRouter.get('/categories/:slug', publicCategory);
publicFaqRouter.get('/search', publicSearch);

/* Admin: /api/admin/faq */
export const adminFaqRouter = express.Router();
adminFaqRouter.use(authenticate, isAdmin);
adminFaqRouter.get('/categories', adminListCategories);
adminFaqRouter.post('/categories', adminSaveCategory);
adminFaqRouter.put('/categories/:id', adminSaveCategory);
adminFaqRouter.delete('/categories/:id', adminDeleteCategory);
adminFaqRouter.get('/items', adminListItems);
adminFaqRouter.post('/items', adminSaveItem);
adminFaqRouter.put('/items/:id', adminSaveItem);
adminFaqRouter.delete('/items/:id', adminDeleteItem);
