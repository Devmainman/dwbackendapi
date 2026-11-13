import mongoose from 'mongoose';

const miningBoosterSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  name: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: ['hash_rate', 'energy', 'rewards', 'cooling', 'stability'],
    required: true
  },
  multiplier: {
    type: Number,
    required: true,
    min: 0.1,
    max: 10
  },
  duration: {
    type: Number, // in seconds
    required: true
  },
  price: {
    type: Number,
    required: true
  },
  status: {
    type: String,
    enum: ['active', 'expired', 'cancelled'],
    default: 'active'
  },
  expiresAt: {
    type: Date,
    required: true
  },
  activatedAt: {
    type: Date,
    default: Date.now
  },
  metadata: {
    type: Object,
    default: {}
  }
}, {
  timestamps: true
});

// Indexes
miningBoosterSchema.index({ userId: 1, status: 1, expiresAt: 1 });
miningBoosterSchema.index({ expiresAt: 1 });

// Pre-save hook to check expiration
miningBoosterSchema.pre('save', function(next) {
  if (this.expiresAt && new Date() > this.expiresAt) {
    this.status = 'expired';
  }
  next();
});

const MiningBooster = mongoose.model('MiningBooster', miningBoosterSchema);

export default MiningBooster;