import mongoose from 'mongoose';

const miningPoolSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true
  },
  url: {
    type: String,
    required: true
  },
  fee: {
    type: Number,
    required: true,
    min: 0,
    max: 100
  },
  minPayout: {
    type: Number,
    default: 0.001
  },
  miners: {
    type: Number,
    default: 0
  },
  hashRate: {
    type: Number, // in TH/s
    default: 0
  },
  uptime: {
    type: Number,
    default: 99.5,
    min: 0,
    max: 100
  },
  algorithm: {
    type: String,
    required: true,
    enum: ['SHA-256', 'Ethash', 'Scrypt', 'X11', 'Equihash', 'RandomX', 'CuckooCycle']
  },
  supportedCoins: [{
    type: String,
    enum: ['BTC', 'ETH', 'LTC', 'DOGE', 'XMR', 'ZEC', 'ETC', 'RVN']
  }],
  paymentMethod: {
    type: String,
    enum: ['PPS', 'PPLNS', 'SOLO', 'PROP'],
    default: 'PPS'
  },
  location: {
    country: String,
    city: String,
    latency: Number // in ms
  },
  status: {
    type: String,
    enum: ['active', 'maintenance', 'offline'],
    default: 'active'
  },
  features: [{
    type: String,
    enum: ['ssl', 'stratum', 'api', 'monitoring', 'notifications', 'automatic_payout']
  }],
  statistics: {
    totalBlocks: Number,
    lastBlock: Date,
    avgBlockTime: Number,
    totalPayouts: Number
  },
  metadata: {
    type: Object,
    default: {}
  }
}, {
  timestamps: true
});

// Indexes
miningPoolSchema.index({ algorithm: 1, status: 1 });
miningPoolSchema.index({ fee: 1, uptime: -1 });

// Virtual for estimated earnings
miningPoolSchema.virtual('estimatedEarnings').get(function() {
  // Simplified earnings estimation
  return this.hashRate * 0.000001; // $ per TH/s per day
});

const MiningPool = mongoose.model('MiningPool', miningPoolSchema);

export default MiningPool;