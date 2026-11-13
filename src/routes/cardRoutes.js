import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { moneyLimiter } from '../middleware/security.js';
import { requireFeature } from '../services/productService.js';
import {
  listCards, requestCard, fundCard, unloadCard, setFrozen, setLimit, cancelCard
} from '../controllers/cardController.js';

const router = express.Router();
router.use(authenticate, requireFeature('cards.enabled'));

router.get('/', listCards);
router.post('/', moneyLimiter, requestCard);
router.post('/:id/fund', moneyLimiter, fundCard);
router.post('/:id/unload', moneyLimiter, unloadCard);
router.patch('/:id/freeze', setFrozen);
router.patch('/:id/limit', setLimit);
router.delete('/:id', moneyLimiter, cancelCard);

export default router;
