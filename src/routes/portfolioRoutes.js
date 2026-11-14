import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { getSummary, getHoldings } from '../controllers/portfolioController.js';

const router = express.Router();
router.get('/summary', authenticate, getSummary);
router.get('/holdings', authenticate, getHoldings);

export default router;
