// Older /api/copied-trades paths, now served by the new copy-trading engine.
import express from 'express';
import { authenticate, isAdmin } from '../middleware/auth.js';
import { getHistory, closePosition } from '../controllers/copyTradingController.js';
import { getAllPositions, getPlatformCopyStats, exportCopies } from '../controllers/adminCopyTradingController.js';

const router = express.Router();

router.get('/admin/all', authenticate, isAdmin, getAllPositions);
router.get('/admin/stats', authenticate, isAdmin, getPlatformCopyStats);
router.get('/admin/export', authenticate, isAdmin, exportCopies);

router.get('/user', authenticate, getHistory);
router.post('/user/:id/close', authenticate, closePosition);

export default router;
