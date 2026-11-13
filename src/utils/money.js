// src/utils/money.js
// Helpers for validating and handling monetary values coming from clients.

/** Round to 2 decimals (fiat-style). */
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Round to 8 decimals (share / crypto quantities). */
export const round8 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e8) / 1e8;

/**
 * Parse a positive, finite amount from client input.
 * Returns the number or null when invalid (NaN, Infinity, <= 0, objects, etc.).
 */
export const parseAmount = (value, { max = 1e12, allowZero = false } = {}) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (allowZero ? n < 0 : n <= 0) return null;
  if (n > max) return null;
  return n;
};

/** Parse a positive integer (e.g. a number of shares or days). */
export const parsePositiveInt = (value, { max = 1e9 } = {}) => {
  const n = parseAmount(value, { max });
  if (n === null || !Number.isInteger(n)) return null;
  return n;
};
