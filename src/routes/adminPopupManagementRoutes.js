// routes/adminPopupManagementRoutes.js
import express from 'express';
import {
  getPopupAssignments,
  toggleAssignmentStatus,
  deleteAssignment,
  getUserPopupAssignments
} from '../controllers/adminPopupManagementController.js';

import { authenticate, isAdmin } from '../middleware/auth.js';

const router = express.Router();
router.use(authenticate, isAdmin);

// Popup assignments management
router.get('/popup-assignments', getPopupAssignments);
router.patch('/popup-assignments/:id/toggle-status', toggleAssignmentStatus);
router.delete('/popup-assignments/:id', deleteAssignment);
router.get('/users/:userId/popup-assignments', getUserPopupAssignments);

export default router;