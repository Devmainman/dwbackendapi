import mongoose from 'mongoose';
import ColdStorageVault from '../models/ColdStorageVault.js';
import User from '../models/User.js';
import { parseAmount, parsePositiveInt, round2 } from '../utils/money.js';
import { asString } from '../utils/validation.js';
import { rateBetween } from '../services/fx.js';
import { withTransaction, debitUser, creditUser, recordTransaction, convertFromBase, HttpError } from '../utils/wallet.js';
import { handler, getSettings, loadActiveUser, addDays, addHours, notify, paging } from '../services/productService.js';

const ASSETS = ['USD', 'BTC', 'ETH', 'USDT', 'USDC', 'SOL', 'BNB', 'XRP', 'GOLD'];

const findOwnVault = async (userId, id, session) => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, 'Invalid vault id');
  const vault = await ColdStorageVault.findOne({ _id: id, user: userId }).session(session || null);
  if (!vault) throw new HttpError(404, 'Vault not found');
  return vault;
};

/** GET /api/cold-storage */
export const listVaults = handler(async (req, res) => {
  const [vaults, settings, user] = await Promise.all([
    ColdStorageVault.find({ user: req.user.id, status: { $ne: 'closed' } }).sort({ createdAt: -1 }),
    getSettings(),
    User.findById(req.user.id).select('balance currency')
  ]);
  const totalSecured = round2(vaults.reduce((s, v) => s + v.amount, 0));
  const minDeposit = await convertFromBase(settings.coldStorage.minDeposit, user.currency);
  res.json({
    success: true,
    data: {
      vaults,
      totalSecured,
      availableBalance: user.balance,
      currency: user.currency,
      config: {
        unlockDelayHours: settings.coldStorage.unlockDelayHours,
        minDeposit: minDeposit.amount,
        assets: ASSETS
      }
    }
  });
});

/** POST /api/cold-storage  { name, asset, lockType, lockDays, amount? } */
export const createVault = handler(async (req, res) => {
  const name = asString(req.body.name, 60) || 'My Vault';
  const asset = ASSETS.includes(String(req.body.asset).toUpperCase()) ? String(req.body.asset).toUpperCase() : 'USD';
  const lockType = req.body.lockType === 'time_locked' ? 'time_locked' : 'flexible';
  const lockDays = lockType === 'time_locked' ? parsePositiveInt(req.body.lockDays, { max: 3650 }) : 0;
  if (lockType === 'time_locked' && !lockDays) throw new HttpError(400, 'Lock period (days) is required');

  const count = await ColdStorageVault.countDocuments({ user: req.user.id, status: { $ne: 'closed' } });
  if (count >= 10) throw new HttpError(400, 'You can have at most 10 vaults');

  const user = await loadActiveUser(req.user.id);
  const initial = req.body.amount !== undefined && req.body.amount !== '' ? parseAmount(req.body.amount) : 0;
  if (initial === null) throw new HttpError(400, 'Invalid amount');

  const settings = await getSettings();
  if (initial > 0) {
    const min = await convertFromBase(settings.coldStorage.minDeposit, user.currency);
    if (initial < min.amount) throw new HttpError(400, `Minimum deposit is ${min.amount} ${user.currency}`);
  }

  const vault = await withTransaction(async (session) => {
    const [v] = await ColdStorageVault.create([{
      user: user._id,
      name,
      asset,
      currency: user.currency,
      lockType,
      lockDays,
      lockedUntil: lockType === 'time_locked' ? addDays(new Date(), lockDays) : null,
      amount: 0
    }], { session });

    if (initial > 0) {
      await debitUser(user._id, initial, { session });
      v.amount = round2(initial);
      await v.save({ session });
      await recordTransaction({
        userId: user._id, amount: initial, currency: user.currency, type: 'cold_storage',
        metadata: { direction: 'in', vaultId: v._id, vaultName: name }, session, prefix: 'CS'
      });
    }
    return v;
  });

  res.status(201).json({ success: true, message: 'Vault created', data: vault });
});

/** POST /api/cold-storage/:id/deposit  { amount } */
export const depositToVault = handler(async (req, res) => {
  const amount = parseAmount(req.body.amount);
  if (amount === null) throw new HttpError(400, 'A valid amount is required');
  const user = await loadActiveUser(req.user.id);
  const settings = await getSettings();
  const min = await convertFromBase(settings.coldStorage.minDeposit, user.currency);
  if (amount < min.amount) throw new HttpError(400, `Minimum deposit is ${min.amount} ${user.currency}`);

  const vault = await withTransaction(async (session) => {
    const v = await findOwnVault(user._id, req.params.id, session);
    if (v.status === 'closed') throw new HttpError(400, 'Vault is closed');
    await debitUser(user._id, amount, { session });
    // The vault keeps the currency it was opened in; convert if the account has since changed.
    v.amount = round2(v.amount + amount * (await rateBetween(user.currency, v.currency)));
    await v.save({ session });
    await recordTransaction({
      userId: user._id, amount, currency: user.currency, type: 'cold_storage',
      metadata: { direction: 'in', vaultId: v._id, vaultName: v.name }, session, prefix: 'CS'
    });
    return v;
  });

  res.json({ success: true, message: 'Funds moved to cold storage', data: vault });
});

/** POST /api/cold-storage/:id/unlock  { amount } — starts the security delay */
export const requestUnlock = handler(async (req, res) => {
  const amount = parseAmount(req.body.amount);
  if (amount === null) throw new HttpError(400, 'A valid amount is required');
  const settings = await getSettings();
  const vault = await findOwnVault(req.user.id, req.params.id);

  if (vault.status !== 'active') throw new HttpError(400, 'An unlock is already in progress for this vault');
  if (vault.adminHold) throw new HttpError(403, 'This vault is on hold. Contact support.');
  if (vault.lockType === 'time_locked' && vault.lockedUntil && vault.lockedUntil > new Date()) {
    throw new HttpError(400, `Vault is time-locked until ${vault.lockedUntil.toISOString().slice(0, 10)}`);
  }
  if (amount > vault.amount) throw new HttpError(400, 'Amount exceeds vault balance');

  vault.status = 'unlock_requested';
  vault.unlockAmount = round2(amount);
  vault.unlockRequestedAt = new Date();
  vault.unlockAvailableAt = addHours(new Date(), settings.coldStorage.unlockDelayHours);
  await vault.save();

  await notify(req.user.id, {
    title: 'Cold storage unlock requested',
    content: `An unlock of ${vault.unlockAmount} ${vault.currency} from "${vault.name}" was requested. ` +
      `Funds become available after ${vault.unlockAvailableAt.toUTCString()}. If this wasn't you, cancel it and contact support.`,
    type: 'security',
    link: '/cold-storage'
  });

  res.json({ success: true, message: 'Unlock requested', data: vault });
});

/** POST /api/cold-storage/:id/cancel-unlock */
export const cancelUnlock = handler(async (req, res) => {
  const vault = await ColdStorageVault.findOneAndUpdate(
    { _id: req.params.id, user: req.user.id, status: 'unlock_requested' },
    { $set: { status: 'active', unlockAmount: 0, unlockRequestedAt: null, unlockAvailableAt: null } },
    { new: true }
  );
  if (!vault) throw new HttpError(404, 'No pending unlock for this vault');
  res.json({ success: true, message: 'Unlock cancelled', data: vault });
});

/** POST /api/cold-storage/:id/release — moves unlocked funds back to the main balance */
export const releaseUnlocked = handler(async (req, res) => {
  const result = await withTransaction(async (session) => {
    const v = await findOwnVault(req.user.id, req.params.id, session);
    if (v.status !== 'unlock_requested') throw new HttpError(400, 'No unlock has been requested');
    if (v.adminHold) throw new HttpError(403, 'This vault is on hold. Contact support.');
    if (v.unlockAvailableAt > new Date()) {
      throw new HttpError(400, `Funds unlock at ${v.unlockAvailableAt.toUTCString()}`);
    }
    const amount = Math.min(v.unlockAmount, v.amount);
    if (!(amount > 0)) throw new HttpError(400, 'Nothing to release');

    v.amount = round2(v.amount - amount);
    v.status = 'active';
    v.unlockAmount = 0;
    v.unlockRequestedAt = null;
    v.unlockAvailableAt = null;
    await v.save({ session });
    await creditUser(v.user, amount, { session, currency: v.currency });
    await recordTransaction({
      userId: v.user, amount, currency: v.currency, type: 'cold_storage',
      metadata: { direction: 'out', vaultId: v._id, vaultName: v.name }, session, prefix: 'CS'
    });
    return { vault: v, amount };
  });

  res.json({ success: true, message: `${result.amount} released to your balance`, data: result.vault });
});

/** DELETE /api/cold-storage/:id — only empty vaults can be closed */
export const closeVault = handler(async (req, res) => {
  const vault = await ColdStorageVault.findOneAndUpdate(
    { _id: req.params.id, user: req.user.id, amount: 0, status: 'active' },
    { $set: { status: 'closed' } },
    { new: true }
  );
  if (!vault) throw new HttpError(400, 'Only an empty vault with no pending unlock can be closed');
  res.json({ success: true, message: 'Vault closed' });
});

/* ------------------------------ Admin ------------------------------ */

/** GET /api/admin/products/cold-storage */
export const adminListVaults = handler(async (req, res) => {
  const { page, limit, skip } = paging(req.query);
  const filter = {};
  if (['active', 'unlock_requested', 'closed'].includes(req.query.status)) filter.status = req.query.status;
  const [items, total, totals] = await Promise.all([
    ColdStorageVault.find(filter).populate('user', 'email firstName lastName accountId').sort({ updatedAt: -1 }).skip(skip).limit(limit),
    ColdStorageVault.countDocuments(filter),
    ColdStorageVault.aggregate([{ $match: { status: { $ne: 'closed' } } }, { $group: { _id: '$currency', total: { $sum: '$amount' } } }])
  ]);
  res.json({ success: true, data: { items, total, page, limit, totalsByCurrency: totals } });
});

/** PATCH /api/admin/products/cold-storage/:id  { adminHold, adminNote } */
export const adminUpdateVault = handler(async (req, res) => {
  const update = {};
  if (typeof req.body.adminHold === 'boolean') update.adminHold = req.body.adminHold;
  if (req.body.adminNote !== undefined) update.adminNote = asString(req.body.adminNote, 500);
  if (req.body.releaseNow === true) update.unlockAvailableAt = new Date();
  const vault = await ColdStorageVault.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
  if (!vault) throw new HttpError(404, 'Vault not found');
  res.json({ success: true, data: vault });
});
