import mongoose from 'mongoose';

const settingSchema = new mongoose.Schema({
  websiteName: { type: String, default: '' },

  // Colour tone of the user dashboard, picked by the admin.
  dashboardTheme: { type: String, enum: ['amber', 'classic-blue', 'navy', 'gold', 'silver'], default: 'amber' },

  // URLs
  frontendURL: { type: String, default: 'http://localhost:5000/api/admin/login' },
  websiteUrl: { type: String, default: '' },
  logoutUrl: { type: String, default: '' },

  // Currency
  currencyApiKey: { type: String, default: '' },
  currencyApiUrl: { type: String, default: 'http://api.exchangerate.host/convert' },
  currencyInterval: { type: String, default: 'Every Six Hours' },
  defaultCurrency: { type: String, default: '' },
  currencyAutoSync: { type: Boolean, default: true },
  currencyLastSyncedAt: { type: Date },
  currencyRateSource: { type: String, default: '' },
  miningCatalog: { type: mongoose.Schema.Types.Mixed, default: {} },

  exchangeRates: {
  type: Object,
  default: {}   // e.g. { USD: { CNY: 7.25, NGN: 1600 } }
},

  adminEmail: { type: String, default: 'nojigpotal@gmail.com' },

  // 🔥 SIGNAL STRENGTH CONTROLS
  signalStrength: {
    trading: { type: Number, default: 0 },          // Manual trading
    copyTrading: { type: Number, default: 0 },      // Copy trading
    tradingPackages: { type: Number, default: 0 },  // Bot / packages
    mining: { type: Number, default: 0 }            // Mining
  },

  // Product configuration (new modules)
  coldStorage: {
    enabled: { type: Boolean, default: true },
    unlockDelayHours: { type: Number, default: 48, min: 0 },
    minDeposit: { type: Number, default: 10, min: 0 }
  },
  cards: {
    enabled: { type: Boolean, default: true },
    virtualFee: { type: Number, default: 5, min: 0 },
    physicalFee: { type: Number, default: 25, min: 0 },
    maxCardsPerUser: { type: Number, default: 3, min: 1 }
  },
  investing: {
    stocksEnabled: { type: Boolean, default: true },
    stakingEnabled: { type: Boolean, default: true },
    realEstateEnabled: { type: Boolean, default: true },
    walletConnectEnabled: { type: Boolean, default: true }
  },

  // Referral & limits
  referralCommission: { type: Number, default: 0 },
  defaultThreshold: { type: Number, default: 0 },

  // Branding
  logo: { type: String, default: '' },
  icon: { type: String, default: '' },

  // System Toggles
  systemStatus: { type: Boolean, default: false },
  translationStatus: { type: Boolean, default: false },
  withdrawalStatus: { type: Boolean, default: false },

  // Verification Toggles
  textedVerificationStatus: { type: Boolean, default: false },
  idVerificationStatus: { type: Boolean, default: false },
  emailVerificationStatus: { type: Boolean, default: false },
  phoneVerificationStatus: { type: Boolean, default: false },
  addressVerificationStatus: { type: Boolean, default: false },

  // Notifications
  emailNotificationStatus: { type: Boolean, default: false },
  smsNotificationStatus: { type: Boolean, default: false },

  // Misc
  trackStatus: { type: Boolean, default: false },
  compleStatus: { type: Boolean, default: false },
  referralStatus: { type: Boolean, default: false },

  // SMTP
  smtpHost: { type: String, default: 'sandbox.smtp.mbiltrap.io' },
  smtpPort: { type: Number, default: 2525 },
  smtpEncryption: { type: String, default: 'tls' },
  smtpUsername: { type: String, default: '58d43f5520c0e' },
  smtpMailFromName: { type: String, default: 'Net-TradersRx' },
  smtpMailFromAddress: { type: String, default: 'support@net-tradersfx.org' },
  smtpPassword: { type: String, default: '' }

}, { timestamps: true });


const Setting = mongoose.model('Setting', settingSchema);

export default Setting;