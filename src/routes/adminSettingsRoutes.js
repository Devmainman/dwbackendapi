import express from 'express';
import { authenticate, isAdmin } from '../middleware/auth.js';
import {
  getCurrencySettings,
  updateCurrencySettings
} from '../controllers/adminSettingsController.js';

const router = express.Router();

router.get('/currency', authenticate, isAdmin, getCurrencySettings);
router.put('/currency', authenticate, isAdmin, updateCurrencySettings);

export default router;
