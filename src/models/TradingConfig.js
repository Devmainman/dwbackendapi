import mongoose from 'mongoose';

const tradingConfigSchema = new mongoose.Schema({
  mode: {
    type: String,
    enum: ['simulation', 'live'],
    default: 'simulation'
  },
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

const TradingConfig = mongoose.model('TradingConfig', tradingConfigSchema);

export default TradingConfig;
