import mongoose from 'mongoose';

const signalInvoiceSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  userSnapshot: {
    accountId: String,
    fullName: String,
    email: String
  },

  signalPackage: {
    type: String,
    required: true
  },

  amount: {
    type: Number,
    required: true
  },

  currency: {
    type: String,
    default: 'USD'
  },

  paymentMethod: {
    type: String,
    required: true
  },

  paymentProof: {
    type: String,
    required: true
  },

  receipt: {
    type: String,
    default: ''
  },

  status: {
  type: String,
  enum: ['pending', 'paid', 'active', 'expired', 'disputed', 'rejected'],
  default: 'pending'
},


  signalStatus: {
    type: String,
    enum: ['pending_activation', 'delivering', 'paused', 'inactive'],
    default: 'pending_activation'
  },

  lastSignal: {
    type: Date,
    default: null
  },

  successRate: {
    type: String,
    default: 'N/A'
  },

  renewalDate: {
    type: Date,
    default: null
  },

  disputeReason: {
    type: String,
    default: ''
  }

}, { timestamps: true });

const SignalInvoice = mongoose.model('SignalInvoice', signalInvoiceSchema);
export default SignalInvoice;
