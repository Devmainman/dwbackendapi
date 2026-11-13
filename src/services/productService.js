// src/services/productService.js
// Shared helpers for the cold storage, cards, wallets, stocks, staking and
// real-estate modules.
import Setting from '../models/Setting.js';
import User from '../models/User.js';
import { HttpError, sendError } from '../utils/wallet.js';
import { round2 } from '../utils/money.js';
import { notifyUser } from './notificationService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Wrap an async controller so thrown HttpErrors become JSON responses. */
export const handler = (fn, fallback = 'Server error') => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err?.name === 'CastError') return res.status(400).json({ success: false, message: 'Invalid identifier' });
    if (err?.code === 11000) return res.status(409).json({ success: false, message: 'Already exists' });
    if (err?.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: Object.values(err.errors).map((e) => e.message).join(', ') });
    }
    return sendError(res, err, fallback);
  }
};

export const getSettings = async () => (await Setting.findOne()) || new Setting();

/** Middleware: block a module when the admin has switched it off. */
export const requireFeature = (path) => async (req, res, next) => {
  try {
    const settings = await getSettings();
    const enabled = path.split('.').reduce((o, k) => (o == null ? o : o[k]), settings);
    if (enabled === false) {
      return res.status(503).json({ success: false, message: 'This feature is currently unavailable' });
    }
    next();
  } catch (err) {
    next(err);
  }
};

/** Load the authenticated user or throw 404; block restricted accounts from moving money. */
export const loadActiveUser = async (userId, { session } = {}) => {
  const user = await User.findById(userId).session(session || null);
  if (!user) throw new HttpError(404, 'User not found');
  if (user.status === 'Inactive') throw new HttpError(403, 'Your account is restricted. Contact support.');
  return user;
};

/**
 * Simple-interest accrual between two instants.
 * @param principal amount earning yield
 * @param ratePercent annual rate, e.g. 12 for 12%
 */
export const accrue = (principal, ratePercent, from, to) => {
  const ms = Math.max(0, new Date(to).getTime() - new Date(from).getTime());
  return round2(principal * (ratePercent / 100) * (ms / (365 * DAY_MS)));
};

export const addDays = (date, days) => new Date(new Date(date).getTime() + days * DAY_MS);
export const addHours = (date, hours) => new Date(new Date(date).getTime() + hours * 60 * 60 * 1000);
export const addMonths = (date, months) => {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
};

/** Push an in-app notification without failing the main operation. */
export const notify = (userId, { title, content, type = 'transaction', metadata, link, dedupeKey }) =>
  notifyUser(userId, { title, content, type, metadata, link, dedupeKey });

/** Page/limit parsing with sane bounds. */
export const paging = (query, defLimit = 20) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || defLimit));
  return { page, limit, skip: (page - 1) * limit };
};
