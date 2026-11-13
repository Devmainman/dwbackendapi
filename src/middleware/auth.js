import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import Admin from '../models/Admin.js';

const AuthError = {
  NO_TOKEN: { code: 'NO_TOKEN', message: 'Authorization token required', status: 401 },
  INVALID_FORMAT: { code: 'INVALID_FORMAT', message: 'Invalid authorization format. Use: Bearer <token>', status: 401 },
  TOKEN_EXPIRED: { code: 'TOKEN_EXPIRED', message: 'Access token expired', status: 401 },
  INVALID_TOKEN: { code: 'INVALID_TOKEN', message: 'Invalid access token', status: 401 },
  ADMIN_REQUIRED: { code: 'ADMIN_REQUIRED', message: 'Administrator access required', status: 403 }
};

const send = (res, err, extra = {}) =>
  res.status(err.status).json({ ...err, ...extra });

/** Extract the user id from any of the token shapes this API issues. */
export const extractUserId = (decoded) =>
  decoded?.id || decoded?.userId || decoded?.user?.id || null;

/** Verify a JWT with a pinned algorithm. */
export const verifyToken = (token) =>
  jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });

export const authenticate = async (req, res, next) => {
  const authHeader = req.header('Authorization');
  if (!authHeader) return send(res, AuthError.NO_TOKEN);
  if (!authHeader.startsWith('Bearer ')) return send(res, AuthError.INVALID_FORMAT);

  const token = authHeader.slice(7).trim();
  try {
    const decoded = verifyToken(token);
    const userId = extractUserId(decoded);
    if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) {
      return send(res, AuthError.INVALID_TOKEN);
    }

    req.user = {
      id: String(userId),
      _id: String(userId),
      isAdmin: decoded.isAdmin === true,
      role: decoded.isAdmin === true ? 'admin' : 'user',
      impersonated: decoded.isAdminAccess === true
    };
    req.auth = req.user; // backward compatibility
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return send(res, AuthError.TOKEN_EXPIRED, { expiredAt: error.expiredAt });
    }
    return send(res, AuthError.INVALID_TOKEN);
  }
};

/**
 * Requires a token issued by the admin login AND an admin record that still
 * exists (a deleted admin's unexpired token stops working immediately).
 */
export const isAdmin = async (req, res, next) => {
  try {
    if (!req.auth?.isAdmin) return send(res, AuthError.ADMIN_REQUIRED);
    const exists = await Admin.exists({ _id: req.auth.id });
    if (!exists) return send(res, AuthError.ADMIN_REQUIRED);
    next();
  } catch (err) {
    console.error('Admin check failed:', err.message);
    return send(res, AuthError.ADMIN_REQUIRED);
  }
};

/** Convenience: authenticate + isAdmin in one array. */
export const adminOnly = [authenticate, isAdmin];
