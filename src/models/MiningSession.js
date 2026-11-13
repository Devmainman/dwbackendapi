import mongoose from 'mongoose';

const miningSessionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  poolId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MiningPool',
    required: true
  },
  equipment: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MiningEquipment'
  }],
  hashRate: {
    type: Number,
    default: 0
  },
  powerConsumption: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['active', 'completed', 'stopped', 'failed'],
    default: 'active'
  },
  startedAt: {
    type: Date,
    default: Date.now
  },
  endedAt: {
    type: Date
  },
  duration: {
    type: Number, // in seconds
    default: 0
  },
  earnings: {
    type: Number,
    default: 0
  },
  rewards: [{
    coin: String,
    amount: Number,
    value: Number
  }],
  metadata: {
    type: Object,
    default: {}
  }
}, {
  timestamps: true
});

// Indexes
miningSessionSchema.index({ userId: 1, status: 1 });
miningSessionSchema.index({ startedAt: -1 });

const MiningSession = mongoose.model('MiningSession', miningSessionSchema);

export default MiningSession;