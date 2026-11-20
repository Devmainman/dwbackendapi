import express from 'express';
import { authenticate, isAdmin } from '../middleware/auth.js';
import { moneyLimiter, cardSecretLimiter } from '../middleware/security.js';
import {
  userCatalog, userRequests, userCreateRequest, userSubmitPayment, userCancelRequest,
  userCardDetails, userSetPin, userChangePin,
  adminListProducts, adminCreateProduct, adminUpdateProduct,
  adminListRequests, adminGetRequest, adminDecidePayment,
  adminGenerateCardDetails, adminRevealCard, adminIssueCard, adminSetCardStatus
} from '../controllers/cardRequestController.js';

/* User: /api/card-requests (+ /api/card-requests/catalog) */
export const cardRequestRouter = express.Router();
cardRequestRouter.use(authenticate);
cardRequestRouter.get('/catalog', userCatalog);
cardRequestRouter.get('/', userRequests);
cardRequestRouter.post('/', moneyLimiter, userCreateRequest);
cardRequestRouter.post('/:id/pay/:which', moneyLimiter, userSubmitPayment);
cardRequestRouter.post('/:id/cancel', userCancelRequest);
cardRequestRouter.get('/:id/details', cardSecretLimiter, userCardDetails);
cardRequestRouter.post('/:id/pin', cardSecretLimiter, userSetPin);
cardRequestRouter.put('/:id/pin', cardSecretLimiter, userChangePin);

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
adminCardInvoicesRouter.post('/:id/card/generate', adminGenerateCardDetails);
adminCardInvoicesRouter.get('/:id/card/reveal', adminRevealCard);
adminCardInvoicesRouter.put('/:id/card', adminIssueCard);
adminCardInvoicesRouter.patch('/:id/card/status', adminSetCardStatus);
adminCardInvoicesRouter.patch('/:id/:which/:decision', adminDecidePayment);
