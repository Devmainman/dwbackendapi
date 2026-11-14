// Support tickets. Users open tickets and reply; support (admin) replies and closes.
// Mounted at /api/tickets
import express from 'express';
import mongoose from 'mongoose';
import crypto from 'crypto';
import path from 'path';
import { authenticate } from '../middleware/auth.js';
import Ticket from '../models/Ticket.js';
import User from '../models/User.js';
import { uploadDir } from '../config/paths.js';
import { notifyUser } from '../services/notificationService.js';

const router = express.Router();
const PRIORITIES = ['Low', 'Medium', 'High'];
const ALLOWED = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf' };
const MAX_FILE = 2 * 1024 * 1024;

const fail = (res, status, message) => res.status(status).json({ success: false, message });
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Save an optional upload safely: type-checked, size-checked, random file name. */
async function saveAttachment(req) {
  const file = req.files?.attachment;
  if (!file) return null;
  if (Array.isArray(file)) throw Object.assign(new Error('Attach one file at a time'), { status: 400 });
  if (file.size > MAX_FILE) throw Object.assign(new Error('File size exceeds 2MB limit'), { status: 400 });
  const ext = ALLOWED[file.mimetype];
  if (!ext) throw Object.assign(new Error('Only images (JPG, PNG, WEBP, GIF) or PDF files are allowed'), { status: 400 });
  const name = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`;
  await file.mv(path.join(uploadDir('tickets'), name));
  return `/uploads/tickets/${name}`;
}

const present = (t) => ({
  ...t,
  id: t._id,
  lastMessageAt: t.messages?.length ? t.messages[t.messages.length - 1].timestamp : t.createdAt,
  unreadForUser: t.messages?.length ? t.messages[t.messages.length - 1].sender === 'support' : false
});

const loadOwned = async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) { fail(res, 400, 'Invalid ticket'); return null; }
  const ticket = await Ticket.findById(req.params.id);
  if (!ticket) { fail(res, 404, 'Ticket not found'); return null; }
  if (!req.user.isAdmin && String(ticket.userId) !== String(req.user.id)) { fail(res, 403, 'Unauthorized'); return null; }
  return ticket;
};

// Create a ticket
router.post('/', authenticate, async (req, res) => {
  try {
    const subject = text(req.body.subject, 140);
    const message = text(req.body.message, 4000);
    const priority = PRIORITIES.find((p) => p.toLowerCase() === String(req.body.priority || '').toLowerCase());
    if (!subject || !message) return fail(res, 400, 'Subject and message are required');
    if (!priority) return fail(res, 400, 'Choose a priority: Low, Medium or High');

    const open = await Ticket.countDocuments({ userId: req.user.id, status: 'Open' });
    if (open >= 10) return fail(res, 429, 'You have 10 open tickets. Please wait for a reply before opening more.');

    const user = await User.findById(req.user.id).select('firstName lastName email accountType').populate('accountType', 'name').lean();
    const attachment = await saveAttachment(req);
    const ticket = await Ticket.create({
      userId: req.user.id,
      subject,
      priority,
      status: 'Open',
      customer: {
        name: [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || 'Customer',
        email: user?.email || '',
        accountType: user?.accountType?.name || 'Basic'
      },
      messages: [{ sender: 'user', text: message, attachments: attachment ? [attachment] : [] }]
    });
    res.status(201).json({ success: true, ticket: present(ticket.toObject()) });
  } catch (error) {
    if (error.status) return fail(res, error.status, error.message);
    console.error('Error creating ticket:', error);
    return fail(res, 500, 'Could not create the ticket');
  }
});

// List tickets: the user's own, or all for support (?status=Open|Closed&search=)
router.get('/', authenticate, async (req, res) => {
  try {
    const query = req.user.isAdmin ? {} : { userId: req.user.id };
    if (['Open', 'Closed'].includes(req.query.status)) query.status = req.query.status;
    const search = text(req.query.search, 60);
    if (search && req.user.isAdmin) {
      const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [{ subject: re }, { 'customer.email': re }, { 'customer.name': re }];
    }
    const tickets = await Ticket.find(query).sort({ updatedAt: -1 }).limit(200).lean();
    res.json({ success: true, tickets: tickets.map(present) });
  } catch (error) {
    console.error('Error fetching tickets:', error);
    fail(res, 500, 'Could not load tickets');
  }
});

// One ticket with its conversation
router.get('/:id', authenticate, async (req, res) => {
  try {
    const ticket = await loadOwned(req, res);
    if (!ticket) return;
    res.json({ success: true, ticket: present(ticket.toObject()) });
  } catch (error) {
    console.error('Error fetching ticket:', error);
    fail(res, 500, 'Could not load the ticket');
  }
});

// Reply (user or support). Replying reopens a closed ticket for the user side.
router.post('/:id/messages', authenticate, async (req, res) => {
  try {
    const body = text(req.body.text, 4000);
    const ticket = await loadOwned(req, res);
    if (!ticket) return;
    const attachment = await saveAttachment(req);
    if (!body && !attachment) return fail(res, 400, 'Write a message or attach a file');
    if (ticket.status === 'Closed' && !req.user.isAdmin) ticket.status = 'Open';

    const fromSupport = !!req.user.isAdmin;
    ticket.messages.push({ sender: fromSupport ? 'support' : 'user', text: body || 'Attachment', attachments: attachment ? [attachment] : [] });
    ticket.updatedAt = Date.now();
    await ticket.save();

    if (fromSupport) {
      await notifyUser(ticket.userId, {
        type: 'message',
        title: `Support replied · ${ticket.subject}`.slice(0, 140),
        content: body.slice(0, 200),
        link: '/support',
        metadata: { ticketId: ticket._id }
      });
    }
    res.json({ success: true, ticket: present(ticket.toObject()) });
  } catch (error) {
    if (error.status) return fail(res, error.status, error.message);
    console.error('Error sending message:', error);
    fail(res, 500, 'Could not send the message');
  }
});

// Close (the ticket owner or support)
router.put('/:id/close', authenticate, async (req, res) => {
  try {
    const ticket = await loadOwned(req, res);
    if (!ticket) return;
    ticket.status = 'Closed';
    ticket.updatedAt = Date.now();
    await ticket.save();
    if (req.user.isAdmin) {
      await notifyUser(ticket.userId, { type: 'message', title: 'Ticket closed', content: ticket.subject, link: '/support', metadata: { ticketId: ticket._id } });
    }
    res.json({ success: true, ticket: present(ticket.toObject()) });
  } catch (error) {
    console.error('Error closing ticket:', error);
    fail(res, 500, 'Could not close the ticket');
  }
});

// Reopen (support)
router.put('/:id/reopen', authenticate, async (req, res) => {
  try {
    const ticket = await loadOwned(req, res);
    if (!ticket) return;
    ticket.status = 'Open';
    ticket.updatedAt = Date.now();
    await ticket.save();
    res.json({ success: true, ticket: present(ticket.toObject()) });
  } catch (error) {
    console.error('Error reopening ticket:', error);
    fail(res, 500, 'Could not reopen the ticket');
  }
});

export default router;
