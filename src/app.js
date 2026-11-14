// Environment must load before anything reads process.env.
import env from './config/env.js';

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import qs from 'qs';
import fileUpload from 'express-fileupload';
import expressWs from 'express-ws';
import cookieParser from 'cookie-parser';
import { routeUploadsToBlob, serveUploadFromBlob, streamPrivateFromBlob, blobEnabled, isServerless } from './services/storage.js';
import { runDueJobs, jobsOnTraffic } from './services/jobs.js';

import connectDB from './config/db.js';
import { UPLOAD_ROOT, PRIVATE_UPLOAD_DIRS, safeFileName } from './config/paths.js';
import { trackHistory } from './middleware/trackHistory.js';
import { authenticate, isAdmin, extractUserId, verifyToken } from './middleware/auth.js';
import {
  sanitizeRequest, stripMongoOperators, authLimiter, adminLimiter, apiLimiter, verifySignedFile
} from './middleware/security.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import {
  registerConnection, unregisterConnection, forEachConnection, sendNotification, activeConnections
} from './services/realtime.js';
import { initializeCurrencies } from './utils/initializeCurrencies.js';
import { migrateLegacyCopyData, settleOrphanedPositions } from './services/copyTradingEngine.js';
import { startMarkPriceFeed } from './services/markPriceFeed.js';
import { backfillTraderAvatars } from './services/traderAvatar.js';
import { migrateEmbeddedNotifications } from './services/notificationService.js';
import { migrateLegacyTrades, startTradeSettlementJob } from './services/botTradeEngine.js';
import { migrateLegacySimTrades, startStopMonitor } from './controllers/marketTradingController.js';
import { startMiningJob } from './services/miningEngine.js';
import { startFxSyncJob } from './services/fx.js';

// Existing routes
import userRoutes from './routes/userRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import tradingSimRoutes from './routes/tradingSimulationRoutes.js';
import adminTradingModeRoutes from './routes/admin/tradingModeRoutes.js';
import tradingRoutes from './routes/tradingRoutes.js';
import accountRoutes from './routes/accountRoutes.js';
import paymentRoutes from './routes/paymentRoutes.js';
import adminPaymentRoutes from './routes/admin/paymentRoutes.js';
import withdrawalMethodRoutes from './routes/withdrawalMethodRoutes.js';
import depositRoutes from './routes/depositRoutes.js';
import invoiceRoutes from './routes/invoiceRoutes.js';
import popupFormRoutes from './routes/popupFormRoutes.js';
import popupInvoiceRoutes from './routes/popupInvoiceRoutes.js';
import popupMessageRoutes from './routes/popupMessageRoutes.js';
import assignmentRoutes from './routes/assignmentRoutes.js';
import packageRoutes from './routes/packageRoutes.js';
import popupFetchRoutes from './routes/popupFetchRoutes.js';
import adminPopupManagementRoutes from './routes/adminPopupManagementRoutes.js';
import withdrawalRoutes from './routes/withdrawalRoutes.js';
import publicWithdrawalRoutes from './routes/publicWithdrawalRoutes.js';
import publicPackageRoutes from './routes/publicPackageRoutes.js';
import referralRoutes from './routes/referralRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import verificationRoutes from './routes/verificationRoutes.js';
import adminVerificationRoutes from './routes/adminVerificationRoutes.js';
import messageRoutes from './routes/messageRoutes.js';
import adminTradingRoutes from './routes/adminTradingRoutes.js';
import authRoutes from './routes/authRoutes.js';
import adminWithdrawalRoutes from './routes/adminWithdrawalRoutes.js';
import adminDashboardRoutes from './routes/adminDashboardRoutes.js';
import currencyRoutes from './routes/admin/currencyRoutes.js';
import ticketRoutes from './routes/ticketRoutes.js';
import upgradeInvoiceRoutes from './routes/upgradeInvoiceRoutes.js';
import withdrawalTokenRoutes from './routes/withdrawalTokenRoutes.js';
import publicSettingsRoutes from './routes/publicSettingsRoutes.js';
import historyRoutes from './routes/historyRoutes.js';
import priceRoutes from './routes/priceRoutes.js';
import copyTradingRoutes from './routes/copyTradingRoutes.js';
import miningRoutes from './routes/miningRoutes.js';
import adminMiningRoutes from './routes/adminMiningRoutes.js';
import adminCopyTradingRoutes, { legacyTraderRouter } from './routes/adminCopyTradingRoutes.js';
import userTradeRoutes from './routes/userTradeRoutes.js';
import signalInvoiceRoutes from './routes/signalInvoiceRoutes.js';
import signalUpgradeRoutes from './routes/signalUpgradeRoutes.js';
import publicSignalPackageRoutes from './routes/publicSignalPackageRoutes.js';
import adminSignalPackageRoutes from './routes/adminSignalPackageRoutes.js';
import copiedTradeRoutes from './routes/copiedTradeRoutes.js';
import adminSettingsRoutes from './routes/adminSettingsRoutes.js';

// New product modules
import coldStorageRoutes from './routes/coldStorageRoutes.js';
import cardRoutes from './routes/cardRoutes.js';
import walletRoutes from './routes/walletRoutes.js';
import stockRoutes from './routes/stockRoutes.js';
import stakingRoutes from './routes/stakingRoutes.js';
import realEstateRoutes from './routes/realEstateRoutes.js';
import portfolioRoutes from './routes/portfolioRoutes.js';
import adminProductRoutes from './routes/adminProductRoutes.js';
import adminOpsRoutes from './routes/adminOpsRoutes.js';

import './models/PopupForm.js';
import './models/PopupInvoice.js';
import './models/PopupMessage.js';
import './models/Assignment.js';

const isProd = env.NODE_ENV === 'production';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Render / a reverse proxy

// Sanitize the query string at parse time (req.query is read-only in Express 5).
app.set('query parser', (str) => stripMongoOperators(qs.parse(str, { depth: 5, arrayLimit: 100 })));

const expressWsInstance = expressWs(app);
app.wsInstance = expressWsInstance;

/* ----------------------------- Security ----------------------------- */

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // images are loaded by the SPA on another origin
  contentSecurityPolicy: false // pure JSON API; the SPA sets its own CSP
}));

const allowedOrigins = [env.FRONTEND_URL, env.ADMIN_URL, ...(env.CORS_ORIGINS || '').split(',')]
  .map((o) => (o || '').trim().replace(/\/$/, ''))
  .filter(Boolean);

if (allowedOrigins.length === 0) {
  console.warn('⚠️  CORS_ORIGINS / FRONTEND_URL not set: allowing all origins. Set them in production.');
}

// Entries may contain one wildcard label, e.g. https://*.vercel.app for preview deployments.
const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
const originPatterns = allowedOrigins
  .filter((o) => o.includes('*'))
  .map((o) => new RegExp(`^${escapeRe(o).replace('\\*', '*').replace('*', '[a-z0-9-]+')}$`, 'i'));
const originAllowed = (origin) => {
  const o = origin.replace(/\/$/, '');
  return allowedOrigins.includes(o) || originPatterns.some((re) => re.test(o));
};

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.length === 0 || originAllowed(origin)) {
      return cb(null, true);
    }
    return cb(null, false);
  },
  credentials: true
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());
app.use(fileUpload({
  limits: { fileSize: 5 * 1024 * 1024 },
  abortOnLimit: true,
  useTempFiles: false,
  parseNested: true,
  createParentPath: true,
  safeFileNames: true, // strips path separators and other unsafe characters
  preserveExtension: 4
}));

// Only images and PDFs may be uploaded anywhere (blocks .html/.svg/.js stored-XSS and executables).
const ALLOWED_UPLOAD_EXT = /\.(jpe?g|png|gif|webp|jfif|pdf)$/i;
app.use((req, res, next) => {
  if (!req.files) return next();
  const files = Object.values(req.files).flat();
  const bad = files.find((f) => !ALLOWED_UPLOAD_EXT.test(f.name || '') ||
    !/^(image\/(jpeg|png|gif|webp|pjpeg)|application\/pdf)$/i.test(f.mimetype || ''));
  if (bad) return res.status(400).json({ success: false, message: 'Only JPG, PNG, GIF, WEBP or PDF files are allowed' });
  next();
});
app.use(sanitizeRequest);
app.use(routeUploadsToBlob); // Vercel: uploads go to Blob storage instead of the read-only disk

/* --------------------------- Static files --------------------------- */

if (!isServerless()) fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

// Identity documents are never served statically.
const blockPrivateUploads = (req, res, next) => {
  const first = decodeURIComponent(req.path).split('/').filter(Boolean)[0]?.toLowerCase();
  if (first && PRIVATE_UPLOAD_DIRS.includes(first)) {
    return res.status(404).json({ success: false, message: 'Not found' });
  }
  next();
};
const staticOpts = { dotfiles: 'deny', index: false, maxAge: isProd ? '7d' : 0 };

app.use('/uploads', blockPrivateUploads, express.static(UPLOAD_ROOT, staticOpts), serveUploadFromBlob);
app.use('/Uploads', blockPrivateUploads, express.static(UPLOAD_ROOT, staticOpts), serveUploadFromBlob); // legacy URLs
app.use('/icons', express.static(path.join(UPLOAD_ROOT, 'icons'), staticOpts));

// Short-lived signed access to identity documents (URLs are generated for admins).
app.get('/api/files/private/:folder/:file', async (req, res) => {
  const folder = String(req.params.folder);
  const file = safeFileName(req.params.file);
  if (!PRIVATE_UPLOAD_DIRS.includes(folder) || !verifySignedFile(folder, file, req.query.exp, req.query.sig)) {
    return res.status(403).json({ success: false, message: 'Link expired or invalid' });
  }
  res.set('Cache-Control', 'private, no-store');
  const local = path.join(UPLOAD_ROOT, folder, file);
  if (blobEnabled() && !fs.existsSync(local)) {
    const ok = await streamPrivateFromBlob(folder, file, res).catch(() => false);
    if (!ok && !res.headersSent) res.status(404).json({ success: false, message: 'File not found' });
    return;
  }
  res.sendFile(local, (err) => {
    if (err && !res.headersSent) res.status(404).json({ success: false, message: 'File not found' });
  });
});

/* ------------------------------ Routes ------------------------------ */

app.use('/api', apiLimiter);
app.use(trackHistory);

// Serverless: periodic jobs (settlement, stop-loss, mining, prices, FX) run on traffic + cron.
if (isServerless()) app.use(jobsOnTraffic());

// Vercel Cron (and any scheduler) can call this. Protected by CRON_SECRET when set.
app.get('/api/cron/tick', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.get('authorization') !== `Bearer ${secret}`) return res.status(401).json({ success: false, message: 'Unauthorized' });
  const result = await runDueJobs();
  res.json({ success: true, ...result });
});

app.get('/', (_req, res) => res.send('API is running...'));
app.get('/api/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Auth-sensitive endpoints get a stricter limiter.
app.use(['/api/users/login', '/api/users/signup', '/api/admin/login', '/api/auth/admin-access', '/api/verification/verify-otp'], authLimiter);

app.use('/api', authRoutes);
app.use('/api/users', userRoutes);

app.use('/api/admin', adminLimiter);
app.use('/api/admin', adminRoutes);
app.use('/api/verification', verificationRoutes);
app.use('/api/trading', tradingRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/trading/market', authenticate, tradingSimRoutes);
app.use('/api/trading/sim', authenticate, tradingSimRoutes);
app.use('/api/admin/trading-mode', authenticate, isAdmin, adminTradingModeRoutes);
app.use('/api/admin/payments', adminPaymentRoutes);
app.use('/api/admin/withdrawal-methods', withdrawalMethodRoutes);
app.use('/api/deposits', depositRoutes);
app.use('/api/admin/popup-forms', popupFormRoutes);
app.use('/api/admin/popup-invoices', popupInvoiceRoutes);
app.use('/api/admin/popup-messages', popupMessageRoutes);
app.use('/api/admin/assignments', assignmentRoutes);
app.use('/api/packages', packageRoutes);
app.use('/api/admin', adminPopupManagementRoutes);
app.use('/api/withdrawals', withdrawalRoutes);
app.use('/api', publicWithdrawalRoutes);
app.use('/api/public/packages', publicPackageRoutes);
app.use('/api/referrals', referralRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api', popupFetchRoutes);
app.use('/api/admin/verifications', adminVerificationRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/admin/trading', adminTradingRoutes);
app.use('/api/admin/withdrawals', adminWithdrawalRoutes);
app.use('/api/admin/dashboard', adminDashboardRoutes);
app.use('/api/admin/currencies', currencyRoutes);
app.use('/api/upgradeinvoices', upgradeInvoiceRoutes);
app.use('/api/admin/invoices', invoiceRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/admin/withdrawal-tokens', withdrawalTokenRoutes);
app.use('/api/public/settings', publicSettingsRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/market', priceRoutes);
app.use('/api/copy-trading', copyTradingRoutes);
app.use('/api/mining', miningRoutes);
app.use('/api/admin/mining', adminMiningRoutes);
app.use('/api/user-trades', userTradeRoutes);
app.use('/api/admin/copy-trading', adminCopyTradingRoutes);
app.use('/api/signals/invoices', signalInvoiceRoutes);
app.use('/api/signal-upgrade', signalUpgradeRoutes);
app.use('/api/public', publicSignalPackageRoutes);
app.use('/api/admin/signal-packages', adminSignalPackageRoutes);
app.use('/api/copied-trades', copiedTradeRoutes);
app.use('/api/admin/traders', legacyTraderRouter);
app.use('/api/admin/settings', adminSettingsRoutes);

// New product modules
app.use('/api/cold-storage', coldStorageRoutes);
app.use('/api/cards', cardRoutes);
app.use('/api/wallets', walletRoutes);
app.use('/api/stocks', stockRoutes);
app.use('/api/staking', stakingRoutes);
app.use('/api/real-estate', realEstateRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/admin/products', adminProductRoutes);
app.use('/api/admin/ops', adminOpsRoutes);

/* ---------------------------- WebSockets ---------------------------- */

expressWsInstance.app.ws('/api/notifications/ws', (ws, req) => {
  const token = req.query.token;
  if (!token) return ws.close(4001, 'Authentication token required');

  let userId;
  try {
    userId = extractUserId(verifyToken(String(token)));
  } catch {
    return ws.close(4001, 'Invalid token');
  }
  if (!userId) return ws.close(4001, 'Invalid user identification');

  ws.userId = String(userId);
  ws.isAlive = true;
  registerConnection(ws.userId, ws);
  ws.send(JSON.stringify({ type: 'connection', status: 'success', timestamp: Date.now() }));

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => unregisterConnection(ws.userId, ws));
  ws.on('error', () => {
    unregisterConnection(ws.userId, ws);
    ws.terminate();
  });
});

// 404 + error handlers must come after every route, including the WebSocket one.
app.use('/api', notFound);
app.use(errorHandler);

/* ------------------------------ Startup ----------------------------- */

// One-time setup (DB connection, seed data, idempotent migrations). Memoised so a
// serverless instance does it once per cold start.
let readyPromise = null;
export const ready = () => {
  if (!readyPromise) {
    readyPromise = (async () => {
      await connectDB();
      await initializeCurrencies();
      await migrateLegacyCopyData().catch((err) => console.error('Copy trading migration failed:', err));
      await migrateEmbeddedNotifications().catch((err) => console.error('Notification migration failed:', err));
      await backfillTraderAvatars().catch((err) => console.error('Trader avatar backfill failed:', err));
      await settleOrphanedPositions().catch((err) => console.error('Copy trading recovery failed:', err));
      await migrateLegacyTrades().catch((err) => console.error('Legacy trade migration failed:', err));
      await migrateLegacySimTrades().catch((err) => console.error('Legacy sim migration failed:', err));
    })().catch((err) => { readyPromise = null; throw err; });
  }
  return readyPromise;
};

/** Long-running server (local, Render, VPS): listen + background timers + WebSocket heartbeat. */
export const startServer = async () => {
  await ready();
  const PORT = env.PORT || 5000;
  const heartbeatInterval = setInterval(() => {
    forEachConnection((ws, userId) => {
      if (ws.isAlive === false) {
        unregisterConnection(userId, ws);
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);
  const priceFeed = env.NODE_ENV === 'test' ? null : startMarkPriceFeed();
  const tradeJob = startTradeSettlementJob();
  const stopMonitor = env.NODE_ENV === 'test' ? null : startStopMonitor();
  const miningJob = startMiningJob();
  const fxJob = startFxSyncJob();
  const server = app.listen(PORT, () => {
    console.log(`Server running in ${env.NODE_ENV || 'development'} mode on port ${PORT}`);
  });

  const shutdown = () => {
    clearInterval(heartbeatInterval);
    if (priceFeed) clearInterval(priceFeed);
    clearInterval(tradeJob);
    if (stopMonitor) clearInterval(stopMonitor);
    clearInterval(miningJob);
    if (fxJob) clearInterval(fxJob);
    forEachConnection((ws) => ws.close(1001, 'Server shutting down'));
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
};

// On Vercel the app is exported to api/index.js instead of listening itself.
if (!isServerless()) {
  startServer().catch((err) => {
    console.error('Server failed to start:', err);
    process.exit(1);
  });
}

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

export { sendNotification, activeConnections };
export default app;
