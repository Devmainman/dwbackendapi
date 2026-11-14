import express from 'express';
import { authenticate, isAdmin } from '../middleware/auth.js';
import {
  createSignalInvoice,
  getSignalInvoices,
  updateSignalInvoiceStatus,
  controlSignal,
  renewSignal,
  deleteSignalInvoice
} from '../controllers/signalInvoiceController.js';

const router = express.Router();

// User
router.post('/', authenticate, createSignalInvoice);

// Admin
router.get('/admin', authenticate, isAdmin, getSignalInvoices);
router.patch('/admin/:id/status', authenticate, isAdmin, updateSignalInvoiceStatus);
router.patch('/admin/:id/reject', authenticate, isAdmin, (req, res) => { req.body = { ...(req.body || {}), action: 'reject' }; return updateSignalInvoiceStatus(req, res); });
router.patch('/admin/:id/signal', authenticate, isAdmin, controlSignal);
router.post('/admin/:id/renew', authenticate, isAdmin, renewSignal);
router.delete('/admin/:id', authenticate, isAdmin, deleteSignalInvoice);

export default router;
