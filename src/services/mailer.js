// Sends email with the SMTP settings the admin saved (Settings → Email / SMTP).
import nodemailer from 'nodemailer';
import Setting from '../models/Setting.js';

export class MailNotConfigured extends Error {}

/** Send one email. Throws MailNotConfigured when SMTP has no host or password set. */
export async function sendMail({ to, subject, html, text }) {
  const s = await Setting.findOne().select('smtpHost smtpPort smtpEncryption smtpUsername smtpPassword smtpMailFromName smtpMailFromAddress websiteName').lean();
  if (!s?.smtpHost || !s?.smtpPassword || !s?.smtpMailFromAddress) {
    throw new MailNotConfigured('Email is not set up');
  }
  const transporter = nodemailer.createTransport({
    host: s.smtpHost,
    port: Number(s.smtpPort) || 587,
    secure: s.smtpEncryption === 'ssl',
    auth: { user: s.smtpUsername, pass: s.smtpPassword }
  });
  await transporter.sendMail({
    from: `${s.smtpMailFromName || s.websiteName || 'Support'} <${s.smtpMailFromAddress}>`,
    to,
    subject,
    text,
    html
  });
}
