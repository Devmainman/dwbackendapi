// One pass of every periodic job. On a normal server these run on timers
// (see app.js startServer). On serverless there are no long-lived timers, so
// runDueJobs() is triggered by traffic (throttled) and by Vercel Cron.
// Every job is idempotent: each record is settled with a status-guarded update.
import { settleDueTrades } from './botTradeEngine.js';
import { runDueBotTrades } from './smartBotEngine.js';
import { finishExpiredSessions } from './miningEngine.js';
import { refreshMarkPrices } from './markPriceFeed.js';
import { syncIfDue } from './fx.js';
import { checkStops } from '../controllers/marketTradingController.js';
import { refreshStockPrices } from './stockPrices.js';
import { runTraderAutopilots } from './traderAutopilot.js';

const safe = (name, fn) => fn().catch((err) => { console.warn(`[jobs] ${name} failed:`, err.message); return null; });

let running = null;
let lastRun = 0;

/** Run every job once. Concurrent callers share the same run. */
export const runDueJobs = () => {
  if (running) return running;
  running = (async () => {
    const started = Date.now();
    const [trades, stops, mining] = await Promise.all([
      safe('trade settlement', settleDueTrades),
      safe('stop monitor', checkStops),
      safe('mining sessions', finishExpiredSessions),
      safe('copy-trading prices', refreshMarkPrices),
      safe('fx sync', syncIfDue),
      safe('ai smart trader', runDueBotTrades),
      safe('stock prices', refreshStockPrices),
      safe('copy-trading autopilot', runTraderAutopilots)
    ]);
    lastRun = Date.now();
    return { trades, stops, mining, ms: lastRun - started };
  })().finally(() => { running = null; });
  return running;
};

/**
 * Express middleware for serverless: at most once per `everyMs` per instance,
 * kick off the jobs without delaying the response (kept alive with waitUntil).
 */
export const jobsOnTraffic = (everyMs = 60 * 1000) => async (req, _res, next) => {
  if (Date.now() - lastRun >= everyMs && !running && !req.path.startsWith('/api/cron')) {
    lastRun = Date.now(); // claim the slot before the async work starts
    const job = runDueJobs();
    try {
      const { waitUntil } = await import('@vercel/functions');
      waitUntil(job);
    } catch {
      /* not on Vercel: the promise simply runs in the background */
    }
  }
  next();
};
