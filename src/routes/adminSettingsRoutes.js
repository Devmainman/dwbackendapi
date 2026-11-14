import express from 'express';
import { authenticate, isAdmin } from '../middleware/auth.js';
import {
  getCurrencySettings,
  updateCurrencySettings,
  getAppearanceSettings,
  updateAppearanceSettings
} from '../controllers/adminSettingsController.js';

const router = express.Router();

router.get('/currency', authenticate, isAdmin, getCurrencySettings);
router.put('/currency', authenticate, isAdmin, updateCurrencySettings);
router.get('/appearance', authenticate, isAdmin, getAppearanceSettings);
router.put('/appearance', authenticate, isAdmin, updateAppearanceSettings);

export default router;
