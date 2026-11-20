// A user's realised trading profit across the platform's investment products,
// used for Trader Rewards progress. Every source is the user's own settled records
// (closed positions, settled trades, claimed payouts), net of losses, converted to
// the platform base currency at today's rates.
import mongoose from 'mongoose';
import MarketPosition from '../models/MarketPosition.js';
import CopiedTrade from '../models/CopiedTrade.js';
import BotTrade from '../models/BotTrade.js';
import Trade from '../models/Trade.js';
import MiningReward from '../models/MiningReward.js';
import { StockOrder } from '../models/Stock.js';
import { StakePosition } from '../models/Staking.js';
import { PropertyInvestment } from '../models/RealEstate.js';
import { getBaseCurrency, rateBetween } from './fx.js';

const round2 = (n) => Math.round(n * 100) / 100;

/** Each source: label and an aggregation that returns [{ _id: currency, total }] for one user. */
export const PROFIT_SOURCES = {
  market: {
    label: 'Live trading',
    run: (u) => MarketPosition.aggregate([{ $match: { user: u, status: 'closed' } }, { $group: { _id: '$currency', total: { $sum: '$pnl' } } }])
  },
  copy: {
    label: 'Copy trading',
    run: (u) => CopiedTrade.aggregate([
      { $match: { userId: u, status: 'closed' } },
      { $lookup: { from: 'copytrades', localField: 'copyTradeId', foreignField: '_id', as: 'copy' } },
      { $group: { _id: { $ifNull: [{ $first: '$copy.currency' }, 'USD'] }, total: { $sum: { $subtract: [{ $ifNull: ['$profitLoss', 0] }, { $ifNull: ['$commission', 0] }] } } } }
    ])
  },
  ai: {
    label: 'AI Smart Trader',
    run: (u) => BotTrade.aggregate([{ $match: { user: u } }, { $group: { _id: { $ifNull: ['$currency', 'USD'] }, total: { $sum: '$pnl' } } }])
  },
  stocks: {
    label: 'Stocks',
    run: (u) => StockOrder.aggregate([{ $match: { user: u, side: 'sell', status: 'filled' } }, { $group: { _id: '$currency', total: { $sum: '$realizedPnl' } } }])
  },
  packages: {
    label: 'Trading packages',
    run: (u) => Trade.aggregate([{ $match: { userId: u, status: 'completed' } }, { $group: { _id: { $ifNull: ['$currency', 'USD'] }, total: { $sum: '$earned' } } }])
  },
  staking: {
    label: 'Staking',
    run: (u) => StakePosition.aggregate([{ $match: { user: u } }, { $group: { _id: '$currency', total: { $sum: '$claimedValue' } } }])
  },
  realEstate: {
    label: 'Real estate',
    run: (u) => PropertyInvestment.aggregate([{ $match: { user: u } }, { $group: { _id: '$currency', total: { $sum: '$incomeClaimed' } } }])
  },
  mining: {
    label: 'Mining',
    run: (u) => MiningReward.aggregate([{ $match: { userId: u, status: 'claimed' } }, { $group: { _id: { $ifNull: ['$metadata.currency', 'USD'] }, total: { $sum: '$value' } } }])
  }
};

/**
 * { total, currency (base), breakdown: [{ source, label, amount }] }.
 * `sources` limits which products count (admin setting); default all.
 */
export async function userProfit(userId, sources = Object.keys(PROFIT_SOURCES)) {
  const u = new mongoose.Types.ObjectId(String(userId));
  const base = await getBaseCurrency();
  const breakdown = [];
  for (const key of sources) {
    const src = PROFIT_SOURCES[key];
    if (!src) continue;
    // eslint-disable-next-line no-await-in-loop
    const rows = await src.run(u).catch(() => []);
    let amount = 0;
    for (const r of rows) {
      // eslint-disable-next-line no-await-in-loop
      amount += (r.total || 0) * (r._id === base ? 1 : await rateBetween(r._id || 'USD', base));
    }
    breakdown.push({ source: key, label: src.label, amount: round2(amount) });
  }
  const total = round2(breakdown.reduce((s, b) => s + b.amount, 0));
  return { total, currency: base, breakdown };
}
