import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { moneyLimiter } from '../middleware/security.js';
import { requireFeature } from '../services/productService.js';
import {
  listProperties, getProperty, invest, listInvestments, claimIncome, redeem
} from '../controllers/realEstateController.js';

const router = express.Router();
router.use(authenticate, requireFeature('investing.realEstateEnabled'));

router.get('/projects', listProperties);           // ?status=open|closed
router.get('/projects/:id', getProperty);           // id or slug
router.post('/projects/:id/invest', moneyLimiter, invest);
router.get('/investments', listInvestments);
router.post('/investments/:id/claim', moneyLimiter, claimIncome);
router.post('/investments/:id/redeem', moneyLimiter, redeem);

// Older paths
router.get('/properties', listProperties);
router.get('/properties/:id', getProperty);
router.post('/properties/:id/invest', moneyLimiter, invest);

export default router;
