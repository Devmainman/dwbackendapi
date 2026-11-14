// Vercel serverless entry: every request is routed here (see vercel.json).
// The same Express app runs as a normal server locally / on Render via `npm start`.
//
// The app is loaded with a dynamic import so that a startup failure (missing
// environment variables, database unreachable, a module error) is reported as a
// readable JSON error and in the function logs, instead of a bare
// FUNCTION_INVOCATION_FAILED page.
import '../src/serverless-boot.js';

let loaded = null;
const load = () => {
  if (!loaded) {
    loaded = import('../src/app.js').catch((err) => { loaded = null; throw err; });
  }
  return loaded;
};

const send = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
};

// Only safe, configuration-level reasons are shown to callers; everything else stays in the logs.
const publicReason = (err) => {
  const m = String(err?.message || '');
  if (err?.expose || /Missing required environment variables/.test(m)) return m;
  if (/ENOTFOUND|ECONNREFUSED|querySrv|Server selection timed out|bad auth|Authentication failed|IP.*whitelist|not authorized/i.test(m)) {
    return 'Cannot reach MongoDB. Check MONGO_URI and allow Vercel in Atlas Network Access (0.0.0.0/0).';
  }
  return 'The API failed to start. See the Vercel function logs for details.';
};

export default async function handler(req, res) {
  let mod;
  try {
    mod = await load();
  } catch (err) {
    console.error('[startup] app failed to load:', err);
    return send(res, 500, { success: false, stage: 'load', message: publicReason(err) });
  }
  try {
    await mod.ready(); // DB connection + one-time setup, reused while the instance is warm
  } catch (err) {
    console.error('[startup] ready() failed:', err);
    return send(res, 503, { success: false, stage: 'database', message: publicReason(err) });
  }
  return mod.default(req, res);
}
