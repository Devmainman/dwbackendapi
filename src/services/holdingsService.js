// Everything a user owns, itemised and valued in their current currency.
// Each product keeps the currency it was opened in; values are converted at
// today's rate so the totals add up correctly after a currency switch.
import User from '../models/User.js';
import ColdStorageVault from '../models/ColdStorageVault.js';
import Trade from '../models/Trade.js';
import MarketPosition from '../models/MarketPosition.js';
import CopyTrade from '../models/CopyTrade.js';
import MiningReward from '../models/MiningReward.js';
import { StockHolding } from '../models/Stock.js';
import { CryptoAsset, CryptoWallet } from '../models/Crypto.js';
import { getCryptoPrices } from './cryptoMarket.js';
import { StakePosition } from '../models/Staking.js';
import { PropertyInvestment } from '../models/RealEstate.js';
import { valueCopies } from './copyTradingEngine.js';
import { tradeState } from './botTradeEngine.js';
import { getQuotes } from './marketData.js';
import { getUsdPrices } from './priceService.js';
import { safeRateBetween, getBaseCurrency } from './fx.js';
import { round2 } from '../utils/money.js';
import { rewardState } from '../controllers/stakingController.js';
import { pnlPercentAt } from '../controllers/marketTradingController.js';

export const GROUPS = {
  cash: { label: 'Cash', color: '#3b82f6' },
  coins: { label: 'Crypto', color: '#f97316' },
  crypto: { label: 'Staked crypto', color: '#f59e0b' },
  stocks: { label: 'Stocks', color: '#0ea5e9' },
  realEstate: { label: 'Real estate', color: '#14b8a6' },
  trading: { label: 'Trading', color: '#8b5cf6' },
  copyTrading: { label: 'Copy trading', color: '#ec4899' },
  coldStorage: { label: 'Cold storage', color: '#22d3ee' },
  mining: { label: 'Mining', color: '#84cc16' }
};

export async function buildHoldings(userId) {
  const now = new Date();
  const user = await User.findById(userId).select('balance currency').lean();
  if (!user) return null;
  const cur = user.currency || 'USD';
  const rateCache = new Map();
  const toUser = async (amount, from) => {
    const key = String(from || cur).toUpperCase();
    if (!rateCache.has(key)) rateCache.set(key, await safeRateBetween(key, cur));
    return round2((Number(amount) || 0) * rateCache.get(key));
  };

  const [vaults, holdings, stakes, props, trades, positions, copiesRaw, rewards, base, coinWallets] = await Promise.all([
    ColdStorageVault.find({ user: userId, status: { $ne: 'closed' } }).lean(),
    StockHolding.find({ user: userId, shares: { $gt: 0 } }).populate('stock', 'symbol name price previousClose logo').lean(),
    StakePosition.find({ user: userId, status: 'active' }).lean(),
    PropertyInvestment.find({ user: userId, status: 'active' }).populate('property', 'title images location').lean(),
    Trade.find({ userId, status: 'in-progress' }).lean(),
    MarketPosition.find({ user: userId, status: 'open' }).lean(),
    CopyTrade.find({ userId, isOpen: true }).lean(),
    MiningReward.find({ userId, status: 'pending' }).lean(),
    getBaseCurrency(),
    CryptoWallet.find({ user: userId, balance: { $gt: 0 } }).lean()
  ]);

  const [stakePrices, quotes, copies] = await Promise.all([
    getUsdPrices(stakes.map((p) => p.asset), Object.fromEntries(stakes.map((p) => [p.asset, p.priceAtStake]))),
    positions.length ? getQuotes([...new Set(positions.map((p) => p.symbol))]).catch(() => ({})) : {},
    valueCopies(copiesRaw)
  ]);

  const items = [];
  const push = (o) => items.push({ ...o, pnl: o.cost != null ? round2(o.value - o.cost) : null, pnlPercent: o.cost ? round2(((o.value - o.cost) / o.cost) * 100) : null });

  push({ id: 'cash', group: 'cash', name: 'Spendable balance', symbol: cur, value: round2(user.balance || 0), cost: null, link: '/deposite' });

  // Coins in the user's crypto wallets (deposits and conversions), valued at the live price.
  if (coinWallets.length) {
    const [coinPrices, coinAssets] = await Promise.all([
      getCryptoPrices().catch(() => ({})),
      CryptoAsset.find({ symbol: { $in: coinWallets.map((w) => w.symbol) } }).select('symbol name icon').lean()
    ]);
    const meta = new Map(coinAssets.map((a) => [a.symbol, a]));
    for (const w of coinWallets) {
      const p = coinPrices[w.symbol];
      const a = meta.get(w.symbol);
      const value = p ? await toUser(w.balance * p.usd, 'USD') : 0; // eslint-disable-line no-await-in-loop
      const change = p?.change24h != null ? Math.round(p.change24h * 100) / 100 : null;
      push({
        id: String(w._id), group: 'coins', name: a?.name || w.symbol, symbol: w.symbol, icon: a?.icon, quantity: w.balance, unit: w.symbol,
        value, cost: null, dayChange: change, detail: p ? (change != null ? `${change >= 0 ? '+' : ''}${change}% today` : null) : 'Price unavailable', link: '/wallet'
      });
    }
  }

  for (const h of holdings) {
    if (!h.stock) continue;
    const value = await toUser(h.shares * h.stock.price, base);
    const cost = await toUser(h.costBasis, h.currency);
    const dayPct = h.stock.previousClose ? round2(((h.stock.price - h.stock.previousClose) / h.stock.previousClose) * 100) : 0;
    push({ id: String(h._id), group: 'stocks', name: h.stock.name, symbol: h.stock.symbol, icon: h.stock.logo, quantity: h.shares, unit: 'shares', value, cost, dayChange: dayPct, link: '/invest' });
  }

  for (const p of stakes) {
    const r = rewardState(p, now);
    const usd = stakePrices[p.asset] || p.priceAtStake || 0;
    const value = await toUser((p.assetAmount + r.unclaimed) * usd, 'USD');
    const cost = await toUser(p.amount, p.currency);
    push({
      id: String(p._id), group: 'crypto', name: p.assetName || p.asset, symbol: p.asset, quantity: round2(p.assetAmount + r.unclaimed), unit: p.asset,
      value, cost, apy: p.apy, detail: p.lockDays ? `${p.lockDays}-day lock` : 'Flexible', link: '/staking'
    });
  }

  for (const i of props) {
    const span = new Date(i.maturityAt) - new Date(i.startAt);
    const elapsed = Math.min(span, Math.max(0, now - new Date(i.startAt)));
    const earned = span > 0 ? i.amount * (i.roi / 100) * (elapsed / span) : 0;
    const value = await toUser(i.amount + Math.max(0, earned - (i.incomeClaimed || 0)), i.currency);
    const cost = await toUser(i.amount, i.currency);
    push({
      id: String(i._id), group: 'realEstate', name: i.property?.title || 'Project', symbol: 'RE', icon: i.property?.images?.[0],
      value, cost, detail: `Matures ${new Date(i.maturityAt).toISOString().slice(0, 10)}`, link: i.property ? `/real-estate/${i.property._id}` : '/real-estate'
    });
  }

  for (const t of trades) {
    const s = tradeState(t, now);
    const value = await toUser(t.amount + s.earned, t.currency);
    const cost = await toUser(t.amount, t.currency);
    push({ id: String(t._id), group: 'trading', name: t.name, symbol: 'BOT', value, cost, progress: s.progress, detail: `${s.progress}% complete`, link: '/trade' });
  }

  for (const p of positions) {
    const q = quotes[p.symbol];
    const pct = q ? pnlPercentAt(p, q.price) : 0;
    const pnl = Math.max(-p.margin, (p.margin * pct) / 100);
    const value = await toUser(p.margin + pnl, p.currency);
    const cost = await toUser(p.margin, p.currency);
    push({ id: String(p._id), group: 'trading', name: `${p.side === 'long' ? 'Long' : 'Short'} ${p.symbol}`, symbol: p.base, value, cost, detail: `${p.leverage}× · entry ${p.entryPrice}`, link: '/trademain' });
  }

  for (const c of copies) {
    const value = await toUser(c.equity, c.currency);
    const cost = await toUser(c.amount, c.currency);
    push({ id: String(c._id), group: 'copyTrading', name: `Copying ${c.traderUsername}`, symbol: 'COPY', icon: c.traderAvatar, value, cost, detail: `${c.openPositions?.length || 0} open positions`, link: '/copy-positions' });
  }

  for (const v of vaults) {
    push({ id: String(v._id), group: 'coldStorage', name: v.name, symbol: v.asset || v.currency, value: await toUser(v.amount, v.currency), cost: null, detail: v.status === 'unlock_requested' ? 'Unlocking' : v.lockType === 'time_locked' ? 'Time-locked' : 'Flexible', link: '/cold-storage' });
  }


  if (rewards.length) {
    let value = 0;
    for (const r of rewards) value += await toUser(r.value, r.metadata?.currency); // eslint-disable-line no-await-in-loop
    push({ id: 'mining', group: 'mining', name: 'Unclaimed mining rewards', symbol: 'MINE', value: round2(value), cost: null, detail: `${rewards.length} reward${rewards.length === 1 ? '' : 's'} ready`, link: '/mining' });
  }

  const total = round2(items.reduce((s, i) => s + i.value, 0));
  const invested = items.filter((i) => i.cost != null);
  const investedCost = round2(invested.reduce((s, i) => s + i.cost, 0));
  const investedValue = round2(invested.reduce((s, i) => s + i.value, 0));
  const groups = Object.entries(GROUPS).map(([key, g]) => {
    const list = items.filter((i) => i.group === key);
    const value = round2(list.reduce((s, i) => s + i.value, 0));
    return { key, ...g, value, count: list.length, share: total ? round2((value / total) * 100) : 0 };
  }).filter((g) => g.count > 0);

  return {
    currency: cur,
    total,
    invested: { cost: investedCost, value: investedValue, pnl: round2(investedValue - investedCost), pnlPercent: investedCost ? round2(((investedValue - investedCost) / investedCost) * 100) : 0 },
    groups,
    items: items.sort((a, b) => b.value - a.value),
    at: now
  };
}
