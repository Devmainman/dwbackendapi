import SignalInvoice from '../models/SignalInvoice.js';
import User from '../models/User.js';
import path from 'path';
import fs from 'fs';

/* ================= USER CREATES SIGNAL INVOICE ================= */

export const createSignalInvoice = async (req, res) => {
  try {
    const { signalPackage, signalType, duration, amount, currency, paymentMethod } = req.body;

    if (!req.files?.paymentProof) {
      return res.status(400).json({ success: false, message: 'Payment proof required' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const uploadDir = path.join('uploads/signals');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    const file = req.files.paymentProof;
    const fileName = `signal-proof-${Date.now()}-${file.name}`;
    const filePath = path.join(uploadDir, fileName);
    await file.mv(filePath);

    const invoice = new SignalInvoice({
      user: user._id,
      userSnapshot: {
        accountId: user.accountId,
        fullName: user.fullName,
        email: user.email
      },
      signalPackage,
      signalType,
      duration,
      amount,
      currency,
      paymentMethod,
      paymentProof: `/${filePath}`
    });

    await invoice.save();

    res.status(201).json({ success: true, invoice });

  } catch (err) {
    console.error('Create signal invoice error:', err);
    res.status(500).json({ success: false, message: 'Server error creating signal invoice' });
  }
};

/* ================= ADMIN FETCH ALL ================= */

export const getSignalInvoices = async (req, res) => {
  try {
    const invoices = await SignalInvoice.find()
      .sort({ createdAt: -1 })
      .lean();

    const formatted = invoices.map(inv => ({
      id: inv._id,
      date: inv.createdAt,
      signalPackage: inv.signalPackage,
      signalType: inv.signalType,
      duration: inv.duration,
      accountId: inv.userSnapshot.accountId,
      fullName: inv.userSnapshot.fullName,
      paymentMethod: inv.paymentMethod,
      amount: `${inv.amount} ${inv.currency}`,
      status: inv.status,
      paymentProof: inv.paymentProof,
      receipt: inv.receipt,
      signalStatus: inv.signalStatus,
      lastSignal: inv.lastSignal,
      successRate: inv.successRate,
      renewalDate: inv.renewalDate,
      disputed: inv.status === 'disputed',
      disputeReason: inv.disputeReason
    }));

    res.json({ success: true, invoices: formatted });

  } catch (err) {
    console.error('Get signal invoices error:', err);
    res.status(500).json({ success: false, message: 'Server error fetching signal invoices' });
  }
};

/* ================= ADMIN UPDATE STATUS ================= */

export const updateSignalInvoiceStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { action, disputeReason } = req.body;

    const invoice = await SignalInvoice.findById(id);
    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });

    switch (action) {
      case 'approve':
        invoice.status = 'active';
        invoice.signalStatus = 'delivering';

        const months = parseInt(invoice.duration);
        const renewDate = new Date();
        renewDate.setMonth(renewDate.getMonth() + months);
        invoice.renewalDate = renewDate;
        break;

      case 'reject':
        invoice.status = 'rejected';
        invoice.signalStatus = 'inactive';
        break;

      case 'dispute':
        if (!disputeReason) return res.status(400).json({ success: false, message: 'Dispute reason required' });
        invoice.status = 'disputed';
        invoice.disputeReason = disputeReason;
        break;

      case 'resolve-approve':
        invoice.status = 'active';
        invoice.disputeReason = '';
        break;

      case 'resolve-reject':
        invoice.status = 'rejected';
        invoice.disputeReason = '';
        break;

      default:
        return res.status(400).json({ success: false, message: 'Invalid action' });
    }

    await invoice.save();
    res.json({ success: true, invoice });

  } catch (err) {
    console.error('Update signal invoice error:', err);
    res.status(500).json({ success: false, message: 'Server error updating invoice' });
  }
};

/* ================= ADMIN SIGNAL CONTROL ================= */

export const controlSignal = async (req, res) => {
  try {
    const { id } = req.params;
    const { action } = req.body;

    const invoice = await SignalInvoice.findById(id);
    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });

    switch (action) {
      case 'activate':
        invoice.signalStatus = 'delivering';
        invoice.lastSignal = new Date();
        break;

      case 'pause':
        invoice.signalStatus = 'paused';
        break;

      case 'deactivate':
        invoice.signalStatus = 'inactive';
        break;

      default:
        return res.status(400).json({ success: false, message: 'Invalid signal action' });
    }

    await invoice.save();
    res.json({ success: true, invoice });

  } catch (err) {
    console.error('Control signal error:', err);
    res.status(500).json({ success: false, message: 'Server error controlling signal' });
  }
};

/* ================= ADMIN RENEW ================= */

export const renewSignal = async (req, res) => {
  try {
    const invoice = await SignalInvoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });

    const months = parseInt(invoice.duration);
    const newDate = new Date();
    newDate.setMonth(newDate.getMonth() + months);

    invoice.status = 'active';
    invoice.signalStatus = 'delivering';
    invoice.renewalDate = newDate;

    await invoice.save();
    res.json({ success: true, invoice });

  } catch (err) {
    console.error('Renew signal error:', err);
    res.status(500).json({ success: false, message: 'Server error renewing signal' });
  }
};

/* ================= ADMIN DELETE ================= */

export const deleteSignalInvoice = async (req, res) => {
  try {
    const invoice = await SignalInvoice.findByIdAndDelete(req.params.id);
    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });

    if (invoice.paymentProof) {
      const filePath = invoice.paymentProof.replace('/', '');
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    res.json({ success: true, message: 'Signal invoice deleted' });

  } catch (err) {
    console.error('Delete signal invoice error:', err);
    res.status(500).json({ success: false, message: 'Server error deleting invoice' });
  }
};
