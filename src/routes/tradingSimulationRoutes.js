// Live market trading. Mounted at /api/trading/market (and at the older /api/trading/sim path).
import express from 'express';
import { moneyLimiter } from '../middleware/security.js';
import {
  quotes, openPosition, closePosition, updateStops, listPositions, listHistory
} from '../controllers/marketTradingController.js';

const router = express.Router();

router.get('/quotes', quotes);
router.post('/open', moneyLimiter, openPosition);
router.get('/positions', listPositions);
router.get('/history', listHistory);
router.post('/positions/:id/close', moneyLimiter, closePosition);
router.patch('/positions/:id', updateStops);

// Older client paths
router.post('/buy', moneyLimiter, (req, res, next) => { req.body.side = 'buy'; next(); }, openPosition);
router.post('/sell/:id', moneyLimiter, closePosition);
router.get('/positions/realtime', listPositions);

export default router;
