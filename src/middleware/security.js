// src/middleware/security.js
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !Buffer.isBuffer(v);

/**
 * Remove keys starting with "$" or containing "." (MongoDB operator injection),
 * recursively and in place. Express 5 makes req.query a getter, so the query
 * string is sanitized through the app's "query parser" setting instead.
 */
export const stripMongoOperators = (value, depth = 0) => {
  if (depth > 20) return value;
  if (Array.isArray(value)) {
    value.forEach((item) => stripMongoOperators(item, depth + 1));
    return value;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (key.startsWith('$') || key.includes('.') || key === '__proto__' || key === 'constructor' || key === 'prototype') {
        delete value[key];
      } else {
        stripMongoOperators(value[key], depth + 1);
      }
    }
  }
  return value;
};

export const sanitizeRequest = (req, _res, next) => {
  if (req.body) stripMongoOperators(req.body);
  if (req.params) stripMongoOperators(req.params);
  next();
};

// RATE_LIMIT_MULTIPLIER lets ops loosen/tighten every limit at once (e.g. 2 = double).
const limiter = (windowMs, max, message) => rateLimit({
  windowMs,
  max: Math.max(1, Math.round(max * (Number(process.env.RATE_LIMIT_MULTIPLIER) || 1))),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message }
});

/** Login / signup / OTP: slow down credential stuffing. */
export const authLimiter = limiter(15 * 60 * 1000, 20, 'Too many attempts, please try again in 15 minutes.');
/** Money-moving endpoints. */
export const moneyLimiter = limiter(60 * 1000, 30, 'Too many requests, please slow down.');
/** Admin APIs. */
export const adminLimiter = limiter(15 * 60 * 1000, 1000, 'Too many requests from this IP, please try again later.');
/** General API traffic. */
export const apiLimiter = limiter(60 * 1000, 300, 'Too many requests, please slow down.');

/* ---------- Signed URLs for private files (KYC documents) ---------- */

const fileSecret = () => process.env.FILE_URL_SECRET || process.env.JWT_SECRET;

const signature = (folder, file, exp) =>
  crypto.createHmac('sha256', fileSecret()).update(`${folder}/${file}:${exp}`).digest('hex');

/** Build a short-lived URL for a private upload. */
export const signedFileUrl = (baseUrl, folder, file, ttlSeconds = 15 * 60) => {
  if (!file) return null;
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = signature(folder, file, exp);
  return `${baseUrl}/api/files/private/${encodeURIComponent(folder)}/${encodeURIComponent(file)}?exp=${exp}&sig=${sig}`;
};

export const verifySignedFile = (folder, file, exp, sig) => {
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Date.now() / 1000) return false;
  if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const expected = signature(folder, file, expNum);
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
};
