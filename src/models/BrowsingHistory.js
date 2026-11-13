import mongoose from 'mongoose';

const browsingHistorySchema = new mongoose.Schema({
  ip: { type: String, required: true },
  domain: { type: String, required: true },
  sessionId: { type: String, required: true, unique: true }, // Added sessionId
  userRole: { type: String, enum: ['admin', 'premium user', 'guest', 'user'], default: 'Guest' },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  date: { type: Date, default: Date.now }, // Session start time
  basicInfo: {
    device: { type: String, required: true },
    os: { type: String, required: true },
    browser: { type: String, required: true },
    resolution: { type: String },
    language: { type: String },
    referrer: { type: String },
    pagesVisited: { type: Number, default: 0 },
    sessionDuration: { type: String, default: '0m 0s' },
    interactions: { type: Number, default: 0 }
  },
  location: {
    country: { type: String },
    city: { type: String },
    region: { type: String },
    postalCode: { type: String },
    timezone: { type: String },
    isp: { type: String }
  },
  visitedPages: [{
    url: { type: String, required: true },
    title: { type: String }, // Optional: Store page title if available
    timestamp: { type: Date, default: Date.now },
    duration: { type: Number, default: 0 } // Time spent on page in milliseconds
  }]
}, { timestamps: true });

// Indexes for faster queries
browsingHistorySchema.index({ sessionId: 1 });
browsingHistorySchema.index({ domain: 1, date: -1 });
browsingHistorySchema.index({ userId: 1, date: -1 });
browsingHistorySchema.index({ sessionId: 1, 'visitedPages.timestamp': 1 });

const BrowsingHistory = mongoose.model('BrowsingHistory', browsingHistorySchema);

export default BrowsingHistory;