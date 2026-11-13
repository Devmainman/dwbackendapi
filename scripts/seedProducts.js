// Seeds starter stocks, staking plans and real-estate offerings.
// Usage: npm run seed:products        (skips anything that already exists)
// Stock prices here are placeholders: update them from the admin API
// (POST /api/admin/products/stocks/prices) or wire a market-data feed.
import mongoose from 'mongoose';
import '../src/config/env.js';
import { StockAsset } from '../src/models/Stock.js';
import { StakingPlan } from '../src/models/Staking.js';
import { Property } from '../src/models/RealEstate.js';

const stocks = [
  { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', sector: 'Technology', price: 230, marketCap: 3.5e12 },
  { symbol: 'MSFT', name: 'Microsoft Corp.', exchange: 'NASDAQ', sector: 'Technology', price: 420, marketCap: 3.1e12 },
  { symbol: 'NVDA', name: 'NVIDIA Corp.', exchange: 'NASDAQ', sector: 'Technology', price: 140, marketCap: 3.4e12 },
  { symbol: 'AMZN', name: 'Amazon.com Inc.', exchange: 'NASDAQ', sector: 'Consumer', price: 200, marketCap: 2.1e12 },
  { symbol: 'GOOGL', name: 'Alphabet Inc.', exchange: 'NASDAQ', sector: 'Communication', price: 175, marketCap: 2.1e12 },
  { symbol: 'TSLA', name: 'Tesla Inc.', exchange: 'NASDAQ', sector: 'Automotive', price: 250, marketCap: 8e11 },
  { symbol: 'JPM', name: 'JPMorgan Chase & Co.', exchange: 'NYSE', sector: 'Financials', price: 225, marketCap: 6.4e11, dividendYield: 2.1 },
  { symbol: 'KO', name: 'Coca-Cola Co.', exchange: 'NYSE', sector: 'Consumer', price: 65, marketCap: 2.8e11, dividendYield: 3.0 }
];

// Staking pools. Amounts are in units of each asset; prices come from the live feed
// (the `price` here is only a fallback when no live price is available).
const plans = [
  { asset: 'AVAX', name: 'Avalanche', apy: 9, cycle: 'daily', minAmount: 9, maxAmount: 1000, price: 25, sortOrder: 1 },
  { asset: 'ETH', name: 'Ethereum', apy: 4.5, cycle: 'daily', minAmount: 0.05, maxAmount: 50, price: 3000, sortOrder: 2 },
  { asset: 'SOL', name: 'Solana', apy: 7, cycle: 'weekly', minAmount: 1, maxAmount: 500, price: 150, sortOrder: 3 },
  { asset: 'DOT', name: 'Polkadot', apy: 12, cycle: 'monthly', minAmount: 20, maxAmount: 5000, price: 6, lockDays: 90, earlyUnstakePenaltyPercent: 5, sortOrder: 4 },
  { asset: 'USDT', name: 'Tether', apy: 5, cycle: 'daily', minAmount: 50, maxAmount: 50000, price: 1, sortOrder: 5 }
];

// Sample projects. These are fictional examples to show the layout; replace them with real offerings.
const properties = [
  {
    title: 'Riverside Commons Lab Campus',
    summary: 'Conversion of a riverside warehouse into modern lab and R&D space for a growing biotech cluster.',
    overview: 'Riverside Commons is a planned conversion of a 110,000 SF waterfront warehouse into purpose-built lab and R&D space. '
      + 'The building sits within walking distance of a university research district and will offer upgraded power, ventilation and shared amenities aimed at '
      + 'early-stage life science companies that have outgrown incubator space.',
    propertyType: 'life_science', assetType: 'Life Science - Lab/R&D', stories: 3, strategy: 'Fixed income', objective: 'Opportunistic',
    location: { city: 'Example City', country: 'Sample Country' },
    images: ['https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?w=1200'],
    minimumInvestment: 5000, roi: 38, durationMonths: 36, fundingTarget: 2500000, amountRaised: 1150000, featured: true,
    whyProject: [
      'Limited supply of modern lab space near the research district.',
      'Shared amenities designed for companies leaving incubators.',
      'Pre-leasing conversations under way with several tenants.'
    ],
    sponsor: { name: 'Sample Sponsor Group', about: 'An example sponsor used for demonstration.' },
    whySponsor: [
      'Track record of completing conversion projects on schedule (example).',
      'General partners co-invest alongside investors (example).'
    ],
    documents: []
  },
  {
    title: 'Harbourview Residences',
    summary: 'A stabilised 48-unit apartment building with long-term tenants and professional management.',
    overview: 'Harbourview Residences is a fully leased residential building near a transit hub. The business plan focuses on steady rental income, light unit upgrades and disciplined operating costs.',
    propertyType: 'residential', assetType: 'Multifamily', stories: 6, strategy: 'Fixed income', objective: 'Core plus',
    location: { city: 'Example City', country: 'Sample Country' },
    images: ['https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?w=1200'],
    minimumInvestment: 1000, roi: 22, durationMonths: 24, fundingTarget: 1200000, amountRaised: 300000,
    whyProject: ['High occupancy with a long waiting list (example).', 'Walkable location close to transit.'],
    sponsor: { name: 'Sample Residential Partners', about: 'An example sponsor used for demonstration.' },
    whySponsor: ['Manages several similar buildings in the area (example).'],
    documents: []
  },
  {
    title: 'Northgate Logistics Hub',
    summary: 'Last-mile distribution facility, fully funded and now under construction.',
    overview: 'A 200,000 SF logistics facility serving a growing metro area. Funding closed early; investors receive fixed returns through the construction and lease-up period.',
    propertyType: 'industrial', assetType: 'Industrial - Logistics', stories: 1, strategy: 'Fixed income', objective: 'Value-add',
    location: { city: 'Example City', country: 'Sample Country' },
    images: ['https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?w=1200'],
    minimumInvestment: 2500, roi: 30, durationMonths: 30, fundingTarget: 1800000, amountRaised: 1800000, status: 'closed', closedAt: new Date(),
    whyProject: ['Strong demand for last-mile logistics (example).'],
    sponsor: { name: 'Sample Industrial Partners', about: 'An example sponsor used for demonstration.' },
    whySponsor: ['Experienced in industrial development (example).'],
    documents: []
  }
];

await mongoose.connect(process.env.MONGO_URI);

for (const s of stocks) {
  const exists = await StockAsset.exists({ symbol: s.symbol });
  if (!exists) await StockAsset.create({ ...s, previousClose: s.price, priceHistory: [{ price: s.price }] });
}
for (const p of plans) {
  const exists = await StakingPlan.exists({ asset: p.asset });
  if (!exists) await StakingPlan.create(p);
}
for (const p of properties) {
  const exists = await Property.exists({ title: p.title });
  if (!exists) {
    await Property.create({ ...p, slug: p.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') });
  }
}

console.log('Products seeded.');
await mongoose.disconnect();
