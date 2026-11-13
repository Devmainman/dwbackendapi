// Keeps open copy-trading positions marked to real market prices.
// Crypto pairs quoted in USD stablecoins (e.g. BTC/USDT, ETHUSD) are priced from
// Binance's public ticker every minute. Other symbols keep the mark price the
// admin sets. Disable with COPY_PRICE_FEED=off.
import axios from 'axios';
import MasterTrade from '../models/MasterTrade.js';
import { updateMarkPrice } from './copyTradingEngine.js';

const toBinance = (symbol) => {
  const s = String(symbol).toUpperCase().replace(/[/_-]/g, '');
  const m = s.match(/^([A-Z0-9]{2,10})(USDT|USDC|BUSD|USD)$/);
  return m ? `${m[1]}USDT` : null;
};

export const refreshMarkPrices = async () => {
  const symbols = await MasterTrade.distinct('symbol', { status: 'open' });
  const pairs = new Map();
  for (const s of symbols) {
    const b = toBinance(s);
    if (b) pairs.set(s, b);
  }
  if (!pairs.size) return 0;

  const wanted = [...new Set(pairs.values())];
  const { data } = await axios.get('https://api.binance.com/api/v3/ticker/price', {
    params: { symbols: JSON.stringify(wanted) },
    timeout: 8000
  });
  const prices = new Map((Array.isArray(data) ? data : []).map((t) => [t.symbol, Number(t.price)]));

  let updated = 0;
  for (const [symbol, pair] of pairs) {
    const price = prices.get(pair);
    if (price > 0) {
      // eslint-disable-next-line no-await-in-loop
      updated += await updateMarkPrice({ symbol, price });
    }
  }
  return updated;
};

export const startMarkPriceFeed = () => {
  if (process.env.COPY_PRICE_FEED === 'off') return null;
  const tick = () => refreshMarkPrices().catch((err) => console.warn('Mark price feed:', err.message));
  setTimeout(tick, 5000);
  return setInterval(tick, 60 * 1000);
};
