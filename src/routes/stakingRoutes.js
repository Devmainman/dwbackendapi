import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { moneyLimiter } from '../middleware/security.js';
import { requireFeature } from '../services/productService.js';
import {
  listPlans, listPositions, stake, claimRewards, unstake
} from '../controllers/stakingController.js';

const router = express.Router();
router.use(authenticate, requireFeature('investing.stakingEnabled'));

router.get('/pools', listPlans);
router.get('/history', listPositions);
router.post('/stake', moneyLimiter, stake);
router.post('/positions/:id/claim', moneyLimiter, claimRewards);
router.post('/positions/:id/unstake', moneyLimiter, unstake);

// Older paths
router.get('/plans', listPlans);
router.get('/positions', listPositions);

export default router;
