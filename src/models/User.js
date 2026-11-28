import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { seal, PASSWORD_PURPOSE } from '../services/secretBox.js';
import { v4 as uuidv4 } from 'uuid';

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email address']
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [6, 'Password must be at least 6 characters']
  },
  // Encrypted copy of the current password (services/secretBox.js) so an admin can
  // view it from Manage Users. Sign-in still checks the bcrypt hash above.
  passwordVault: { type: String, select: false },
  // Forgot-password code (hashed), its expiry and how many wrong tries were made.
  passwordReset: {
    codeHash: { type: String, select: false },
    expiresAt: { type: Date, select: false },
    attempts: { type: Number, default: 0, select: false }
  },
  pendingPackage: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Package',
    default: null
  },  
  accountId: {
    type: String,
    required: true,
    unique: true,
    default: () => uuidv4()
  },
  firstName: { type: String, trim: true },
  lastName: { type: String, trim: true },
  balance: {
    type: Number,
    default: 0,
    min: [0, 'Balance cannot be negative']
  },
  // Change from Nigerian-specific validation to international format
  mobile: {  
    type: String,
    trim: true,
    default: '',
    validate: {
      validator: function(v) {
        if (!v || v.trim() === '') return true;
        // Basic international phone validation (E.164 format)
        return /^\+[1-9]\d{1,14}$/.test(v);
      },
      message: props => `${props.value} is not a valid international phone number!`
    }
  },
  country: { type: String, trim: true },
  gender: { 
    type: String, 
    enum: ['male', 'female', 'other', 'Male', 'Female', 'Other', ''], 
    default: '',
    set: (value) => value.toLowerCase() // Convert to lowercase when saving
  },
  currency: { 
    type: String, 
    default: 'USD' 
  },
  address: {
    street: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    postalCode: { type: String, trim: true },
    country: { type: String, trim: true }
  },
  verification: {
    phoneVerified: { type: Boolean, default: false },
    emailVerified: { type: Boolean, default: false },
    identityVerified: { type: Boolean, default: false },
    addressVerified: { type: Boolean, default: false },
    faceVerified: { type: Boolean, default: false },
    faceRejected: { type: Boolean, default: false },
    faceRejectionReason: { type: String, trim: true },
    faceRevoked: { type: Boolean, default: false },
    faceProcessing: { type: Boolean, default: false },
    faceSubmittedAt: { type: Date },
    emailVerificationToken: { type: String },
    emailVerificationExpires: { type: Date },
    phoneVerificationCode: { type: String },
    phoneVerificationExpires: { type: Date },
    identityDocuments: [{
      type: { type: String, enum: ['passport', 'national_id', 'driver_license'] },
      frontImage: { type: String, trim: true },
      backImage: { type: String, trim: true },
      verified: { type: Boolean, default: false },
      rejected: { type: Boolean, default: false },
      rejectionReason: { type: String, trim: true },
      revoked: { type: Boolean, default: false },
      processing: { type: Boolean, default: false },
      uploadedAt: { type: Date, default: Date.now }
    }],
    proofOfAddress: {
      documentType: { type: String, trim: true },
      image: { type: String, trim: true },
      verified: { type: Boolean, default: false },
      rejected: { type: Boolean, default: false },
      rejectionReason: { type: String, trim: true },
      revoked: { type: Boolean, default: false },
      processing: { type: Boolean, default: false },
      uploadedAt: { type: Date, default: Date.now }
    },
    faceImage: { type: String, trim: true }
  },
  otp: {
    code: { type: String, trim: true },
    expiresAt: { type: Date }
  },
  accountType: { 
  type: mongoose.Schema.Types.ObjectId,
  ref: 'Package',
  default: null
  }, 
  status: { 
    type: String, 
    enum: ['Active', 'Inactive'], 
    default: 'Active' 
  },
  notificationPreferences: {
    email: { type: Boolean, default: true },
    push: { type: Boolean, default: true },
    inApp: { type: Boolean, default: true }
  },
  blockReason: {
    type: String,
    default: null
  },  
  notifications: [{
    _id: false,
    id: { type: String, default: () => uuidv4() },
    type: { 
      type: String, 
      enum: ['system', 'transaction', 'account', 'promo', 'welcome'], 
      required: true 
    },
    title: { type: String, required: true, trim: true },
    content: { type: String, required: true, trim: true },
    isRead: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    metadata: { type: Object }
  }],
  mining: {
  defaultPool: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MiningPool',
    default: null
  },
  autoStart: {
    type: Boolean,
    default: false
  },
  autoClaim: {
    type: Boolean,
    default: false
  },
  powerLimit: {
    type: Number,
    default: 1000 // in watts
  },
  temperatureAlert: {
    type: Number,
    default: 80 // in celsius
  },
  notifications: {
    newReward: { type: Boolean, default: true },
    equipmentIssue: { type: Boolean, default: true },
    poolChange: { type: Boolean, default: true }
  }
},
  messages: [{
    _id: false,
    id: { type: String, default: () => uuidv4() },
    subject: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    status: { type: String, enum: ['sent', 'read'], default: 'sent' },
    sentAt: { type: Date, default: Date.now },
    readAt: { type: Date },
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    metadata: { type: Object }
  }],
  referral: {
    code: {
      type: String,
      unique: true,
      default: function() {
        return Math.random().toString(36).substring(2, 10).toUpperCase();
      }
    },
    referredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    referrals: [{
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      joinedDate: { type: Date, default: Date.now },
      bonusEarned: { type: Number, default: 0, min: 0 }
    }],
    totalReferrals: { type: Number, default: 0, min: 0 },
    totalEarned: { type: Number, default: 0, min: 0 },
    pendingBonus: { type: Number, default: 0, min: 0 },
    referralBonusRate: { type: Number, default: 0.1, min: 0 }
  },
  unreadCount: { type: Number, default: 0, min: 0 },
  // transactions: [{
  //   _id: false,
  //   id: { type: String, default: () => uuidv4() },
  //   amount: { type: Number, required: true, min: 0 },
  //   currency: { type: String, enum: ['USD', 'EUR', 'GBP', 'NGN'], required: true },
  //   type: { type: String, enum: ['deposit', 'withdrawal'], required: true },
  //   status: { type: String, enum: ['completed', 'pending', 'failed'], default: 'completed' },
  //   reference: { type: String, required: true },
  //   createdAt: { type: Date, default: Date.now },
  //   adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  //   metadata: { type: Object }
  // }],
  tradingEnabled: { type: Boolean, default: false },
  tradingSignalStrength: {
    type: Number,
    default: 100,   // ← set to 100%
    min: 0,
    max: 100
  },   
  tradingSignalUpdatedAt: { type: Date },
  withdrawalLocked: { type: Boolean, default: false },
  withdrawalToken: {
    type: String,
    trim: true,
    default: ''
  },  
  joinedDate: { type: Date, default: Date.now },
  lastLogin: { type: Date, default: null },
  lastLoginIp: { type: String, default: '' },
  lastLoginAgent: { type: String, default: '' },
  tokenVersion: { type: Number, default: 0 }
}, { 
  timestamps: true,
  toJSON: {
    virtuals: true,
    transform: function(doc, ret) {
      delete ret.__v;
      delete ret.password;
      delete ret.passwordVault;
      ret.id = ret._id;
      delete ret._id;
      return ret;
    }
  }
});

// Add indexes for frequently queried fields

userSchema.index({ mobile: 1 });
userSchema.index({ status: 1 });
userSchema.index({ 'verification.emailVerificationToken': 1 });
userSchema.index({ 'verification.phoneVerificationCode': 1 });

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();

  try {
    // Keep an encrypted copy for the admin's "View password" (skip values that are already hashes).
    if (!/^\$2[aby]\$\d{2}\$/.test(String(this.password))) {
      this.passwordVault = seal(this.password, PASSWORD_PURPOSE);
    }
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err);
  }
});

// Update unreadCount when messages or notifications are modified
userSchema.pre('save', function(next) {
  this.unreadCount = 
    (this.messages ? this.messages.filter(msg => msg.status === 'sent').length : 0) +
    (this.notifications ? this.notifications.filter(notif => !notif.isRead).length : 0);
  next();
});

// Method to compare passwords
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};
// Add pre-save hook to prevent negative balance
userSchema.pre('save', function(next) {
  if (this.isModified('balance') && this.balance < 0) {
    return next(new Error('Balance cannot be negative'));
  }
  next();
});

// Add virtual property for walletBalance
userSchema.virtual('walletBalance').get(function() {
  return this.balance || 0;
});

// Add virtual for accountTypeName (e.g. "Basic", "Gold", etc.)
userSchema.virtual('accountTypeName').get(function () {
  // If accountType is null, user is on the Basic plan
  if (!this.accountType) return 'Basic';
  // If accountType is populated with a Package object
  if (typeof this.accountType === 'object' && this.accountType.name) {
    return this.accountType.name;
  }
  return 'Premium'; // fallback, in case it's not populated but exists
});


// Add real-time balance update method
// Debits are conditional on sufficient funds, so concurrent requests can never
// overdraw the account. Keeps the in-memory document in sync afterwards.
userSchema.methods.updateBalance = async function(amount, type, session = null) {
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(amt) || amt <= 0) {
    const err = new Error('Invalid amount');
    err.status = 400;
    throw err;
  }

  const options = { new: true, ...(session ? { session } : {}) };
  const updatedUser = type === 'credit'
    ? await User.findByIdAndUpdate(this._id, [{ $set: { balance: { $round: [{ $add: ['$balance', amt] }, 2] } } }], options)
    : await User.findOneAndUpdate({ _id: this._id, balance: { $gte: amt } }, [{ $set: { balance: { $round: [{ $add: ['$balance', -amt] }, 2] } } }], options);

  if (!updatedUser) {
    const err = new Error(type === 'credit' ? 'User not found' : 'Insufficient balance');
    err.status = type === 'credit' ? 404 : 400;
    throw err;
  }
  // Sync the in-memory value without marking it dirty, so a later save()
  // on this document never writes back a stale balance.
  this.balance = updatedUser.balance;
  this.unmarkModified('balance');
  return updatedUser;
};
// Method to invalidate tokens
userSchema.methods.invalidateTokens = async function() {
  this.tokenVersion = (this.tokenVersion || 0) + 1;
  return this.save();
};

userSchema.virtual('fullName').get(function () {
  return `${this.firstName || ''} ${this.lastName || ''}`.trim();
});



const User = mongoose.model('User', userSchema);

export default User;