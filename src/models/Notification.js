import mongoose from 'mongoose';

export const NOTIFICATION_TYPES = [
  'system', 'transaction', 'account', 'promo', 'welcome', 'security',
  'deposit', 'withdrawal', 'trading', 'copy_trading', 'staking', 'real_estate', 'card', 'message'
];

/**
 * One in-app notification. Stored in its own collection (not inside the user
 * document) so it can be paged, counted and expired efficiently.
 */
const notificationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: NOTIFICATION_TYPES, default: 'system' },
  title: { type: String, required: true, trim: true, maxlength: 140 },
  content: { type: String, trim: true, maxlength: 2000, default: '' },
  link: { type: String, trim: true, maxlength: 200, default: '' },   // in-app route to open, e.g. "/copy-positions"
  metadata: { type: Object, default: {} },
  // Prevents the same event notifying twice (unique per user when set).
  dedupeKey: { type: String, trim: true, maxlength: 120 },
  isRead: { type: Boolean, default: false },
  readAt: { type: Date, default: null },
  legacyId: { type: String } // id from the old embedded notifications, kept for migration
}, { timestamps: true });

notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ user: 1, isRead: 1 });
notificationSchema.index({ user: 1, dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } });
// Notifications older than 180 days are removed automatically.
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

export default mongoose.model('Notification', notificationSchema);
