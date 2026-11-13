import mongoose from 'mongoose';

const miningRewardSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  sessionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MiningSession'
  },
  poolId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MiningPool'
  },
  coin: {
    type: String,
    required: true,
    enum: ['BTC', 'ETH', 'LTC', 'DOGE', 'XMR', 'ZEC', 'ETC', 'RVN']
  },
  amount: {
    type: Number,
    required: true
  },
  value: {
    type: Number, // in USD
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'claimed', 'failed'],
    default: 'pending'
  },
  transactionId: {
    type: String
  },
  blockHeight: {
    type: Number
  },
  confirmed: {
    type: Boolean,
    default: false
  },
  confirmations: {
    type: Number,
    default: 0
  },
  claimedAt: {
    type: Date
  },
  metadata: {
    type: Object,
    default: {}
  }
}, {
  timestamps: true
});

// Indexes
miningRewardSchema.index({ userId: 1, status: 1 });
miningRewardSchema.index({ createdAt: -1 });
miningRewardSchema.index({ coin: 1, confirmed: 1 });

const MiningReward = mongoose.model('MiningReward', miningRewardSchema);

export default MiningReward;