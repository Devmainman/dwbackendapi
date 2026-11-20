// Card details: number generation/validation per network, and encryption at rest.
// The full card number (PAN) and CVV are stored only as AES-256-GCM ciphertext.
// The key is derived (HKDF-SHA256) from CARD_ENCRYPTION_KEY, falling back to JWT_SECRET.
// Changing that secret makes already-issued card details unreadable, so set
// CARD_ENCRYPTION_KEY once in production and keep it.
import crypto from 'crypto';

let cachedKey = null;
let cachedFrom = null;
const key = () => {
  const secret = process.env.CARD_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secret) throw new Error('CARD_ENCRYPTION_KEY or JWT_SECRET must be set to store card details');
  if (cachedKey && cachedFrom === secret) return cachedKey;
  cachedKey = Buffer.from(crypto.hkdfSync('sha256', secret, 'card-vault', 'card-pan-cvv-v1', 32));
  cachedFrom = secret;
  return cachedKey;
};

/** Encrypt a short secret. Output: "v1.<iv>.<tag>.<ciphertext>" (base64url parts). */
export const encrypt = (plain) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
};

export const decrypt = (blob) => {
  const [v, iv, tag, ct] = String(blob || '').split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Card data is not readable');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
};

/* ------------------------------ Luhn ------------------------------ */

export const luhnValid = (num) => {
  const s = String(num);
  if (!/^\d+$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < s.length; i += 1) {
    let d = Number(s[s.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
};

const luhnCheckDigit = (partial) => {
  for (let d = 0; d <= 9; d += 1) if (luhnValid(`${partial}${d}`)) return String(d);
  return '0';
};

/* ------------------------------ Networks ------------------------------ */

const between = (s, len, lo, hi) => { const n = Number(s.slice(0, len)); return n >= lo && n <= hi; };
const randInt = (lo, hi) => crypto.randomInt(lo, hi + 1);

/**
 * Per network: accepted lengths, a prefix test, and how to pick a prefix when generating.
 * Amex is 15 digits with a 4-digit CVV; every other network uses a 3-digit CVV.
 */
export const NETWORK_RULES = {
  visa: { label: 'Visa', lengths: [16, 13, 19], gen: 16, test: (s) => s.startsWith('4'), prefix: () => '4', rule: 'Visa numbers start with 4' },
  mastercard: {
    label: 'Mastercard', lengths: [16], gen: 16,
    test: (s) => between(s, 2, 51, 55) || between(s, 4, 2221, 2720),
    prefix: () => (randInt(0, 1) ? String(randInt(51, 55)) : String(randInt(2221, 2720))),
    rule: 'Mastercard numbers start with 51-55 or 2221-2720'
  },
  amex: { label: 'American Express', lengths: [15], gen: 15, cvv: 4, test: (s) => s.startsWith('34') || s.startsWith('37'), prefix: () => (randInt(0, 1) ? '34' : '37'), rule: 'American Express numbers start with 34 or 37 and have 15 digits' },
  discover: { label: 'Discover', lengths: [16, 19], gen: 16, test: (s) => s.startsWith('6011') || s.startsWith('65') || between(s, 3, 644, 649), prefix: () => '6011', rule: 'Discover numbers start with 6011, 644-649 or 65' },
  unionpay: { label: 'UnionPay', lengths: [16, 17, 18, 19], gen: 16, test: (s) => s.startsWith('62'), prefix: () => '62', rule: 'UnionPay numbers start with 62' },
  verve: { label: 'Verve', lengths: [16, 18, 19], gen: 19, test: (s) => between(s, 6, 506099, 506198) || between(s, 6, 650002, 650027), prefix: () => String(randInt(506100, 506198)), rule: 'Verve numbers start with 506099-506198 or 650002-650027' },
  jcb: { label: 'JCB', lengths: [16, 17, 18, 19], gen: 16, test: (s) => between(s, 4, 3528, 3589), prefix: () => String(randInt(3528, 3589)), rule: 'JCB numbers start with 3528-3589' },
  other: { label: 'Card', lengths: [12, 13, 14, 15, 16, 17, 18, 19], gen: 16, test: () => true, prefix: () => '6', rule: '' }
};

const rulesFor = (network) => NETWORK_RULES[network] || NETWORK_RULES.other;
export const cvvLength = (network) => rulesFor(network).cvv || 3;

/** Returns an error message, or '' when the number fits the network and passes Luhn. */
export const panError = (pan, network) => {
  const r = rulesFor(network);
  if (!/^\d+$/.test(pan)) return 'The card number may only contain digits';
  if (!r.lengths.includes(pan.length)) return `${/^[AEIOU]/.test(r.label) ? 'An' : 'A'} ${r.label} number has ${r.lengths.length === 1 ? r.lengths[0] : r.lengths.join(', ')} digits`;
  if (!r.test(pan)) return r.rule || 'This number does not match the card network';
  if (!luhnValid(pan)) return 'This card number is not valid (check digit fails). Check it or generate one.';
  return '';
};

export const generatePan = (network) => {
  const r = rulesFor(network);
  let body = r.prefix();
  while (body.length < r.gen - 1) body += String(randInt(0, 9));
  return body + luhnCheckDigit(body);
};

export const generateCvv = (network) => {
  const len = cvvLength(network);
  return String(randInt(0, 10 ** len - 1)).padStart(len, '0');
};

/** Expiry 4 years from now, same month. */
export const generateExpiry = (now = new Date()) => ({ expiryMonth: now.getMonth() + 1, expiryYear: now.getFullYear() + 4 });

export const formatExpiry = (m, y) => (m && y ? `${String(m).padStart(2, '0')}/${String(y).slice(-2)}` : '');

/** Expiry must be this month or later, and at most 10 years out. */
export const expiryError = (m, y, now = new Date()) => {
  if (!Number.isInteger(m) || m < 1 || m > 12) return 'Choose an expiry month (1-12)';
  if (!Number.isInteger(y) || y < 2000 || y > 2100) return 'Enter a 4-digit expiry year';
  const cur = now.getFullYear() * 12 + now.getMonth();
  const exp = y * 12 + (m - 1);
  if (exp < cur) return 'The expiry date is in the past';
  if (exp > cur + 120) return 'The expiry date can be at most 10 years away';
  return '';
};

/** "4111 1111 1111 1111" / Amex "3782 822463 10005". */
export const groupPan = (pan) => (pan.length === 15
  ? `${pan.slice(0, 4)} ${pan.slice(4, 10)} ${pan.slice(10)}`
  : pan.replace(/(.{4})/g, '$1 ').trim());

/** PINs that are too easy to guess: one repeated digit, or a straight run (1234, 9876). */
export const weakPin = (pin) => {
  if (/^(\d)\1{3}$/.test(pin)) return true;
  const d = pin.split('').map(Number);
  const step = d[1] - d[0];
  return (step === 1 || step === -1) && d.every((x, i) => i === 0 || x - d[i - 1] === step);
};
