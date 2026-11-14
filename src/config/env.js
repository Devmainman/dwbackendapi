// src/config/env.js
// Loads environment variables once, from src/config/config.env when present.
// On hosted platforms (Render, etc.) variables come from the dashboard and the
// file may legitimately be absent, so a missing file is not fatal.
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envPath = path.resolve(__dirname, './config.env');

if (fs.existsSync(envPath)) {
  config({ path: envPath });
} else {
  config(); // fall back to a .env in the working directory, if any
}

const REQUIRED = ['MONGO_URI', 'JWT_SECRET'];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  const msg = `Missing required environment variables: ${missing.join(', ')}`;
  console.error(`${msg}`);
  // On Vercel, throw so api/index.js can show the reason instead of a bare crash.
  if (process.env.VERCEL) throw Object.assign(new Error(msg), { expose: true });
  process.exit(1);
}

if ((process.env.JWT_SECRET || '').length < 32) {
  console.warn(' JWT_SECRET is shorter than 32 characters. Use a long random secret in production.');
}

export default process.env;
