// src/config/paths.js
// Single source of truth for upload directories. Linux file systems are
// case-sensitive, so every module must use these constants rather than
// hand-built "Uploads"/"uploads" strings.
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const SRC_DIR = path.resolve(__dirname, '..');
export const UPLOAD_ROOT = path.join(SRC_DIR, 'uploads');

/** Folders containing identity documents; never served publicly. */
export const PRIVATE_UPLOAD_DIRS = ['id_documents', 'face_images', 'address_proofs'];

export const uploadDir = (...segments) => {
  const dir = path.join(UPLOAD_ROOT, ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/** Reject path traversal in user/admin supplied file names. */
export const safeFileName = (name) => path.basename(String(name || ''));
