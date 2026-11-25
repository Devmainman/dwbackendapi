import express from 'express';
import { authenticate, isAdmin } from '../middleware/auth.js';
import { moneyLimiter } from '../middleware/security.js';
import {
  publicCoins, userWallets, markets, sparklines, history, depositOptions, createDeposit, userDeposits, convertQuote, convert,
  adminAssets, adminUpdateAsset, adminBulkAssets, adminUpdateSettings, adminDeposits, adminDecideDeposit, adminUserWallets
} from '../controllers/cryptoController.js';

/* Public: /api/public/crypto (landing page) */
export const publicCryptoRouter = express.Router();
publicCryptoRouter.get('/', publicCoins);

/* User: /api/crypto */
export const cryptoRouter = express.Router();
cryptoRouter.use(authenticate);
cryptoRouter.get('/wallets', userWallets);
cryptoRouter.get('/sparklines', sparklines);
cryptoRouter.get('/markets', markets);
cryptoRouter.get('/history', history);
cryptoRouter.get('/deposit-options', depositOptions);
cryptoRouter.get('/deposits', userDeposits);
cryptoRouter.post('/deposits', moneyLimiter, createDeposit);
cryptoRouter.post('/convert/quote', convertQuote);
cryptoRouter.post('/convert', moneyLimiter, convert);

/* Admin: /api/admin/crypto */
export const adminCryptoRouter = express.Router();
adminCryptoRouter.use(authenticate, isAdmin);
adminCryptoRouter.get('/assets', adminAssets);
adminCryptoRouter.post('/assets/bulk', adminBulkAssets);
adminCryptoRouter.put('/assets/:symbol', adminUpdateAsset);
adminCryptoRouter.put('/settings', adminUpdateSettings);
adminCryptoRouter.get('/deposits', adminDeposits);
adminCryptoRouter.patch('/deposits/:id/:decision', adminDecideDeposit);
adminCryptoRouter.get('/users/:id/wallets', adminUserWallets);
