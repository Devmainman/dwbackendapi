// Sample catalog content so the client can try every product.
// Adds only catalog items (nothing tied to a real user) and skips anything that
// already exists by name, so it is safe to run more than once.
// Usage: npm run seed:demo
import mongoose from 'mongoose';
import '../src/config/env.js';
import MiningPool from '../src/models/MiningPool.js';
import TradePackage from '../src/models/TradePackage.js';
import Package from '../src/models/Package.js';
import SignalPackage from '../src/models/SignalPackage.js';
import CardProduct from '../src/models/CardProduct.js';
import SmartBot from '../src/models/SmartBot.js';
import { BlogCategory, BlogPost } from '../src/models/Blog.js';

const results = [];
const addMissing = async (label, Model, key, docs) => {
  let added = 0;
  try {
    for (const d of docs) {
      if (await Model.exists({ [key]: d[key] })) continue;
      await Model.create(d);
      added++;
    }
    results.push(`${label}: ${added} added, ${docs.length - added} already there`);
  } catch (err) {
    results.push(`${label}: FAILED (${err.message})`);
  }
};

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);

  await addMissing('Mining pools', MiningPool, 'name', [
    { name: 'Bitcoin Prime Pool', url: 'stratum+tcp://btc.prime:3333', fee: 1.5, minPayout: 0.001, miners: 4200, hashRate: 980, uptime: 99.9, algorithm: 'SHA-256', supportedCoins: ['BTC'], paymentMethod: 'PPS', location: { country: 'United States', city: 'Dallas', latency: 40 }, status: 'active' },
    { name: 'Litecoin Mining Hub', url: 'stratum+tcp://ltc.hub:7777', fee: 1.8, minPayout: 0.1, miners: 1200, hashRate: 320, uptime: 99.7, algorithm: 'Scrypt', supportedCoins: ['LTC', 'DOGE'], paymentMethod: 'PPLNS', location: { country: 'Canada', city: 'Toronto', latency: 60 }, status: 'active' }
  ]);

  await addMissing('Investment packages', TradePackage, 'name', [
    { name: 'Starter Growth', description: 'A short plan to try automated returns.', minAmount: 100, maxAmount: 999, profitRate: 0.2, profitInterval: 'hour', duration: 24, status: 'active' },
    { name: 'Balanced Income', description: 'Steady hourly returns over three days.', minAmount: 1000, maxAmount: 9999, profitRate: 0.3, profitInterval: 'hour', duration: 72, status: 'active' },
    { name: 'Premium Yield', description: 'Higher daily returns for larger amounts over a week.', minAmount: 10000, maxAmount: 100000, profitRate: 2.5, profitInterval: 'daily', duration: 168, status: 'active' }
  ]);

  await addMissing('Account upgrade plans', Package, 'name', [
    { name: 'Silver', amount: 1000, status: 'Active', requiredSignal: 0, benefits: ['Copy trading access', 'Staking pools', 'Email support'] },
    { name: 'Gold', amount: 5000, status: 'Active', requiredSignal: 40, benefits: ['Everything in Silver', 'Live trading signals', 'Real-estate projects', 'Priority support'] },
    { name: 'Platinum', amount: 25000, status: 'Active', requiredSignal: 70, benefits: ['Everything in Gold', 'Cloud mining rigs', 'Higher withdrawal limits', 'Dedicated account manager'] }
  ]);

  await addMissing('Signal packages', SignalPackage, 'name', [
    { name: 'Signal Basic', strength: 20, strengthLabel: '20 +', amount: 50, benefits: ['5 signals a day', 'Major coins only'] },
    { name: 'Signal Pro', strength: 50, strengthLabel: '50 +', amount: 150, benefits: ['20 signals a day', 'Crypto and forex', 'Entry, target and stop levels'] },
    { name: 'Signal Elite', strength: 90, strengthLabel: '90 +', amount: 400, benefits: ['Unlimited signals', 'VIP channel', 'Unlocks every account plan'] }
  ]);

  await addMissing('Cards', CardProduct, 'name', [
    { name: 'Classic Virtual', type: 'virtual', network: 'visa', designPreset: 'midnight', description: 'Shop online anywhere Visa is accepted.', purchasePrice: 15, activationFee: 5, status: 'available', sortOrder: 1 },
    { name: 'Amber Virtual', type: 'virtual', network: 'mastercard', designPreset: 'gold', description: 'A virtual Mastercard for subscriptions and online stores.', purchasePrice: 25, activationFee: 10, status: 'available', sortOrder: 2 },
    { name: 'Metal Physical', type: 'physical', network: 'visa', designPreset: 'silver', description: 'A metal card delivered to your door.', purchasePrice: 120, activationFee: 30, status: 'available', sortOrder: 3 },
    { name: 'Platinum Physical', type: 'physical', network: 'amex', designPreset: 'aurora', description: 'Premium physical card with travel perks.', purchasePrice: 250, activationFee: 50, status: 'available', sortOrder: 4 }
  ]);

  await addMissing('AI Smart Trader bots', SmartBot, 'name', [
    { name: 'AI Smart Trader Lite', strategy: 'Trend following', description: 'A careful bot that follows the main trend on large coins.', price: 49, tradeLimit: 20, tradeIntervalMinutes: 60, minAllocation: 100, winRate: 70, profitMin: 0.4, profitMax: 1.5, lossMin: 0.3, lossMax: 0.8, markets: ['BTC', 'ETH'], sortOrder: 1 },
    { name: 'AI Smart Trader Pro', strategy: 'Momentum scalping', description: 'Trades more often across five markets.', price: 149, tradeLimit: 60, tradeIntervalMinutes: 30, minAllocation: 500, winRate: 74, profitMin: 0.5, profitMax: 2, lossMin: 0.3, lossMax: 1, markets: ['BTC', 'ETH', 'SOL', 'BNB', 'XRP'], sortOrder: 2 },
    { name: 'AI Smart Trader Max', strategy: 'Multi-strategy', description: 'Our most active bot for larger accounts.', price: 399, tradeLimit: 150, tradeIntervalMinutes: 15, minAllocation: 2000, winRate: 78, profitMin: 0.6, profitMax: 2.5, lossMin: 0.3, lossMax: 1.2, markets: ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'AVAX'], sortOrder: 3 }
  ]);

  await addMissing('Blog categories', BlogCategory, 'slug', [
    { name: 'Guides', slug: 'guides', description: 'How to get the most from the app.', sortOrder: 1 },
    { name: 'Markets', slug: 'markets', description: 'What is moving and why.', sortOrder: 2 },
    { name: 'News', slug: 'news', description: 'Product updates and announcements.', sortOrder: 3 }
  ]);
  const cat = Object.fromEntries((await BlogCategory.find({ slug: { $in: ['guides', 'markets', 'news'] } }).lean()).map((c) => [c.slug, c._id]));
  const now = Date.now();
  await addMissing('Blog articles', BlogPost, 'slug', [
    {
      title: 'How copy trading works', slug: 'how-copy-trading-works', category: cat.guides, status: 'published', featured: true, readMinutes: 2,
      publishedAt: new Date(now - 2 * 86400000), authorName: 'Research team',
      excerpt: 'Follow experienced traders automatically and keep full control of your money.',
      content: '## What it is\nCopy trading lets you **mirror the trades** of an experienced trader. When they open a position, the same position opens in your account, sized to the amount you set aside.\n\n## Getting started\n1. Open **Copy trading** and browse the experts.\n2. Look at their win rate, risk score and history.\n3. Choose how much to allocate and press Copy.\n\n## Staying in control\n- Stop copying at any time.\n- Your allocation is the most you can lose.\n- Every trade shows in your positions.\n\n> Past results do not guarantee future returns. Only use money you can afford to set aside.'
    },
    {
      title: 'Meet the AI Smart Trader', slug: 'meet-the-ai-smart-trader', category: cat.news, status: 'published', readMinutes: 2,
      publishedAt: new Date(now - 86400000), authorName: 'Product team',
      excerpt: 'Bots that place a set number of trades for you, with every trade on record.',
      content: '## A bot that works while you do\nThe **AI Smart Trader** places trades for you across major coins. Each bot has a clear limit: you always know how many trades it will place.\n\n## How it works\n- Pick a bot and the capital it trades with.\n- Pay the subscription with any payment method.\n- Once approved, the bot starts trading.\n\n## Track every trade\nThe AI Smart Trader page shows trades done, trades left, wins, losses and your total result.'
    },
    {
      title: 'Virtual or physical card: which one fits you?', slug: 'virtual-or-physical-card', category: cat.guides, status: 'published', readMinutes: 2,
      publishedAt: new Date(now - 3600000), authorName: 'Research team',
      excerpt: 'Spend your balance online or in stores. Here is how the two cards differ.',
      content: '## Virtual cards\nReady soon after approval, made for **online shopping** and subscriptions.\n\n## Physical cards\nDelivered to your address and accepted in stores and at ATMs.\n\n## How to get one\n1. Open **Cards** and choose Virtual or Physical.\n2. Fill in the cardholder details.\n3. Pay the purchase price, then the activation fee once approved.'
    }
  ]);

  console.log(results.join('\n'));
  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error('Seed failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
