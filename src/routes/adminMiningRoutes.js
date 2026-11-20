// routes/adminMiningRoutes.js
import express from 'express';
import { authenticate, isAdmin } from '../middleware/auth.js';
import {
  getMiningStats,
  getAllUsersMiningStats,
  getAllMiningSessions,
  getAllMiningRewards,
  getAllMiningEquipment,
  getAllMiningPools,
  getAllMiningBoosters,
  updateMiningPool,
  createMiningPool,
  deleteMiningPool,
  updateUserMiningSettings,
  deleteMiningSession,
  deleteMiningReward,
  deleteMiningEquipment,
  getMiningAnalytics,
  exportMiningData
} from '../controllers/adminMiningController.js';

const router = express.Router();

// Middleware - all routes require admin authentication
router.use(authenticate);
router.use(isAdmin);

// Dashboard stats
router.get('/stats', getMiningStats);

// User mining statistics
router.get('/users/stats', getAllUsersMiningStats);

// Mining sessions management
router.get('/sessions', getAllMiningSessions);
router.delete('/sessions/:id', deleteMiningSession);

// Mining rewards management
router.get('/rewards', getAllMiningRewards);
router.delete('/rewards/:id', deleteMiningReward);

// Mining equipment management
router.get('/equipment', getAllMiningEquipment);
router.delete('/equipment/:id', deleteMiningEquipment);

// Mining pools management
router.get('/pools', getAllMiningPools);
router.post('/pools', createMiningPool);
router.put('/pools/:id', updateMiningPool);
router.delete('/pools/:id', deleteMiningPool);

// Mining boosters management
router.get('/boosters', getAllMiningBoosters);

// User mining settings
router.put('/users/:userId/mining-settings', updateUserMiningSettings);

// Analytics
router.get('/analytics', getMiningAnalytics);

// Data export
router.get('/export', exportMiningData);

export default router;