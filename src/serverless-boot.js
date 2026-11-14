// Imported first by api/index.js (Vercel). Runs before any controller module
// is evaluated, so folder creation under src/uploads can't crash the function
// on Vercel's read-only filesystem.
import { makeUploadsFsSafe } from './services/storage.js';

makeUploadsFsSafe();
