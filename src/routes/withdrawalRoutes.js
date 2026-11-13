// routes/withdrawalRoutes.js
import express from 'express';
import { 
  createWithdrawal,
  getUserWithdrawals,
  updateWithdrawalStatus
} from '../controllers/WithdrawalController.js';
import { authenticate, isAdmin } from '../middleware/auth.js';

const router = express.Router();

// Protected routes
router.use(authenticate);

router.post('/', createWithdrawal);
router.get('/', getUserWithdrawals);
router.put('/:id/status', isAdmin, updateWithdrawalStatus); // admin only

export default router;