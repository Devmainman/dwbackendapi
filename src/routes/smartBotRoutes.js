import express from 'express';
import { authenticate, isAdmin } from '../middleware/auth.js';
import { moneyLimiter } from '../middleware/security.js';
import {
  userBots, userSubscriptions, userSubscribe, userPaySubscription, userCancelSubscription,
  adminListBots, adminCreateBot, adminUpdateBot,
  adminListSubscriptions, adminGetSubscription, adminDecideSubscription
} from '../controllers/smartBotController.js';

/* User: /api/smart-bots */
export const smartBotRouter = express.Router();
smartBotRouter.use(authenticate);
smartBotRouter.get('/', userBots);
smartBotRouter.get('/subscriptions', userSubscriptions);
smartBotRouter.post('/subscriptions/:id/pay', moneyLimiter, userPaySubscription);
smartBotRouter.post('/subscriptions/:id/cancel', userCancelSubscription);
smartBotRouter.post('/:id/subscribe', moneyLimiter, userSubscribe);

/* Admin: /api/admin/smart-bots (setup) and /api/admin/bot-invoices (subscriptions) */
export const adminSmartBotRouter = express.Router();
adminSmartBotRouter.use(authenticate, isAdmin);
adminSmartBotRouter.get('/', adminListBots);
adminSmartBotRouter.post('/', adminCreateBot);
adminSmartBotRouter.put('/:id', adminUpdateBot);

export const adminBotInvoiceRouter = express.Router();
adminBotInvoiceRouter.use(authenticate, isAdmin);
adminBotInvoiceRouter.get('/', adminListSubscriptions);
adminBotInvoiceRouter.get('/:id', adminGetSubscription);
adminBotInvoiceRouter.patch('/:id/:decision', adminDecideSubscription);
