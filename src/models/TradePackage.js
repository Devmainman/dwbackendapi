// models/TradePackage.js
import mongoose from 'mongoose';

const tradePackageSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true
  },
  description: String,
  minAmount: {
    type: Number,
    required: true,
    min: 0
  },
  maxAmount: {
    type: Number,
    required: true,
    min: 0
  },
  profitRate: {
  type: Number,
  required: true,
  min: 0
},
profitInterval: {
  type: String,
  enum: ['minute','5-minutes','15-minutes','30-minutes','hour','daily'],
  default: 'minute'
},

  duration: { // in hours
    type: Number,
    required: true,
    min: 1
  },
  status: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

tradePackageSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

const TradePackage = mongoose.model('TradePackage', tradePackageSchema);

export default TradePackage;