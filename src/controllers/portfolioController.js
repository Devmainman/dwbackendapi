import ConnectedWallet from '../models/ConnectedWallet.js';
import { round2 } from '../utils/money.js';
import { handler, getSettings } from '../services/productService.js';
import { buildHoldings } from '../services/holdingsService.js';
import { HttpError } from '../utils/wallet.js';

/** GET /api/portfolio/holdings — every asset the user holds, valued in their currency. */
export const getHoldings = handler(async (req, res) => {
  const data = await buildHoldings(req.user.id);
  if (!data) throw new HttpError(404, 'User not found');
  res.json({ success: true, data });
});

/** GET /api/portfolio/summary — one call for the Investing hub / dashboard widgets. */
export const getSummary = handler(async (req, res) => {
  const [h, walletCount, settings] = await Promise.all([
    buildHoldings(req.user.id),
    ConnectedWallet.countDocuments({ user: req.user.id }),
    getSettings()
  ]);
  if (!h) throw new HttpError(404, 'User not found');
  const sum = (group) => round2(h.items.filter((i) => i.group === group).reduce((s, i) => s + i.value, 0));
  const stocks = h.items.filter((i) => i.group === 'stocks');
  const breakdown = {
    cash: sum('cash'),
    coldStorage: sum('coldStorage'),
    cards: sum('cards'),
    stocks: sum('stocks'),
    staking: sum('crypto'),
    realEstate: sum('realEstate'),
    copyTrading: sum('copyTrading'),
    trading: sum('trading'),
    mining: sum('mining')
  };
  res.json({
    success: true,
    data: {
      currency: h.currency,
      total: h.total,
      breakdown,
      stocksPnl: round2(stocks.reduce((s, i) => s + (i.pnl || 0), 0)),
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
