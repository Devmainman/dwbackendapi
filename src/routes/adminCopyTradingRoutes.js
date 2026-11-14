// Mounted at /api/admin/copy-trading. The same handlers are also exposed under
// the older /api/admin/traders paths (see legacyTraderRouter) so existing admin
// screens keep working.
import express from 'express';
import { authenticate, isAdmin } from '../middleware/auth.js';
import * as c from '../controllers/adminCopyTradingController.js';

const router = express.Router();
router.use(authenticate, isAdmin);

// Traders
router.get('/traders', c.getAllTraders);
router.post('/traders', c.createTrader);
router.get('/export', c.exportTraders);
router.get('/traders/:traderId', c.getTraderDetails);
router.get('/traders/:traderId/analytics', c.getTraderAnalytics);
router.put('/traders/:traderId/profile', c.updateTraderProfile);
router.put('/traders/:traderId/settings', c.updateTraderSettings);
router.put('/traders/:traderId/status', c.updateTraderStatus);
router.put('/traders/:traderId/verification', c.updateTraderVerification);
router.post('/traders/:traderId/avatar', c.uploadTraderAvatar);
router.post('/traders/:traderId/recompute', c.recomputeStats);
router.delete('/traders/:traderId', c.deleteTrader);

// Trader's trades (opening/closing here is mirrored to every copier)
router.get('/traders/:traderId/trades', c.getTraderTrades);
router.post('/traders/:traderId/trades', c.addTradeToTrader);
router.post('/traders/:traderId/trades/bulk', c.bulkAddTrades);
router.put('/traders/:traderId/trades/:tradeId', c.updateTraderTrade);
router.post('/traders/:traderId/trades/:tradeId/close', c.closeTraderTrade);
router.delete('/traders/:traderId/trades/:tradeId', c.deleteTraderTrade);
router.post('/prices', c.updatePrices);

// Copiers & positions
router.get('/traders/:traderId/copiers', c.getTraderCopiers);
router.get('/copies', c.getAllCopies);
router.post('/copy-trades/:copyId/suspend', c.suspendCopyTrader);
router.post('/copy-trades/:copyId/resume', c.resumeCopyTrader);
router.post('/copy-trades/:copyId/force-stop', c.forceStopCopyTrade);
router.get('/positions', c.getAllPositions);
router.get('/copied-trades/all', c.getAllPositions);
router.get('/platform/stats', c.getPlatformCopyStats);
router.get('/copied-trades/stats', c.getPlatformCopyStats);

export default router;

/** Older admin paths under /api/admin/traders. */
export const legacyTraderRouter = express.Router();
legacyTraderRouter.use(authenticate, isAdmin);
legacyTraderRouter.post('/add-trade', c.addTradeToTrader);                    // { traderId, symbol, side, entryPrice, ... }
legacyTraderRouter.post('/update-prices', c.updatePrices);
legacyTraderRouter.post('/:traderId/close-trade/:tradeId', c.closeTraderTrade);
legacyTraderRouter.get('/:traderId/open-trades', c.getTraderOpenTrades);
legacyTraderRouter.get('/:traderId/trades', c.getTraderTrades);
legacyTraderRouter.post('/:traderId/trades/bulk', c.bulkAddTrades);
legacyTraderRouter.post('/:traderId/trades', c.addTradeToTrader);
legacyTraderRouter.put('/:traderId/trades/:tradeId', c.updateTraderTrade);
legacyTraderRouter.delete('/:traderId/trades/:tradeId', c.deleteTraderTrade);
