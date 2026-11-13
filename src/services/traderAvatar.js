// Generates a default profile picture for traders who don't have one, so every
// trader always has an image. The SVG is built entirely by the server from the
// trader's initials (letters/digits only), so it carries no user-controlled markup.
import fs from 'fs';
import path from 'path';
import Trader from '../models/Trader.js';
import { uploadDir } from '../config/paths.js';

const PALETTES = [
  ['#EB25C6', '#0E7BF8'], ['#f97316', '#db2777'], ['#10b981', '#0ea5e9'], ['#8b5cf6', '#ec4899'],
  ['#f59e0b', '#ef4444'], ['#06b6d4', '#6366f1'], ['#22c55e', '#14b8a6'], ['#e11d48', '#7c3aed']
];

const hash = (s) => [...String(s)].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 7);

const initialsOf = (t) => {
  const source = (t.fullName || t.username || '?').replace(/[^A-Za-z0-9 _.-]/g, ' ');
  const words = source.split(/[\s_.-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2);
  return letters.toUpperCase().replace(/[^A-Z0-9]/g, '') || '?';
};

export const buildAvatarSvg = (trader) => {
  const [a, b] = PALETTES[Math.abs(hash(trader.traderId || trader.username)) % PALETTES.length];
  const text = initialsOf(trader);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
<rect width="256" height="256" fill="url(#g)"/>
<circle cx="200" cy="56" r="70" fill="#ffffff" fill-opacity="0.08"/>
<circle cx="40" cy="230" r="80" fill="#000000" fill-opacity="0.08"/>
<text x="128" y="128" dy="0.35em" text-anchor="middle" font-family="Montserrat,Segoe UI,Arial,sans-serif" font-size="100" font-weight="700" fill="#ffffff">${text}</text>
</svg>`;
};

/** Write the default avatar file and return its public URL. */
export const createDefaultAvatar = (trader) => {
  const id = String(trader.traderId).replace(/[^A-Za-z0-9_-]/g, '');
  const filename = `default_${id}.svg`;
  fs.writeFileSync(path.join(uploadDir('traders'), filename), buildAvatarSvg(trader));
  return `/uploads/traders/${filename}`;
};

/** Give every trader without a picture (or whose picture file is missing) a default one. */
export const backfillTraderAvatars = async () => {
  const traders = await Trader.find().select('traderId username fullName avatar');
  let fixed = 0;
  for (const t of traders) {
    const local = t.avatar && t.avatar.startsWith('/uploads/') ? path.join(uploadDir(), t.avatar.replace(/^\/uploads\//, '')) : null;
    const missing = !t.avatar || (local && !fs.existsSync(local));
    if (missing) {
      t.avatar = createDefaultAvatar(t);
      // eslint-disable-next-line no-await-in-loop
      await t.save();
      fixed += 1;
    }
  }
  if (fixed) console.log(`Copy trading: generated ${fixed} default trader avatar(s)`);
  return fixed;
};
