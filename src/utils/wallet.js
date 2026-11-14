// src/utils/wallet.js
// Atomic balance operations. Every debit is a conditional update, so two
// concurrent requests can never push a balance below zero or double-spend.
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import User from '../models/User.js';
import Transaction from '../models/Transaction.js';
import { rateBetween, safeRateBetween, getBaseCurrency } from '../services/fx.js';
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

/**
 * Credit a user's main balance atomically.
 * Pass `currency` when the amount was recorded in a specific currency (a stake,
 * a trade, a deposit): if the user has since switched currency it is converted
 * at today's rate so the balance never mixes currencies.
 */
export const creditUser = async (userId, amount, { session, currency } = {}) => {
  let amt = round2(amount);
  if (currency) {
    const holder = await User.findById(userId).select('currency').session(session || null).lean();
    if (holder && holder.currency && holder.currency !== String(currency).toUpperCase()) {
      amt = round2(amt * (await rateBetween(currency, holder.currency)));
    }
  }
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
 * Rates come from the shared FX table (units per 1 USD).
 */
export const convertFromBase = async (amount, userCurrency) => {
  const baseCode = await getBaseCurrency();
  const target = String(userCurrency || baseCode).toUpperCase();
  const rate = await safeRateBetween(baseCode, target);
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

/**
 * Switch a user's account currency and convert their balance at today's rate.
 * Conditional on the old currency so two concurrent switches can't double-convert.
 * Open products (stakes, trades, vaults, cards) keep their own currency and are
 * converted when they pay out.
 */
export const switchUserCurrency = async (userId, newCode, { by = 'user' } = {}) => {
  const code = String(newCode || '').toUpperCase();
  return withTransaction(async (session) => {
    const user = await User.findById(userId).select('currency balance').session(session);
    if (!user) throw new HttpError(404, 'User not found');
    if (user.currency === code) return { user, rate: 1, from: code, to: code, oldBalance: user.balance, newBalance: user.balance };
    const rate = await rateBetween(user.currency, code);
    const oldBalance = user.balance;
    const newBalance = round2(oldBalance * rate);
    const updated = await User.findOneAndUpdate(
      { _id: userId, currency: user.currency },
      { $set: { currency: code, balance: newBalance } },
      { new: true, session }
    );
    if (!updated) throw new HttpError(409, 'Currency was just changed, please retry');
    const [tx] = await Transaction.create([{
      userId,
      amount: round2(oldBalance),
      currency: user.currency,
      type: 'currency_conversion',
      status: 'completed',
      reference: `CURRCONV-${uuidv4().replace(/-/g, '').slice(0, 12).toUpperCase()}`,
      metadata: { rate, by, newAmount: newBalance, newCurrency: code, note: `Converted ${round2(oldBalance)} ${user.currency} to ${newBalance} ${code}` }
    }], { session });
    return { user: updated, rate, from: user.currency, to: code, oldBalance: round2(oldBalance), newBalance, transaction: tx };
  });
};
