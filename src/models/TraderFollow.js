import mongoose from 'mongoose';

/** A user following a trader (free, separate from copying). */
const traderFollowSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  traderId: { type: String, required: true, index: true }
}, { timestamps: true });

traderFollowSchema.index({ user: 1, traderId: 1 }, { unique: true });

export default mongoose.model('TraderFollow', traderFollowSchema);
