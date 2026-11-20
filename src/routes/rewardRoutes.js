import express from 'express';
import { authenticate, isAdmin } from '../middleware/auth.js';
import { moneyLimiter } from '../middleware/security.js';
import {
  userRewards, userClaim, userPayFee, userCancelClaim,
  adminGetProgram, adminUpdateProgram, adminCreateMilestone, adminUpdateMilestone, adminDeleteMilestone,
  adminListClaims, adminGetClaim, adminDecideClaim
} from '../controllers/rewardController.js';

/* User: /api/rewards */
export const rewardRouter = express.Router();
rewardRouter.use(authenticate);
rewardRouter.get('/', userRewards);
rewardRouter.post('/milestones/:id/claim', moneyLimiter, userClaim);
rewardRouter.post('/claims/:id/pay', moneyLimiter, userPayFee);
rewardRouter.post('/claims/:id/cancel', userCancelClaim);

/* Admin: /api/admin/rewards (program + milestones) */
export const adminRewardRouter = express.Router();
adminRewardRouter.use(authenticate, isAdmin);
adminRewardRouter.get('/', adminGetProgram);
adminRewardRouter.put('/program', adminUpdateProgram);
adminRewardRouter.post('/milestones', adminCreateMilestone);
adminRewardRouter.put('/milestones/:id', adminUpdateMilestone);
adminRewardRouter.delete('/milestones/:id', adminDeleteMilestone);

/* Admin: /api/admin/reward-invoices */
export const adminRewardInvoiceRouter = express.Router();
adminRewardInvoiceRouter.use(authenticate, isAdmin);
adminRewardInvoiceRouter.get('/', adminListClaims);
adminRewardInvoiceRouter.get('/:id', adminGetClaim);
adminRewardInvoiceRouter.patch('/:id/:decision', adminDecideClaim);
