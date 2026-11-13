// Creates a few starter trader profiles for copy trading (skips existing ones).
// Usage: npm run seed:trading
// Traders start with no track record: their ROI, win rate and drawdown are
// computed from the trades an admin places for them.
import mongoose from 'mongoose';
import '../src/config/env.js';
import Trader from '../src/models/Trader.js';

const traders = [
  {
    username: 'atlas_macro', fullName: 'Atlas Macro', email: 'atlas.macro@traders.invalid', country: 'United Kingdom',
    bio: 'Swing trader focused on BTC and ETH trend continuation with strict risk control.',
    tradingStyle: ['swing'], markets: ['crypto'], tradingExperience: 'expert', riskMetrics: { riskLevel: 'medium' },
    settings: { minCopyAmount: 100, commissionRate: 15 }
  },
  {
    username: 'quantum_scalps', fullName: 'Quantum Scalps', email: 'quantum.scalps@traders.invalid', country: 'Singapore',
    bio: 'Short-term momentum on major crypto pairs. Higher turnover, tighter stops.',
    tradingStyle: ['scalping', 'day'], markets: ['crypto'], tradingExperience: 'advanced', riskMetrics: { riskLevel: 'high' },
    settings: { minCopyAmount: 50, commissionRate: 20 }
  },
  {
    username: 'steady_yield', fullName: 'Steady Yield', email: 'steady.yield@traders.invalid', country: 'Germany',
    bio: 'Low-leverage position trading across majors. Capital preservation first.',
    tradingStyle: ['position'], markets: ['crypto', 'forex'], tradingExperience: 'expert', riskMetrics: { riskLevel: 'low' },
    settings: { minCopyAmount: 100, commissionRate: 10 }
  }
];

await mongoose.connect(process.env.MONGO_URI);
let created = 0;
for (const t of traders) {
  if (await Trader.exists({ username: t.username })) continue;
  await Trader.create({ ...t, traderId: `TR-${t.username.toUpperCase()}`, verified: true, verificationLevel: 'advanced' });
  created += 1;
}
console.log(`${created} trader(s) created.`);
await mongoose.disconnect();
