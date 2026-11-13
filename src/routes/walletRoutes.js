import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { authLimiter } from '../middleware/security.js';
import { requireFeature } from '../services/productService.js';
import {
  listWallets, createNonce, connectWallet, addWatchWallet, updateWallet, removeWallet
} from '../controllers/walletController.js';

const router = express.Router();
router.use(authenticate, requireFeature('investing.walletConnectEnabled'));

router.get('/', listWallets);
router.post('/nonce', authLimiter, createNonce);
router.post('/connect', authLimiter, connectWallet);
router.post('/watch', addWatchWallet);
router.patch('/:id', updateWallet);
router.delete('/:id', removeWallet);

export default router;
