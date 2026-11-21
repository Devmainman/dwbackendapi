// Admin management for cold storage, wallets, stocks, staking and real estate.
// Mounted at /api/admin/products
import express from 'express';
import { authenticate, isAdmin } from '../middleware/auth.js';
import Setting from '../models/Setting.js';
import { handler, getSettings } from '../services/productService.js';
import { adminListVaults, adminUpdateVault } from '../controllers/coldStorageController.js';
import { adminListWallets } from '../controllers/walletController.js';
import {
  adminListStocks, adminCreateStock, adminUpdateStock, adminBulkPrices, adminRefreshStocks, adminInstallPopular, adminDeleteStock, adminListHoldings
} from '../controllers/stockController.js';
import {
  adminListPlans, adminCreatePlan, adminUpdatePlan, adminDeletePlan, adminListPositions
} from '../controllers/stakingController.js';
import {
  adminListProperties, adminCreateProperty, adminUpdateProperty, adminDeleteProperty, adminListInvestments
} from '../controllers/realEstateController.js';

const router = express.Router();
router.use(authenticate, isAdmin);

const num = (v) => (v !== '' && v !== null && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined);

// Feature configuration
router.get('/config', handler(async (_req, res) => {
  const s = await getSettings();
  res.json({ success: true, data: { coldStorage: s.coldStorage, investing: s.investing } });
}));

router.put('/config', handler(async (req, res) => {
  const set = {};
  const { coldStorage = {}, investing = {} } = req.body || {};
  if (typeof coldStorage.enabled === 'boolean') set['coldStorage.enabled'] = coldStorage.enabled;
  if (num(coldStorage.unlockDelayHours) !== undefined) set['coldStorage.unlockDelayHours'] = num(coldStorage.unlockDelayHours);
  if (num(coldStorage.minDeposit) !== undefined) set['coldStorage.minDeposit'] = num(coldStorage.minDeposit);
  for (const k of ['stocksEnabled', 'stakingEnabled', 'realEstateEnabled', 'walletConnectEnabled']) {
    if (typeof investing[k] === 'boolean') set[`investing.${k}`] = investing[k];
  }
  const s = await Setting.findOneAndUpdate({}, { $set: set }, { new: true, upsert: true });
  res.json({ success: true, data: { coldStorage: s.coldStorage, investing: s.investing } });
}));

// Cold storage
router.get('/cold-storage', adminListVaults);
router.patch('/cold-storage/:id', adminUpdateVault);


// Wallets
router.get('/wallets', adminListWallets);

// Stocks
router.get('/stocks', adminListStocks);
router.post('/stocks', adminCreateStock);
router.post('/stocks/prices', adminBulkPrices);
router.post('/stocks/refresh', adminRefreshStocks);
router.post('/stocks/install-popular', adminInstallPopular);
router.put('/stocks/:id', adminUpdateStock);
router.delete('/stocks/:id', adminDeleteStock);
router.get('/stock-holdings', adminListHoldings);

// Staking
router.get('/staking/plans', adminListPlans);
router.post('/staking/plans', adminCreatePlan);
router.put('/staking/plans/:id', adminUpdatePlan);
router.delete('/staking/plans/:id', adminDeletePlan);
router.get('/staking/positions', adminListPositions);

// Real estate
router.get('/real-estate/properties', adminListProperties);
router.post('/real-estate/properties', adminCreateProperty);
router.put('/real-estate/properties/:id', adminUpdateProperty);
router.delete('/real-estate/properties/:id', adminDeleteProperty);
router.get('/real-estate/investments', adminListInvestments);

export default router;
