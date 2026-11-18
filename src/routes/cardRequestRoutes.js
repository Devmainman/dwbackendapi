import express from 'express';
import { authenticate, isAdmin } from '../middleware/auth.js';
import { moneyLimiter } from '../middleware/security.js';
import {
  userCatalog, userRequests, userCreateRequest, userSubmitPayment, userCancelRequest,
  adminListProducts, adminCreateProduct, adminUpdateProduct,
  adminListRequests, adminGetRequest, adminDecidePayment
} from '../controllers/cardRequestController.js';

/* User: /api/card-requests (+ /api/card-requests/catalog) */
export const cardRequestRouter = express.Router();
cardRequestRouter.use(authenticate);
cardRequestRouter.get('/catalog', userCatalog);
cardRequestRouter.get('/', userRequests);
cardRequestRouter.post('/', moneyLimiter, userCreateRequest);
cardRequestRouter.post('/:id/pay/:which', moneyLimiter, userSubmitPayment);
cardRequestRouter.post('/:id/cancel', userCancelRequest);

/* Admin: /api/admin/card-settings and /api/admin/card-invoices */
export const adminCardSettingsRouter = express.Router();
adminCardSettingsRouter.use(authenticate, isAdmin);
adminCardSettingsRouter.get('/', adminListProducts);
adminCardSettingsRouter.post('/', adminCreateProduct);
adminCardSettingsRouter.put('/:id', adminUpdateProduct);

export const adminCardInvoicesRouter = express.Router();
adminCardInvoicesRouter.use(authenticate, isAdmin);
adminCardInvoicesRouter.get('/', adminListRequests);
adminCardInvoicesRouter.get('/:id', adminGetRequest);
adminCardInvoicesRouter.patch('/:id/:which/:decision', adminDecidePayment);
