import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { moneyLimiter } from '../middleware/security.js';
import {
  listTraders, getTrader, copyTrader, listCopies, getCopy, addCopyFunds,
  pauseCopy, resumeCopy, updateCopySettings, stopCopyHandler, closePosition, getHistory,
  followTrader, unfollowTrader, getTraderTrades
} from '../controllers/copyTradingController.js';

const router = express.Router();
router.use(authenticate);

router.get('/traders', listTraders);
router.get('/traders/:traderId', getTrader);
router.get('/traders/:traderId/trades', getTraderTrades);
router.post('/traders/:traderId/follow', followTrader);
router.delete('/traders/:traderId/follow', unfollowTrader);
router.post('/copy', moneyLimiter, copyTrader);

router.get('/copies', listCopies);
router.get('/copies/:id', getCopy);
router.post('/copies/:id/add-funds', moneyLimiter, addCopyFunds);
router.post('/copies/:id/pause', pauseCopy);
router.post('/copies/:id/resume', resumeCopy);
router.put('/copies/:id/settings', updateCopySettings);
router.post('/copies/:id/stop', moneyLimiter, stopCopyHandler);

router.post('/positions/:id/close', moneyLimiter, closePosition);
router.get('/history', getHistory);

// Older client paths
router.get('/my-copies', listCopies);
router.post('/stop', moneyLimiter, stopCopyHandler); // { copyTradeId }

export default router;
