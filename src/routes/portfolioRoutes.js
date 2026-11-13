import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { getSummary } from '../controllers/portfolioController.js';

const router = express.Router();
router.get('/summary', authenticate, getSummary);

export default router;
