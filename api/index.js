// Vercel serverless entry: every request is routed here (see vercel.json).
// The same Express app runs as a normal server locally / on Render via `npm start`.
import '../src/serverless-boot.js';
import app, { ready } from '../src/app.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  try {
    await ready(); // DB connection + one-time setup, reused while the instance is warm
  } catch (err) {
    console.error('Startup failed:', err);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, message: 'Service is starting up, please retry in a moment' }));
    return;
  }
  app(req, res);
}
