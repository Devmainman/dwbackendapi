// File storage for uploads.
//
// Locally / on Render, uploads are written to src/uploads and served by
// express.static (unchanged behaviour).
//
// On Vercel the filesystem is read-only and not persistent, so when a Vercel
// Blob store is connected (BLOB_READ_WRITE_TOKEN or BLOB_STORE_ID) every uploaded file is saved
// to Blob under the same relative path. Controllers keep storing the usual
// "/uploads/<folder>/<file>" strings; the /uploads route redirects to Blob.
// Identity documents (PRIVATE_UPLOAD_DIRS) are stored under an HMAC-derived,
// unguessable key and only ever streamed through the signed-URL route.
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import { UPLOAD_ROOT, PRIVATE_UPLOAD_DIRS } from '../config/paths.js';

export const isServerless = () => !!process.env.VERCEL;
// Connected either the classic way (read-write token) or the newer way (store ID +
// Vercel OIDC, which @vercel/blob v2 picks up on its own inside a deployment).
export const blobEnabled = () => !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);

const secret = () => process.env.JWT_SECRET || 'storage';
const normalize = (rel) => String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/^uploads\//i, '');

/** Relative path inside uploads (e.g. "payment-proofs/123.png") -> Blob pathname. */
export const blobPathname = (rel) => {
  const r = normalize(rel);
  const top = r.split('/')[0]?.toLowerCase();
  if (PRIVATE_UPLOAD_DIRS.includes(top)) {
    const key = crypto.createHmac('sha256', secret()).update(r).digest('hex').slice(0, 32);
    return `private/${key}/${r}`;
  }
  return `uploads/${r}`;
};

/** Absolute target path (as computed by a controller) -> path relative to the uploads root. */
export const relativeToUploads = (target) => {
  const rel = path.relative(UPLOAD_ROOT, path.resolve(String(target)));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
};

let blobModule = null;
const blob = async () => {
  if (!blobModule) blobModule = await import('@vercel/blob');
  return blobModule;
};

export async function saveToBlob(rel, data, contentType) {
  const { put } = await blob();
  const res = await put(blobPathname(rel), data, {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: contentType || undefined,
    cacheControlMaxAge: 60 * 60 * 24 * 30
  });
  urlCache.set(normalize(rel), res.url);
  return res.url;
}

const urlCache = new Map();
/** Public Blob URL for an uploads-relative path, or null when it doesn't exist. */
export async function blobUrl(rel) {
  const key = normalize(rel);
  if (urlCache.has(key)) return urlCache.get(key);
  try {
    const { head } = await blob();
    const info = await head(blobPathname(key));
    urlCache.set(key, info.url);
    return info.url;
  } catch {
    return null;
  }
}

/**
 * Express middleware: when Blob is enabled, make every uploaded file's .mv()
 * write to Blob instead of the local disk. Controllers don't need to change.
 */
export const routeUploadsToBlob = (req, _res, next) => {
  if (!req.files) return next();
  if (!blobEnabled()) {
    if (!isServerless()) return next();
    // Serverless without a Blob store: fail clearly instead of a read-only-disk crash.
    for (const file of Object.values(req.files).flat()) {
      file.mv = (_target, cb) => {
        const err = Object.assign(new Error('File uploads need Vercel Blob storage connected to this project'), { status: 503 });
        if (typeof cb === 'function') { cb(err); return undefined; }
        return Promise.reject(err);
      };
    }
    return next();
  }
  for (const file of Object.values(req.files).flat()) {
    file.mv = (target, cb) => {
      const job = (async () => {
        const rel = relativeToUploads(target);
        if (!rel) throw new Error('Upload path is outside the uploads folder');
        const data = file.tempFilePath ? await fs.promises.readFile(file.tempFilePath) : file.data;
        await saveToBlob(rel, data, file.mimetype);
      })();
      if (typeof cb === 'function') { job.then(() => cb(), cb); return undefined; }
      return job;
    };
  }
  return next();
};

/** Serve /uploads/*: local file if present, otherwise redirect to Blob. */
export const serveUploadFromBlob = async (req, res, next) => {
  if (!blobEnabled()) return next();
  const rel = normalize(decodeURIComponent(req.path));
  if (!rel) return next();
  const url = await blobUrl(rel);
  if (!url) return next();
  res.set('Cache-Control', 'public, max-age=300');
  return res.redirect(302, url);
};

/** Stream a private file (identity documents) from Blob through our own response. */
export async function streamPrivateFromBlob(folder, file, res) {
  const url = await blobUrl(`${folder}/${file}`);
  if (!url) return false;
  const r = await fetch(url);
  if (!r.ok) return false;
  res.set('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
  res.send(Buffer.from(await r.arrayBuffer()));
  return true;
}

/**
 * On Vercel the deployment filesystem is read-only. Controllers create upload
 * folders with fs.mkdirSync (some at import time), which would crash the
 * function, so folder creation under the uploads root becomes a no-op there.
 */
export function makeUploadsFsSafe() {
  if (!isServerless() || fs.__uploadsSafe) return;
  const inside = (p) => {
    try { return !path.relative(UPLOAD_ROOT, path.resolve(String(p))).startsWith('..'); } catch { return false; }
  };
  const mkdirSync = fs.mkdirSync;
  fs.mkdirSync = function patchedMkdirSync(p, ...rest) {
    if (inside(p)) return undefined;
    return mkdirSync.call(this, p, ...rest);
  };
  const mkdir = fs.promises.mkdir;
  fs.promises.mkdir = async function patchedMkdir(p, ...rest) {
    if (inside(p)) return undefined;
    return mkdir.call(this, p, ...rest);
  };
  fs.__uploadsSafe = true;
  syncBuiltinESMExports(); // so `import { mkdirSync } from 'fs'` sees the patch too
}
