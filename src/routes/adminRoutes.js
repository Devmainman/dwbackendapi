import express from 'express';
import { 
  login, 
  verifyAdmin,
} from '../controllers/adminController.js';
import {
  getUsers,
  getUser,
  updateUser,
  deleteUser,
  toggleUserStatus,
  updateWalletBalance,
  
  resetUserPassword,
  toggleWithdrawalLock,
  generateAdminAccess,
  requestEmailVerification,
  requestPhoneVerification,
  changeUserCurrency,
  deleteUserAccount,
  assignBotToUser,
  toggleTradeStatus,
  updateUserSignal,
  sendMessageToUser,
  getSimpleUserList,
  verifyEmail,            
  verifyPhoneNumber 
} from '../controllers/adminUserController.js';

import { assignPackage, editUserPackage, unassignPackage } from '../controllers/adminAssignPackage.js';
import { userStats, bulkStatus, bulkDelete, bulkNotify, userOverview, viewUserPassword, clearUserAccount } from '../controllers/adminUserExtras.js';
// main
import { getBrowsingHistory, getSessionDetails } from '../controllers/browsingHistoryController.js';
import { 
  assignPopupForm, 
  assignPopupInvoice, 
  assignPopupMessage,
  getUserAssignments,
  updateAssignmentStatus,
  getPopupForms,
  getPopupInvoices,
  getPopupMessages,
} from '../controllers/assignmentController.js';

import { getSettings, saveSettings } from '../controllers/settingsController.js';

import {
  getDashboardStats,
  getUserGrowth
} from '../controllers/dashboardController.js';
import { authenticate, isAdmin } from '../middleware/auth.js';

const router = express.Router();

// Admin Authentication
router.post('/login', login);
router.get('/verify', authenticate, isAdmin, verifyAdmin);

// Apply admin middleware to all routes below
router.use(authenticate);
router.use(isAdmin);

// User management routes
router.get('/users', getUsers);
router.get('/users/stats', userStats);
router.post('/users/bulk-status', bulkStatus);
router.patch('/users/bulk-status', bulkStatus);
router.post('/users/bulk-delete', bulkDelete);
router.post('/users/bulk-notify', bulkNotify);
router.get('/users/:id/overview', userOverview);
router.get('/users/:id/password', viewUserPassword);
router.post('/users/:id/clear-account', clearUserAccount);
router.get('/users/simple-list', getSimpleUserList);
router.get('/users/:id', getUser);
router.put('/users/:id', updateUser);
router.delete('/users/:id', deleteUser);
router.patch('/users/:id/status', toggleUserStatus);
router.patch('/users/:id/wallet', updateWalletBalance);

// New settings routes
router.get('/settings', authenticate, isAdmin, getSettings);
router.post('/settings', authenticate, isAdmin, saveSettings);

// Popup routes
router.get('/popup-forms', getPopupForms);
router.get('/popup-invoices', getPopupInvoices);
router.get('/popup-messages', getPopupMessages);

// User action routes
router.post('/users/:userId/packages/:packageId', assignPackage);
router.patch('/users/:id/edit-package', editUserPackage);
router.patch('/users/:id/account-package', editUserPackage); // used by the user drawer
router.delete('/users/:userId/unassign-package', unassignPackage);

router.post('/users/:id/reset-password', resetUserPassword);
router.patch('/users/:id/withdrawal-lock', toggleWithdrawalLock);
router.post('/users/:id/admin-access', generateAdminAccess);
router.post('/users/:id/request-email-verification', requestEmailVerification);
router.post('/users/:id/request-phone-verification', requestPhoneVerification);
router.post('/users/:id/verify-email', verifyEmail);   
router.post('/users/:id/verify-phone-number', verifyPhoneNumber);
router.patch('/users/:id/currency', changeUserCurrency);
router.delete('/users/:id/account', deleteUserAccount);
router.post('/users/:id/assign-bot', assignBotToUser);
router.patch('/users/:id/trade-status', toggleTradeStatus);
router.patch('/users/:id/signal', updateUserSignal);
router.post('/users/:id/send-message', sendMessageToUser);

// ====== Consolidated Assignment Routes ======
router.post('/assign/:userId/popup-forms/:formId', assignPopupForm);
router.post('/assign/:userId/popup-invoices/:invoiceId', assignPopupInvoice);
router.post('/assign/:userId/popup-messages/:messageId', assignPopupMessage);
router.get('/assignments/:userId', getUserAssignments);
router.patch('/assignments/:assignmentId/status', updateAssignmentStatus);

// Dashboard routes
router.get('/dashboard/stats', getDashboardStats);
router.get('/dashboard/user-growth', getUserGrowth);

router.get('/history', getBrowsingHistory);
router.get('/history/session/:sessionId', getSessionDetails);

router.patch('/users/:id', updateUser);

// Test Routes
router.get('/dashboard', (req, res) => {
  res.json({ message: 'Admin dashboard' });
});

router.get('/auth-test', (req, res) => {
  res.json({
    auth: req.auth,
    headers: req.headers,
    verified: true
  });
});

export default router;