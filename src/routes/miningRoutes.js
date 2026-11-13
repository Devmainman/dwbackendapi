import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { moneyLimiter } from '../middleware/security.js';
import {
  getCatalog, startMining, stopMining, getMiningStats, getEquipment, purchaseEquipment, getRewards, claimRewards,
  getBoosters, activateBooster, getMiningHistory, getPools, switchPool, activateEquipment, activateAllEquipment
} from '../controllers/miningController.js';

const router = express.Router();
router.use(authenticate);

router.get('/catalog', getCatalog);
router.get('/stats', getMiningStats);
router.post('/start', startMining);
router.post('/stop', stopMining);
router.get('/equipment', getEquipment);
router.post('/purchase-equipment', moneyLimiter, purchaseEquipment);
router.post('/activate-equipment', activateEquipment);
router.post('/activate-all-equipment', activateAllEquipment);
router.get('/rewards', getRewards);
router.post('/claim-rewards', moneyLimiter, claimRewards);
router.get('/boosters', getBoosters);
router.post('/activate-booster', moneyLimiter, activateBooster);
router.get('/history', getMiningHistory);
router.get('/pools', getPools);
router.post('/switch-pool', switchPool);

export default router;
