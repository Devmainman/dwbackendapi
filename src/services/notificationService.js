// Single entry point for in-app notifications: create, count, push in real time.
import mongoose from 'mongoose';
import Notification, { NOTIFICATION_TYPES } from '../models/Notification.js';
import User from '../models/User.js';
import { sendNotification } from './realtime.js';

/** Shape sent to clients (stable `id`, no internal fields). */
export const toClient = (n) => ({
  id: String(n._id),
  type: n.type,
  title: n.title,
  content: n.content,
  link: n.link || '',
  metadata: n.metadata || {},
  isRead: !!n.isRead,
  readAt: n.readAt || null,
  createdAt: n.createdAt
});

export const unreadCountFor = (userId) => Notification.countDocuments({ user: userId, isRead: false });

/** Push the latest unread count (and optionally a new item) to the user's open sessions. */
export const pushUpdate = async (userId, notification = null) => {
  const unreadCount = await unreadCountFor(userId);
  sendNotification(String(userId), {
    kind: notification ? 'notification.created' : 'notification.count',
    notification: notification ? toClient(notification) : undefined,
    unreadCount
  });
  return unreadCount;
};

/**
 * Create a notification for a user.
 * @param {object} data { type, title, content, link, metadata, dedupeKey }
 * Respects the user's in-app preference (security notices are always delivered).
 * Returns the created notification, or null when skipped / duplicate.
 */
export const notifyUser = async (userId, data) => {
  if (!userId || !data?.title) return null;
  try {
    const type = NOTIFICATION_TYPES.includes(data.type) ? data.type : 'system';
    if (type !== 'security') {
      const prefs = await User.findById(userId).select('notificationPreferences.inApp').lean();
      if (!prefs) return null;
      if (prefs.notificationPreferences?.inApp === false) return null;
    }
    const doc = await Notification.create({
      user: userId,
      type,
      title: String(data.title).slice(0, 140),
      content: String(data.content || '').slice(0, 2000),
      link: typeof data.link === 'string' && data.link.startsWith('/') ? data.link.slice(0, 200) : '',
      metadata: data.metadata || {},
      dedupeKey: data.dedupeKey || undefined
    });
    await pushUpdate(userId, doc);
    return doc;
  } catch (err) {
    if (err?.code === 11000) return null; // already notified for this event
    console.error('Notification failed:', err.message);
    return null;
  }
};

/** Notify many users at once (e.g. admin broadcast). */
export const notifyMany = async (userIds, data) => {
  let sent = 0;
  for (const id of userIds) {
    // eslint-disable-next-line no-await-in-loop
    if (await notifyUser(id, data)) sent += 1;
  }
  return sent;
};

/**
 * One-time move of notifications that used to live inside user documents.
 * Idempotent: users are cleared only after their notifications are copied.
 */
export const migrateEmbeddedNotifications = async () => {
  const users = User.find({ 'notifications.0': { $exists: true } }).select('_id notifications').lean().cursor();
  let moved = 0;
  for await (const u of users) {
    const docs = (u.notifications || []).filter((n) => n?.title).map((n) => ({
      _id: new mongoose.Types.ObjectId(),
      user: u._id,
      type: NOTIFICATION_TYPES.includes(n.type) ? n.type : 'system',
      title: String(n.title).slice(0, 140),
      content: String(n.content || '').slice(0, 2000),
      metadata: n.metadata || {},
      isRead: !!n.isRead,
      readAt: n.isRead ? (n.createdAt || new Date()) : null,
      legacyId: n.id,
      createdAt: n.createdAt || new Date(),
      updatedAt: n.createdAt || new Date()
    }));
    if (docs.length) {
      try {
        await Notification.insertMany(docs, { ordered: false });
      } catch (err) {
        if (err?.code !== 11000) throw err;
      }
      moved += docs.length;
    }
    await User.updateOne({ _id: u._id }, { $set: { notifications: [] } });
  }
  if (moved) console.log(`Notifications: moved ${moved} embedded notification(s) to their own collection`);
  return moved;
};
