// Extra admin endpoints for the Manage Users screen: headline stats, bulk
// actions and a complete per-user overview (holdings, activity, flags).
import mongoose from 'mongoose';
import User from '../models/User.js';
import Transaction from '../models/Transaction.js';
import Deposit from '../models/Deposit.js';
import Withdrawal from '../models/Withdrawal.js';
import Notification from '../models/Notification.js';
import { handler } from '../services/productService.js';
import { buildHoldings } from '../services/holdingsService.js';
import { getBaseCurrency, safeRateBetween } from '../services/fx.js';
import { activeConnections } from '../services/realtime.js';
import { notifyUser } from '../services/notificationService.js';
import { HttpError } from '../utils/wallet.js';
import { round2 } from '../utils/money.js';

const ids = (list) => (Array.isArray(list) ? list : []).filter((x) => mongoose.Types.ObjectId.isValid(String(x))).slice(0, 500);

/** GET /api/admin/users/stats */
export const userStats = handler(async (_req, res) => {
  const weekAgo = new Date(Date.now() - 7 * 86400e3);
  const base = await getBaseCurrency();
  const [total, active, inactive, newThisWeek, emailVerified, idVerified, withdrawalLocked, balances] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments({ status: 'Active' }),
    User.countDocuments({ status: 'Inactive' }),
    User.countDocuments({ $or: [{ joinedDate: { $gte: weekAgo } }, { createdAt: { $gte: weekAgo } }] }),
    User.countDocuments({ 'verification.emailVerified': true }),
    User.countDocuments({ 'verification.identityVerified': true }),
    User.countDocuments({ withdrawalLocked: true }),
    User.aggregate([{ $group: { _id: '$currency', total: { $sum: '$balance' } } }])
  ]);
  let totalBalance = 0;
  for (const b of balances) totalBalance += (b.total || 0) * (await safeRateBetween(b._id || base, base)); // eslint-disable-line no-await-in-loop
  res.json({
    success: true,
    data: { total, active, inactive, newThisWeek, emailVerified, idVerified, withdrawalLocked, online: activeConnections.size, totalBalance: round2(totalBalance), currency: base }
  });
});

/** POST /api/admin/users/bulk-status  { ids: [], status: 'Active' | 'Inactive', reason? } */
export const bulkStatus = handler(async (req, res) => {
  const list = ids(req.body?.ids);
  const status = req.body?.status;
  if (!list.length) throw new HttpError(400, 'Select at least one user');
  if (!['Active', 'Inactive'].includes(status)) throw new HttpError(400, 'Status must be Active or Inactive');
  const set = status === 'Inactive'
    ? { status, blockReason: String(req.body?.reason || 'Your account has been restricted.').slice(0, 300) }
    : { status };
  const update = status === 'Active' ? { $set: set, $unset: { blockReason: 1 } } : { $set: set };
  const r = await User.updateMany({ _id: { $in: list } }, update);
  res.json({ success: true, message: `${r.modifiedCount} user${r.modifiedCount === 1 ? '' : 's'} ${status === 'Active' ? 'activated' : 'blocked'}`, data: { updated: r.modifiedCount } });
});

/** POST /api/admin/users/bulk-delete  { ids: [], confirmation: 'DELETE' } */
export const bulkDelete = handler(async (req, res) => {
  const list = ids(req.body?.ids || req.body?.userIds);
  if (!list.length) throw new HttpError(400, 'Select at least one user');
  if (req.body?.confirmation !== 'DELETE') throw new HttpError(400, 'Type DELETE to confirm');
  const r = await User.deleteMany({ _id: { $in: list } });
  await Notification.deleteMany({ user: { $in: list } });
  res.json({ success: true, message: `${r.deletedCount} user${r.deletedCount === 1 ? '' : 's'} deleted`, data: { deleted: r.deletedCount } });
});

/** POST /api/admin/users/bulk-notify  { ids: [], title, content } */
export const bulkNotify = handler(async (req, res) => {
  const list = ids(req.body?.ids);
  const title = String(req.body?.title || '').trim().slice(0, 140);
  if (!list.length) throw new HttpError(400, 'Select at least one user');
  if (!title) throw new HttpError(400, 'A title is required');
  let sent = 0;
  for (const id of list) {
    // eslint-disable-next-line no-await-in-loop
    if (await notifyUser(id, { type: 'system', title, content: String(req.body?.content || '').slice(0, 2000) })) sent += 1;
  }
  res.json({ success: true, message: `Sent to ${sent} user${sent === 1 ? '' : 's'}`, data: { sent } });
});

/** GET /api/admin/users/:id/overview — everything about one user */
export const userOverview = handler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, 'Invalid user id');
  const user = await User.findById(id)
    .select('-password -otp -messages -__v -verification.identityDocuments -verification.proofOfAddress.image')
    .populate('accountType', 'name amount currency threshold')
    .lean();
  if (!user) throw new HttpError(404, 'User not found');
  const [holdings, transactions, deposits, withdrawals, txCount] = await Promise.all([
    buildHoldings(id).catch(() => null),
    Transaction.find({ userId: id }).sort({ createdAt: -1 }).limit(25).lean(),
    Deposit.aggregate([{ $match: { userId: new mongoose.Types.ObjectId(id) } }, { $group: { _id: '$status', n: { $sum: 1 }, total: { $sum: '$amount' } } }]),
    Withdrawal.aggregate([{ $match: { user: new mongoose.Types.ObjectId(id) } }, { $group: { _id: '$status', n: { $sum: 1 }, total: { $sum: '$amount' } } }]),
    Transaction.countDocuments({ userId: id })
  ]);
  const summarize = (rows) => Object.fromEntries(rows.map((r) => [r._id, { count: r.n, total: round2(r.total) }]));
  res.json({
    success: true,
    data: {
      user: { ...user, isOnline: activeConnections.has(String(user._id)) },
      holdings,
      transactions,
      transactionCount: txCount,
      deposits: summarize(deposits),
      withdrawals: summarize(withdrawals)
    }
  });
});
