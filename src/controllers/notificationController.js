import mongoose from 'mongoose';
import Notification from '../models/Notification.js';
import User from '../models/User.js';
import { notifyUser, unreadCountFor, pushUpdate, toClient } from '../services/notificationService.js';
import { handler } from '../services/productService.js';
import { HttpError } from '../utils/wallet.js';

/**
 * Kept for existing callers: createNotification(userId, { type, title, content, metadata }).
 * Returns { success, notification }.
 */
export const createNotification = async (userId, data) => {
  const doc = await notifyUser(userId, data);
  return doc ? { success: true, notification: toClient(doc) } : { success: false };
};

/** GET /api/notifications?filter=all|unread&limit=20&before=<ISO date or id> — newest first, cursor paged */
export const getNotifications = handler(async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const filter = { user: req.user.id };
  if (req.query.filter === 'unread') filter.isRead = false;
  if (req.query.before) {
    const d = new Date(req.query.before);
    if (!Number.isNaN(d.getTime())) filter.createdAt = { $lt: d };
  }
  const [items, unreadCount, total] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean(),
    unreadCountFor(req.user.id),
    Notification.countDocuments({ user: req.user.id })
  ]);
  const hasMore = items.length > limit;
  const page = items.slice(0, limit);
  res.json({
    success: true,
    notifications: page.map(toClient),
    unreadCount,
    total,
    hasMore,
    nextCursor: hasMore ? page[page.length - 1].createdAt : null
  });
});

/** GET /api/notifications/count */
export const getNotificationCount = handler(async (req, res) => {
  res.json({ success: true, unreadCount: await unreadCountFor(req.user.id) });
});

const ownNotification = (req) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.notificationId)) throw new HttpError(404, 'Notification not found');
  return { _id: req.params.notificationId, user: req.user.id };
};

/** PATCH /api/notifications/:notificationId/read */
export const markAsRead = handler(async (req, res) => {
  const n = await Notification.findOneAndUpdate(
    { ...ownNotification(req) },
    [{ $set: { isRead: true, readAt: { $ifNull: ['$readAt', '$$NOW'] } } }],
    { new: true }
  );
  if (!n) throw new HttpError(404, 'Notification not found');
  const unreadCount = await pushUpdate(req.user.id);
  res.json({ success: true, notification: toClient(n), unreadCount });
});

/** PATCH /api/notifications/:notificationId/unread */
export const markAsUnread = handler(async (req, res) => {
  const n = await Notification.findOneAndUpdate({ ...ownNotification(req) }, { $set: { isRead: false, readAt: null } }, { new: true });
  if (!n) throw new HttpError(404, 'Notification not found');
  const unreadCount = await pushUpdate(req.user.id);
  res.json({ success: true, notification: toClient(n), unreadCount });
});

/** PATCH /api/notifications/read-all */
export const markAllAsRead = handler(async (req, res) => {
  const r = await Notification.updateMany({ user: req.user.id, isRead: false }, { $set: { isRead: true, readAt: new Date() } });
  const unreadCount = await pushUpdate(req.user.id);
  res.json({ success: true, updated: r.modifiedCount, unreadCount });
});

/** DELETE /api/notifications/:notificationId */
export const deleteNotification = handler(async (req, res) => {
  const n = await Notification.findOneAndDelete({ ...ownNotification(req) });
  if (!n) throw new HttpError(404, 'Notification not found');
  const unreadCount = await pushUpdate(req.user.id);
  res.json({ success: true, unreadCount });
});

/** DELETE /api/notifications?scope=read|all — clear read (default) or all notifications */
export const clearNotifications = handler(async (req, res) => {
  const filter = { user: req.user.id };
  if (req.query.scope !== 'all') filter.isRead = true;
  const r = await Notification.deleteMany(filter);
  const unreadCount = await pushUpdate(req.user.id);
  res.json({ success: true, deleted: r.deletedCount, unreadCount });
});

/** GET /api/notifications/preferences */
export const getNotificationPreferences = handler(async (req, res) => {
  const user = await User.findById(req.user.id).select('notificationPreferences').lean();
  res.json({ success: true, preferences: { email: true, push: true, inApp: true, ...(user?.notificationPreferences || {}) } });
});

/** PUT /api/notifications/preferences  { email?, push?, inApp? } */
export const updateNotificationPreferences = handler(async (req, res) => {
  const set = {};
  for (const k of ['email', 'push', 'inApp']) {
    if (typeof req.body[k] === 'boolean') set[`notificationPreferences.${k}`] = req.body[k];
  }
  if (!Object.keys(set).length) throw new HttpError(400, 'Nothing to update');
  const user = await User.findByIdAndUpdate(req.user.id, { $set: set }, { new: true }).select('notificationPreferences').lean();
  res.json({ success: true, preferences: user.notificationPreferences });
});

/** POST /api/notifications/welcome — idempotent: one welcome per account */
export const sendWelcome = handler(async (req, res) => {
  await notifyUser(req.user.id, {
    type: 'welcome',
    title: 'Welcome aboard',
    content: 'Your account is ready. Fund your balance to start trading, investing and earning.',
    link: '/deposite',
    dedupeKey: 'welcome'
  });
  res.json({ success: true });
});
