import { UPLOAD_ROOT } from '../config/paths.js';
import path from 'path';
import SignalInvoice from '../models/SignalInvoice.js';
import SignalPackage from '../models/SignalPackage.js';
import User from '../models/User.js';
import Setting from '../models/Setting.js';
import Transaction from '../models/Transaction.js';
import { v4 as uuidv4 } from 'uuid';

import fs from 'fs';


/* ==========================================
   USER SUBMITS SIGNAL PAYMENT & CREATES INVOICE
   ========================================== */

export const createSignalUpgrade = async (req, res) => {
  try {
    console.log("BODY:", req.body);
    console.log("FILES:", req.files);

    const { packageId, paymentMethod } = req.body;
    const paymentProof = req.files?.paymentProof;
    const userId = req.user.id;

    if (!packageId || !paymentMethod || !paymentProof) {
      return res.status(400).json({
        success: false,
        message: 'Package, payment method and proof are required'
      });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const pkg = await SignalPackage.findById(packageId);
    if (!pkg || !pkg.active) {
      return res.status(404).json({ success: false, message: 'Signal package not found or inactive' });
    }

    // GET DEFAULT CURRENCY FROM SETTINGS
    const setting = await Setting.findOne();
    const currency = setting?.defaultCurrency;

    /* SAVE PAYMENT PROOF FILE */
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'];
    const ext = path.extname(String(paymentProof.name || '')).toLowerCase();
    if (!allowed.includes(ext)) {
      return res.status(400).json({ success: false, message: 'Payment proof must be an image or PDF' });
    }
    const uploadDir = path.join(UPLOAD_ROOT, 'payments');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const fileName = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}${ext}`;
    const filePath = `${uploadDir}/${fileName}`;

    await paymentProof.mv(filePath);

    /* CREATE INVOICE AFTER PAYMENT */
    const invoice = new SignalInvoice({
      user: user._id,

      userSnapshot: {
        accountId: user.accountId,
        fullName: user.fullName,
        email: user.email
      },

      signalPackage: pkg.name,
      amount: pkg.amount,
      currency: currency,

      paymentMethod,
      paymentProof: `/uploads/payments/${fileName}`,
      receipt: '',

      status: 'pending',              
      signalStatus: 'pending_activation',


      successRate: 'N/A',
      lastSignal: null,
      renewalDate: null,
      disputeReason: ''
    });

    await invoice.save();

    // CREATE TRANSACTION RECORD
const transaction = new Transaction({
  userId: user._id,
  amount: pkg.amount,
  currency: pkg.currency,
  type: 'signal',                    // matches your transactionController logic
  status: 'pending',                  // waiting admin approval
  reference: `SIG-${uuidv4().slice(0, 8)}`,
  description: `Signal Upgrade - ${pkg.name}`
});

await transaction.save();


    res.status(201).json({
      success: true,
      message: 'Signal payment submitted, awaiting approval',
      invoiceId: invoice._id
    });

  } catch (err) {
    console.error('Create signal upgrade error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error creating signal upgrade'
    });
  }
};





/* ==========================================
   ADMIN APPROVES SIGNAL UPGRADE
   ========================================== */

export const approveSignalUpgrade = async (req, res) => {
  try {
    const { id } = req.params;

    const invoice = await SignalInvoice.findById(id);
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Signal invoice not found' });
    }

    // CORRECT STATUS CHECK
    if (invoice.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Only pending invoices can be approved'
      });
    }

    // Fetch user & package
    const user = await User.findById(invoice.user);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const pkg = await SignalPackage.findOne({ name: invoice.signalPackage });
    if (!pkg) {
      return res.status(404).json({ success: false, message: 'Signal package missing' });
    }

    // ACTIVATE INVOICE
    invoice.status = 'active';
    invoice.signalStatus = 'delivering';
    invoice.lastSignal = new Date();

    invoice.renewalDate = null;


    await invoice.save();

  // INCREASE USER SIGNAL STRENGTH (ADD, NOT REPLACE)
user.tradingSignalStrength =
  (user.tradingSignalStrength || 0) + (pkg.strength || 0);

if (user.tradingSignalStrength > 100) {
  user.tradingSignalStrength = 100; // cap at 100 if you want max
}

user.tradingSignalUpdatedAt = new Date();
user.tradingEnabled = true;

await user.save();


    // MARK TRANSACTION COMPLETED (CORRECT STATUS)
    await Transaction.findOneAndUpdate(
      {
        userId: user._id,
        type: 'signal',
        status: 'pending',
        reference: { $regex: '^SIG-' }
      },
      { status: 'completed' }
    );

    res.json({
      success: true,
      message: 'Signal upgrade approved and activated',
      invoice
    });

  } catch (err) {
    console.error('Approve signal upgrade error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error approving signal upgrade'
    });
  }
};

