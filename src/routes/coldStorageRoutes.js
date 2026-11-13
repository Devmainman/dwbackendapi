import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { moneyLimiter } from '../middleware/security.js';
import { requireFeature } from '../services/productService.js';
import {
  listVaults, createVault, depositToVault, requestUnlock, cancelUnlock, releaseUnlocked, closeVault
} from '../controllers/coldStorageController.js';

const router = express.Router();
router.use(authenticate, requireFeature('coldStorage.enabled'));

router.get('/', listVaults);
router.post('/', moneyLimiter, createVault);
router.post('/:id/deposit', moneyLimiter, depositToVault);
router.post('/:id/unlock', moneyLimiter, requestUnlock);
router.post('/:id/cancel-unlock', cancelUnlock);
router.post('/:id/release', moneyLimiter, releaseUnlocked);
router.delete('/:id', closeVault);

export default router;
