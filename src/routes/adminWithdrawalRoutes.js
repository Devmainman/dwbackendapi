import express from 'express';
import Withdrawal from '../models/Withdrawal.js';
import Transaction from '../models/Transaction.js';
import User from '../models/User.js';
import { escapeRegex } from '../utils/validation.js';
import { withTransaction, creditUser } from '../utils/wallet.js';
import { uploadDir, safeFileName } from '../config/paths.js';
import { authenticate, isAdmin } from '../middleware/auth.js';
import { sendNotification } from '../services/realtime.js';
import { notifyUser } from '../services/notificationService.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

router.use(authenticate, isAdmin);

// Get all withdrawals for admin
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const query = {};
    if (search) {
      // Withdrawal.user is an ObjectId, so match users first, then filter.
      const rx = new RegExp(escapeRegex(search), 'i');
      const users = await User.find({
        $or: [{ accountId: rx }, { firstName: rx }, { lastName: rx }, { email: rx }]
      }).select('_id').limit(500).lean();
      query.user = { $in: users.map((u) => u._id) };
    }
    const withdrawals = await Withdrawal.find(query)
      .populate('method', 'title methodId icon')
      .populate('user', 'accountId firstName lastName currency')
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .sort({ createdAt: -1 });
    const total = await Withdrawal.countDocuments(query);
    res.json({ withdrawals, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error('Fetch withdrawals error:', err);
    res.status(500).json({ message: 'Error fetching withdrawals' });
  }
});

// Update withdrawal status.
// The balance is debited when the user submits the request, so a rejection
// refunds it exactly once, and a rejected withdrawal can no longer change state.
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, adminNotes } = req.body;

    if (!['pending', 'processing', 'approved', 'completed', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const result = await withTransaction(async (session) => {
      const withdrawal = await Withdrawal.findById(id).session(session);
      if (!withdrawal) throw Object.assign(new Error('Withdrawal not found'), { status: 404 });
      if (withdrawal.status === 'rejected') {
        throw Object.assign(new Error('A rejected withdrawal cannot be changed'), { status: 400 });
      }

      withdrawal.status = status;
      if (typeof adminNotes === 'string') withdrawal.adminNotes = adminNotes;
      withdrawal.processedBy = req.user.id;
      withdrawal.processedAt = new Date();
      await withdrawal.save({ session });

      const txStatus = status === 'rejected' ? 'failed'
        : ['approved', 'completed'].includes(status) ? 'completed' : 'pending';
      await Transaction.updateOne(
        { reference: withdrawal.transactionReference },
        { $set: { status: txStatus } },
        { session }
      );

      if (status === 'rejected') {
        await creditUser(withdrawal.user, withdrawal.amount, { session, currency: withdrawal.currency });
      }
      return withdrawal;
    });

    const titles = {
      processing: 'Withdrawal processing', approved: 'Withdrawal approved', completed: 'Withdrawal sent',
      rejected: 'Withdrawal declined', pending: 'Withdrawal pending'
    };
    await notifyUser(result.user, {
      type: 'withdrawal',
      title: titles[status],
      content: status === 'rejected'
        ? `Your withdrawal of ${result.amount} ${result.currency || ''} was declined and the funds were returned to your balance.${adminNotes ? ` ${adminNotes}` : ''}`
        : `Your withdrawal of ${result.amount} ${result.currency || ''} is ${status}.`,
      link: '/transactionhistory',
      metadata: { withdrawalId: result._id, status }
    });

    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    console.error('Update withdrawal error:', err);
    res.status(500).json({ message: 'Error updating withdrawal' });
  }
});

// Delete withdrawal
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const withdrawal = await Withdrawal.findById(id);
    if (!withdrawal) {
      return res.status(404).json({ message: 'Withdrawal not found' });
    }

    await withdrawal.deleteOne();
    res.json({ message: 'Withdrawal deleted' });
  } catch (err) {
    console.error('Delete withdrawal error:', err);
    res.status(500).json({ message: 'Error deleting withdrawal' });
  }
});

// Upload receipt for withdrawal
router.post('/:id/receipt', async (req, res) => {
  try {
    const { id } = req.params;
    const withdrawal = await Withdrawal.findById(id);
    if (!withdrawal) {
      return res.status(404).json({ message: 'Withdrawal not found' });
    }

    // Check if file was uploaded
    if (!req.files || !req.files.receipt) {
      return res.status(400).json({ message: 'No receipt file uploaded' });
    }

    const receiptFile = req.files.receipt;
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
    if (!allowedTypes.includes(receiptFile.mimetype)) {
      return res.status(400).json({ message: 'Only JPEG, PNG, or GIF files are allowed' });
    }

    // Generate unique filename
    const fileName = `${id}_${Date.now()}${path.extname(receiptFile.name)}`;
    const uploadPath = path.join(uploadDir('receipts'), safeFileName(fileName));

    // Move file to uploads directory
    await receiptFile.mv(uploadPath);

    // Update withdrawal with receipt path
    withdrawal.receipt = `/uploads/receipts/${fileName}`;
    await withdrawal.save();

    // Notify user via WebSocket
    sendNotification(withdrawal.user.toString(), {
      type: 'withdrawal_receipt',
      withdrawalId: withdrawal._id,
      message: 'A receipt has been uploaded for your withdrawal.'
    });

    res.json({ message: 'Receipt uploaded successfully', receipt: withdrawal.receipt });
  } catch (err) {
    console.error('Upload receipt error:', err);
    res.status(500).json({ message: 'Error uploading receipt' });
  }
});

export default router;