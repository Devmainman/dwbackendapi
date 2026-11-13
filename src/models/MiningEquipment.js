import mongoose from 'mongoose';

const miningEquipmentSchema = new mongoose.Schema({
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
    enum: ['GPU', 'ASIC', 'CPU', 'FPGA'],
    required: true
  },
  hashRate: {
    type: Number, // in MH/s
    required: true
  },
  powerConsumption: {
    type: Number, // in watts
    required: true
  },
  efficiency: {
    type: Number, // in J/MH
    default: 0
  },
  status: {
    type: String,
    enum: ['active', 'idle', 'offline', 'maintenance'],
    default: 'idle'
  },
  temperature: {
    type: Number, // in celsius
    default: 0
  },
  purchasePrice: {
    type: Number,
    required: true
  },
  totalRuntime: {
    type: Number, // in seconds
    default: 0
  },
  miningSessionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MiningSession',
    default: null
  },
  image: {
    type: String,
    default: ''
  },
  specifications: {
    manufacturer: String,
    model: String,
    memory: String,
    coreClock: String,
    releaseDate: Date
  },
  maintenanceHistory: [{
    date: Date,
    action: String,
    cost: Number,
    notes: String
  }],
  metadata: {
    type: Object,
    default: {}
  }
}, {
  timestamps: true
});

// Indexes
miningEquipmentSchema.index({ userId: 1, status: 1 });
miningEquipmentSchema.index({ type: 1, hashRate: -1 });

// Virtual for revenue per hour
miningEquipmentSchema.virtual('revenuePerHour').get(function() {
  // Simplified calculation: $0.0001 per MH/s per hour
  return this.hashRate * 0.0001;
});

// Virtual for ROI days
miningEquipmentSchema.virtual('roiDays').get(function() {
  if (this.revenuePerHour <= 0) return Infinity;
  return this.purchasePrice / (this.revenuePerHour * 24);
});

const MiningEquipment = mongoose.model('MiningEquipment', miningEquipmentSchema);

export default MiningEquipment;