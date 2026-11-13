import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { moneyLimiter } from '../middleware/security.js';
import { requireFeature } from '../services/productService.js';
import {
  listStocks, getStock, getPortfolio, getOrders, buyStock, sellStock
} from '../controllers/stockController.js';

const router = express.Router();
router.use(authenticate, requireFeature('investing.stocksEnabled'));

router.get('/', listStocks);
router.get('/portfolio', getPortfolio);
router.get('/orders', getOrders);
router.post('/buy', moneyLimiter, buyStock);
router.post('/sell', moneyLimiter, sellStock);
router.get('/:symbol', getStock); // keep last: it would shadow the routes above

export default router;
