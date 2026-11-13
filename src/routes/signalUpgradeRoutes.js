import express from 'express';
import { authenticate, isAdmin } from '../middleware/auth.js';
import {
  createSignalUpgrade,
  approveSignalUpgrade
} from '../controllers/signalUpgradeController.js';

const router = express.Router();

/* USER */
router.post('/upgrade', authenticate, createSignalUpgrade);

/* ADMIN */
router.patch('/admin/:id/approve', authenticate, isAdmin, approveSignalUpgrade);

export default router;
