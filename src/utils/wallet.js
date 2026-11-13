// src/utils/wallet.js
// Atomic balance operations. Every debit is a conditional update, so two
// concurrent requests can never push a balance below zero or double-spend.
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import User from '../models/User.js';
import Transaction from '../models/Transaction.js';
import Currency from '../models/Currency.js';
import Setting from '../models/Setting.js';
import { round2 } from './money.js';

export class InsufficientFundsError extends Error {
  constructor(message = 'Insufficient balance') {
    super(message);
    this.name = 'InsufficientFundsError';
    this.status = 400;
  }
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Pipeline update that adds to the balance and rounds to cents (no float drift). */
export const addRounded = (delta) => [{ $set: { balance: { $round: [{ $add: ['$balance', delta] }, 2] } } }];

/**
 * Debit a user's main balance atomically.
 * Throws InsufficientFundsError if the balance is too low.
 */
export const debitUser = async (userId, amount, { session } = {}) => {
  const amt = round2(amount);
  if (!(amt > 0)) throw new HttpError(400, 'Invalid amount');
  const user = await User.findOneAndUpdate(
    { _id: userId, balance: { $gte: amt } },
    addRounded(-amt),
    { new: true, session }
  );
  if (!user) {
    const exists = await User.exists({ _id: userId }).session(session || null);
    if (!exists) throw new HttpError(404, 'User not found');
    throw new InsufficientFundsError();
  }
  return user;
};

/** Credit a user's main balance atomically. */
export const creditUser = async (userId, amount, { session } = {}) => {
  const amt = round2(amount);
  if (!(amt > 0)) throw new HttpError(400, 'Invalid amount');
  const user = await User.findByIdAndUpdate(
    userId,
    addRounded(amt),
    { new: true, session }
  );
  if (!user) throw new HttpError(404, 'User not found');
  return user;
};

/** Record a ledger entry for a balance movement. */
export const recordTransaction = async ({
  userId, amount, currency, type, status = 'completed', metadata, session, prefix = 'TX'
}) => {
  const [tx] = await Transaction.create([{
    userId,
    amount: round2(amount),
    currency,
    type,
    status,
    reference: `${prefix}-${uuidv4().replace(/-/g, '').slice(0, 16).toUpperCase()}`,
    metadata
  }], { session });
  return tx;
};

/**
 * Run `fn(session)` inside a MongoDB transaction (requires a replica set,
 * which MongoDB Atlas provides). Retries transient errors automatically.
 */
export const withTransaction = async (fn) => {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};

/**
 * Convert an amount quoted in the platform base currency (Setting.defaultCurrency,
 * fallback USD) into the user's currency using admin-managed rates.
 * Currency.rate is "units per 1 base unit".
 */
export const convertFromBase = async (amount, userCurrency) => {
  const settings = await Setting.findOne().select('defaultCurrency').lean();
  const baseCode = (settings?.defaultCurrency || 'USD').toUpperCase();
  const target = (userCurrency || baseCode).toUpperCase();
  if (target === baseCode) return { amount: round2(amount), rate: 1, base: baseCode, currency: target };

  const [base, user] = await Promise.all([
    Currency.findOne({ code: baseCode }).lean(),
    Currency.findOne({ code: target }).lean()
  ]);
  const baseRate = base?.rate || 1;
  const userRate = user?.rate || 1;
  const rate = userRate / baseRate;
  return { amount: round2(amount * rate), rate, base: baseCode, currency: target };
};

/** Express error responder used by the newer controllers. */
export const sendError = (res, err, fallback = 'Server error') => {
  const status = err?.status && Number.isInteger(err.status) ? err.status : 500;
  if (status >= 500) console.error(fallback, err);
  return res.status(status).json({
    success: false,
    message: status >= 500 ? fallback : err.message
  });
};
