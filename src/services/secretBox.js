// Encryption for small secrets kept at rest (AES-256-GCM).
// The key is derived (HKDF-SHA256) from SECRET_BOX_KEY, falling back to
// CARD_ENCRYPTION_KEY and then JWT_SECRET, with a separate `purpose` per use so
// one kind of secret can never be decrypted as another. Changing the secret
// makes stored values unreadable, so set it once in production and keep it.
import crypto from 'crypto';

const keys = new Map();
const keyFor = (purpose) => {
  const secret = process.env.SECRET_BOX_KEY || process.env.CARD_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secret) throw new Error('SECRET_BOX_KEY, CARD_ENCRYPTION_KEY or JWT_SECRET must be set');
  const id = `${purpose}|${secret}`;
  if (!keys.has(id)) keys.set(id, Buffer.from(crypto.hkdfSync('sha256', secret, 'secret-box', purpose, 32)));
  return keys.get(id);
};

/** Encrypt `plain` for `purpose`. Output: "s1.<iv>.<tag>.<ciphertext>" (base64url parts). */
export const seal = (plain, purpose) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFor(purpose), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['s1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
};

/** Decrypt a value from seal(); throws if it was tampered with or sealed for another purpose. */
export const open = (blob, purpose) => {
  const [v, iv, tag, ct] = String(blob || '').split('.');
  if (v !== 's1' || !iv || !tag || !ct) throw new Error('Value is not readable');
  const d = crypto.createDecipheriv('aes-256-gcm', keyFor(purpose), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
};

export const PASSWORD_PURPOSE = 'user-password-v1';
