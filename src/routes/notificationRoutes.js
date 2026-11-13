import express from 'express';
import { authenticate } from '../middleware/auth.js';
import {
  getNotifications, getNotificationCount, markAsRead, markAsUnread, markAllAsRead,
  deleteNotification, clearNotifications, getNotificationPreferences, updateNotificationPreferences, sendWelcome
} from '../controllers/notificationController.js';

const router = express.Router();
// The WebSocket (/api/notifications/ws) authenticates with its own token query param,
// so let it fall through to the ws handler instead of requiring a Bearer header here.
router.use((req, res, next) => (req.path.startsWith('/ws') ? next('router') : authenticate(req, res, next)));

router.get('/', getNotifications);
router.get('/count', getNotificationCount);
router.get('/preferences', getNotificationPreferences);
router.put('/preferences', updateNotificationPreferences);
router.post('/welcome', sendWelcome);
router.patch('/read-all', markAllAsRead);
router.patch('/:notificationId/read', markAsRead);
router.patch('/:notificationId/unread', markAsUnread);
router.delete('/:notificationId', deleteNotification);
router.delete('/', clearNotifications);

export default router;
