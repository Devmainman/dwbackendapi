import User from '../models/User.js';
import ColdStorageVault from '../models/ColdStorageVault.js';
import Card from '../models/Card.js';
import { StockHolding } from '../models/Stock.js';
import { StakePosition } from '../models/Staking.js';
import { PropertyInvestment } from '../models/RealEstate.js';
import ConnectedWallet from '../models/ConnectedWallet.js';
import CopyTrade from '../models/CopyTrade.js';
import { valueCopies } from '../services/copyTradingEngine.js';
import { round2 } from '../utils/money.js';
import { convertFromBase } from '../utils/wallet.js';
import { handler, accrue, getSettings } from '../services/productService.js';
import { getUsdPrices, usdToCurrency } from '../services/priceService.js';
import { rewardState } from './stakingController.js';

/** GET /api/portfolio/summary — one call for the Investing hub / dashboard widgets. */
export const getSummary = handler(async (req, res) => {
  const userId = req.user.id;
  const user = await User.findById(userId).select('balance currency');
  const now = new Date();

  const [vaults, cards, holdings, stakes, props, walletCount, { rate }, settings, copies] = await Promise.all([
    ColdStorageVault.find({ user: userId, status: { $ne: 'closed' } }).select('amount'),
    Card.find({ user: userId, status: { $in: ['active', 'frozen'] } }).select('balance'),
    StockHolding.find({ user: userId, shares: { $gt: 0 } }).populate('stock', 'price'),
    StakePosition.find({ user: userId, status: 'active' }),
    PropertyInvestment.find({ user: userId, status: 'active' }),
    ConnectedWallet.countDocuments({ user: userId }),
    convertFromBase(1, user.currency),
    getSettings(),
    CopyTrade.find({ userId, isOpen: true }).lean().then(valueCopies)
  ]);

  const coldStorage = round2(vaults.reduce((s, v) => s + v.amount, 0));
  const cardBalance = round2(cards.reduce((s, c) => s + c.balance, 0));
  const stocks = round2(holdings.reduce((s, h) => s + (h.stock ? h.shares * h.stock.price * rate : 0), 0));
  const stocksCost = round2(holdings.reduce((s, h) => s + h.costBasis, 0));
  const [stakePrices, usdFx] = await Promise.all([
    getUsdPrices(stakes.map((p) => p.asset), Object.fromEntries(stakes.map((p) => [p.asset, p.priceAtStake]))),
    usdToCurrency(1, user.currency)
  ]);
  const staking = round2(stakes.reduce((s, p) => {
    const r = rewardState(p, now);
    return s + (p.assetAmount + r.unclaimed) * (stakePrices[p.asset] || p.priceAtStake || 0) * usdFx.rate;
  }, 0));
  const realEstate = round2(props.reduce((s, i) => {
    // Total return (amount × roi%) is earned evenly over the term.
    const span = new Date(i.maturityAt) - new Date(i.startAt);
    const elapsed = Math.min(span, Math.max(0, now - new Date(i.startAt)));
    const earned = span > 0 ? i.amount * (i.roi / 100) * (elapsed / span) : 0;
    return s + i.amount + Math.max(0, earned - i.incomeClaimed);
  }, 0));

  const copyTrading = round2(copies.reduce((s, c) => s + c.equity, 0));
  const breakdown = { cash: round2(user.balance), coldStorage, cards: cardBalance, stocks, staking, realEstate, copyTrading };
  const total = round2(Object.values(breakdown).reduce((a, b) => a + b, 0));

  res.json({
    success: true,
    data: {
      currency: user.currency,
      total,
      breakdown,
      stocksPnl: round2(stocks - stocksCost),
      connectedWallets: walletCount,
      features: {
        coldStorage: settings.coldStorage?.enabled !== false,
        cards: settings.cards?.enabled !== false,
        stocks: settings.investing?.stocksEnabled !== false,
        staking: settings.investing?.stakingEnabled !== false,
        realEstate: settings.investing?.realEstateEnabled !== false,
        walletConnect: settings.investing?.walletConnectEnabled !== false
      }
    }
  });
});
