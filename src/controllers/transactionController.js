import mongoose from 'mongoose';
import Transaction from '../models/Transaction.js';
import Deposit from '../models/Deposit.js';
import Withdrawal from '../models/Withdrawal.js';
import { escapeRegex } from '../utils/validation.js';

// Money coming in to the user's balance (everything else is money going out or moving).
const INFLOW = new Set(['deposit', 'admin_credit', 'referral_bonus', 'crypto_deposit']);
const describe = (t) => {
  if (t.type?.startsWith('crypto_') && t.metadata?.description) return t.metadata.description;
  const action = String(t.metadata?.action || '').replace(/_/g, ' ');
  const base = String(t.type || '').replace(/_/g, ' ');
  return action ? `${base} · ${action}` : base;
};

/**
 * GET /api/account/transactions?page=&limit=&search=&type=
 * Every ledger entry for the user (deposits, withdrawals, trades, staking,
 * real estate, stocks, mining, cards, vaults, copy trading, admin adjustments
 * and currency conversions), newest first, with real pagination.
 */
export const getTransactions = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const userId = new mongoose.Types.ObjectId(String(req.user.id));
    const query = { userId };
    if (typeof req.query.type === 'string' && req.query.type) {
      const types = req.query.type.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 12);
      query.type = types.length > 1 ? { $in: types } : types[0];
    }
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 60) : '';
    if (search) {
      const re = new RegExp(escapeRegex(search), 'i');
      query.$or = [{ reference: re }, { type: re }, { status: re }, { 'metadata.action': re }, { 'metadata.description': re }, { 'metadata.coin': re }];
    }

    const [rows, total] = await Promise.all([
      Transaction.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Transaction.countDocuments(query)
    ]);

    // Bank details for deposits / withdrawals, looked up by reference.
    const refs = rows.map((t) => t.reference).filter(Boolean);
    const [deps, wds] = await Promise.all([
      Deposit.find({ transactionReference: { $in: refs } }).select('transactionReference paymentMethod paymentMethodId').lean(),
      Withdrawal.find({ transactionReference: { $in: refs } }).select('transactionReference bankName accountName accountNumber method').lean()
    ]);
    const byRef = new Map([...deps, ...wds].map((d) => [d.transactionReference, d]));

    const transactions = rows.map((t) => {
      const extra = byRef.get(t.reference) || {};
      return {
        id: t._id,
        type: t.type,
        label: describe(t),
        direction: (t.type === 'crypto_convert' ? t.metadata?.direction === 'crypto_to_fiat' : INFLOW.has(t.type)) ? 'in' : 'out',
        amount: t.amount,
        currency: t.currency,
        status: t.status,
        reference: t.reference,
        bankName: extra.bankName || extra.paymentMethod || '',
        accountName: extra.accountName || '',
        accountNumber: extra.accountNumber || '',
        metadata: t.metadata || {},
        createdAt: t.createdAt
      };
    });

    res.json({
      success: true,
      data: {
        transactions,
        pagination: { total, pages: Math.ceil(total / limit), currentPage: page, limit }
      }
    });
  } catch (err) {
    console.error('getTransactions error:', err);
    res.status(500).json({ success: false, message: 'Could not load transactions' });
  }
};
