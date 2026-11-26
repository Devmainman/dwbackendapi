// routes/userRoutes.js
import express from 'express';
import multer from 'multer';
import bodyParser from 'body-parser';
import { authenticate } from '../middleware/auth.js';
import Currency from '../models/Currency.js';
import { switchUserCurrency } from '../utils/wallet.js';
import User from '../models/User.js';
import { signup, login, getCurrentUser, changePassword, submitPopupForm, payPopupInvoice, getUserAssignments, refreshSession } from '../controllers/userController.js';
import { forgotPassword, resetPassword } from '../controllers/passwordResetController.js';
import { getActivePopup, completePopup, getAvailablePopupForms, getAvailablePopupInvoices, acknowledgePopupMessage, getAvailablePopupMessages } from '../controllers/popupController.js';
import { markPackageUpgradeStarted } from '../controllers/userController.js';

const router = express.Router();


// Create a custom form parser
const parseFormData = (req, res, next) => {
  // Check if we should expect multipart data
  const isMultipart = req.headers['content-type']?.includes('multipart/form-data');
  
  if (!isMultipart) {
    // Handle JSON directly
    return bodyParser.json()(req, res, next);
  }

  // Configure multer
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 5 * 1024 * 1024, // 5MB
      fields: 100,
      files: 10
    }
  }).any(); // Accept any files

  // Parse with multer
  upload(req, res, (err) => {
    if (err) {
      console.error('Multer error:', err);
      // Try to parse as JSON instead
      req.files = [];
      return bodyParser.json()(req, res, (jsonErr) => {
        if (jsonErr) {
          console.error('JSON parse error:', jsonErr);
          return res.status(400).json({ 
            success: false, 
            message: 'Invalid request format' 
          });
        }
        next();
      });
    }
    next();
  });
};




// User authentication routes
router.post('/signup', parseFormData, signup);
router.post('/login', login);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);
router.post('/refresh', refreshSession);
router.get('/me', authenticate, getCurrentUser);
router.post('/change-password', authenticate, changePassword);

router.post('/logout', authenticate, (req, res) => {
  return res.json({
    success: true,
    message: 'Logged out'
  });
});

router.post('/package-upgrade/start', authenticate, markPackageUpgradeStarted);

// Popup routes
router.get('/popups/active', authenticate, getActivePopup);
router.post('/popups/:id/complete', authenticate, completePopup);

// Form submission route with enhanced parsing
router.post(
  '/popup-forms/:formId/submit',
  authenticate,
  parseFormData,
  (req, res, next) => {
    // Debug middleware
    console.log('Received submission:', {
      params: req.params,
      body: req.body,
      files: req.files?.map(f => ({
        fieldname: f.fieldname,
        originalname: f.originalname,
        size: f.size
      })),
      user: req.user
    });

    // Ensure assignmentId exists
    if (!req.body.assignmentId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing assignment ID' 
      });
    }

    next();
  },
  submitPopupForm
);

// Other routes remain unchanged
router.post('/popup-invoices/:invoiceId/pay', authenticate, payPopupInvoice); 
router.post('/popup-messages/:assignmentId/acknowledge', authenticate, acknowledgePopupMessage);
router.get('/assignments', authenticate, getUserAssignments);
router.get('/popups/available/forms', authenticate, getAvailablePopupForms);
router.get('/popups/available/invoices', authenticate, getAvailablePopupInvoices);
router.get('/popups/available/messages', authenticate, getAvailablePopupMessages);

router.put('/preferences', authenticate, async (req, res) => {
  try {
    const code = String(req.body?.currency || '').toUpperCase();
    const target = await Currency.findOne({ code, status: 'Enabled' }).select('code').lean();
    if (!target) return res.status(400).json({ success: false, message: 'Invalid currency code' });
    const r = await switchUserCurrency(req.user.id, code, { by: 'user' });
    res.json({ success: true, message: 'Currency and balance updated', currency: r.user.currency, balance: r.user.balance, rate: r.rate });
  } catch (err) {
    const status = err.status && err.status < 500 ? err.status : 500;
    if (status === 500) console.error('preferences error', err);
    res.status(status).json({ success: false, message: status === 500 ? 'Could not change currency' : err.message });
  }
});

router.get('/currencies', async (req, res) => {
  const currencies = await Currency.find({ status: 'Enabled' }).select('title code');
  res.json({ success: true, data: currencies });
});



export default router;