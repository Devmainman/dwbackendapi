// Forgot password: email a 6-digit code, then set a new password with it.
// POST /api/users/forgot-password { email }
// POST /api/users/reset-password  { email, code, newPassword }
import crypto from 'crypto';
import User from '../models/User.js';
import { sendMail, MailNotConfigured } from '../services/mailer.js';

const TTL_MS = 15 * 60 * 1000;
const MAX_TRIES = 5;
const hash = (email, code) => crypto.createHash('sha256').update(`${String(email).toLowerCase()}:${code}`).digest('hex');
const cleanEmail = (v) => (typeof v === 'string' ? v.trim().toLowerCase().slice(0, 200) : '');

export const forgotPassword = async (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ success: false, message: 'Enter a valid email address' });

    // Same answer whether or not the account exists, so nobody can probe for emails.
    const done = () => res.json({ success: true, message: 'If an account uses that email, a 6-digit code is on its way. It expires in 15 minutes.' });

    const user = await User.findOne({ email }).select('_id email firstName');
    if (!user) return done();

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    await User.updateOne({ _id: user._id }, { $set: { 'passwordReset.codeHash': hash(email, code), 'passwordReset.expiresAt': new Date(Date.now() + TTL_MS), 'passwordReset.attempts': 0 } });

    try {
      await sendMail({
        to: user.email,
        subject: `Your password reset code: ${code}`,
        text: `Hi${user.firstName ? ` ${user.firstName}` : ''},\n\nYour password reset code is ${code}. It expires in 15 minutes.\n\nIf you didn't ask to reset your password, you can ignore this email.`,
        html: `<p>Hi${user.firstName ? ` ${user.firstName}` : ''},</p><p>Your password reset code is</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>It expires in 15 minutes. If you didn't ask to reset your password, you can ignore this email.</p>`
      });
    } catch (err) {
      await User.updateOne({ _id: user._id }, { $unset: { passwordReset: 1 } });
      if (err instanceof MailNotConfigured) {
        return res.status(503).json({ success: false, message: 'Password reset by email isn’t available right now. Please contact support.' });
      }
      console.error('forgotPassword mail error:', err.message);
      return res.status(502).json({ success: false, message: 'We couldn’t send the email. Please try again in a few minutes.' });
    }
    return done();
  } catch (err) {
    console.error('forgotPassword error:', err);
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
};

export const resetPassword = async (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);
    const code = String(req.body?.code || '').replace(/\D/g, '');
    const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
    if (!email || code.length !== 6) return res.status(400).json({ success: false, message: 'Enter the 6-digit code from the email' });
    if (newPassword.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });

    const user = await User.findOne({ email }).select('+password +passwordReset.codeHash +passwordReset.expiresAt +passwordReset.attempts');
    const r = user?.passwordReset;
    if (!user || !r?.codeHash || !r.expiresAt || r.expiresAt < new Date()) {
      return res.status(400).json({ success: false, message: 'This code has expired. Ask for a new one.' });
    }
    if ((r.attempts || 0) >= MAX_TRIES) {
      await User.updateOne({ _id: user._id }, { $unset: { passwordReset: 1 } });
      return res.status(400).json({ success: false, message: 'Too many wrong codes. Ask for a new one.' });
    }
    const a = Buffer.from(hash(email, code));
    const b = Buffer.from(r.codeHash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      await User.updateOne({ _id: user._id }, { $inc: { 'passwordReset.attempts': 1 } });
      const left = MAX_TRIES - (r.attempts || 0) - 1;
      return res.status(400).json({ success: false, message: left > 0 ? `That code isn’t right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong codes. Ask for a new one.' });
    }

    user.password = newPassword; // the pre-save hook hashes it and refreshes the admin copy
    user.passwordReset = undefined;
    await user.save();
    return res.json({ success: true, message: 'Password updated. You can sign in now.' });
  } catch (err) {
    console.error('resetPassword error:', err);
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
};
