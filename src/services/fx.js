// One place for fiat currency conversion.
//
// Currency.rate means "units of this currency per 1 USD" (USD = 1). Every
// conversion in the app goes through rateBetween()/convert() so the maths is
// identical everywhere: amount_in_B = amount_in_A * rate(B) / rate(A).
//
// Rates are refreshed from a live market feed (open.er-api.com, no key needed)
// on the interval the admin picks in Settings → Currencies, and can also be
// synced on demand from the admin panel.
import axios from 'axios';
import Currency from '../models/Currency.js';
import Setting from '../models/Setting.js';
import { round2 } from '../utils/money.js';

const CACHE_MS = 60 * 1000;
let table = null; // { at, rates: Map<code, ratePerUsd> }

export class CurrencyError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

export const invalidateRates = () => { table = null; };

/** Map of code -> units per 1 USD, normalised so USD is exactly 1. */
export const getRateTable = async () => {
  if (table && Date.now() - table.at < CACHE_MS) return table.rates;
  const rows = await Currency.find({}).select('code rate').lean();
  const usd = rows.find((r) => r.code === 'USD')?.rate || 1;
  const rates = new Map();
  for (const r of rows) {
    if (Number(r.rate) > 0) rates.set(r.code, Number(r.rate) / usd);
  }
  rates.set('USD', 1);
  table = { at: Date.now(), rates };
  return rates;
};

/** Multiplier that turns an amount in `from` into `to`. Throws for unknown codes. */
export const rateBetween = async (from, to) => {
  const a = String(from || 'USD').toUpperCase();
  const b = String(to || 'USD').toUpperCase();
  if (a === b) return 1;
  const rates = await getRateTable();
  const ra = rates.get(a);
  const rb = rates.get(b);
  if (!ra) throw new CurrencyError(`Unsupported currency ${a}`);
  if (!rb) throw new CurrencyError(`Unsupported currency ${b}`);
  return rb / ra;
};

/** Like rateBetween but never throws: unknown codes are treated as 1:1 (display only). */
export const safeRateBetween = async (from, to) => {
  try {
    return await rateBetween(from, to);
  } catch {
    return 1;
  }
};

/** Convert and round to cents. */
export const convert = async (amount, from, to) => round2(Number(amount || 0) * (await rateBetween(from, to)));

/** The platform base currency (Settings → default currency, else USD). */
export const getBaseCurrency = async () => {
  const s = await Setting.findOne().select('defaultCurrency').lean();
  return String(s?.defaultCurrency || 'USD').toUpperCase();
};

// ---------------------------------------------------------------- live sync

const INTERVALS = {
  'Every Hour': 1, 'Every 3 Hours': 3, 'Every 6 Hours': 6, 'Every Six Hours': 6,
  'Every 12 Hours': 12, Daily: 24, Weekly: 168
};
export const intervalHours = (label) => INTERVALS[label] || 6;

/**
 * Pull current USD rates and update every currency the feed knows.
 * Returns { updated, skipped, source, at }.
 */
export const syncLiveRates = async () => {
  const { data } = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 8000 });
  if (data?.result !== 'success' || !data.rates) throw new Error('Rate feed unavailable');
  const rows = await Currency.find({}).select('code rate').lean();
  const ops = [];
  const skipped = [];
  for (const r of rows) {
    const live = Number(data.rates[r.code]);
    if (r.code === 'USD') {
      if (r.rate !== 1) ops.push({ updateOne: { filter: { _id: r._id }, update: { $set: { rate: 1 } } } });
      continue;
    }
    if (live > 0) ops.push({ updateOne: { filter: { _id: r._id }, update: { $set: { rate: live } } } });
    else skipped.push(r.code);
  }
  if (ops.length) await Currency.bulkWrite(ops);
  const at = new Date();
  await Setting.updateOne({}, { $set: { currencyLastSyncedAt: at, currencyRateSource: 'open.er-api.com' } }, { upsert: true });
  invalidateRates();
  return { updated: ops.length, skipped, source: 'open.er-api.com', at };
};

/** Sync if auto-sync is on and the chosen interval has passed. Safe to call often. */
export const syncIfDue = async () => {
  try {
    const s = await Setting.findOne().select('currencyInterval currencyLastSyncedAt currencyAutoSync').lean();
    if (s?.currencyAutoSync === false) return false;
    const every = intervalHours(s?.currencyInterval) * 3600e3;
    const last = s?.currencyLastSyncedAt ? new Date(s.currencyLastSyncedAt).getTime() : 0;
    if (Date.now() - last < every) return false;
    const r = await syncLiveRates();
    console.log(`[fx] synced ${r.updated} currency rates`);
    return true;
  } catch (e) {
    console.warn('[fx] rate sync failed:', e.message);
    return false;
  }
};

let timer = null;
/** Sync at start-up (when stale) and then on the admin-chosen interval. */
export const startFxSyncJob = () => {
  if (process.env.NODE_ENV === 'test' || process.env.FX_SYNC === 'off') return null;
  syncIfDue();
  timer = setInterval(syncIfDue, 15 * 60 * 1000);
  return timer;
};
