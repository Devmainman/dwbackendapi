import Setting from '../models/Setting.js';
import SimulatedTrade from '../models/SimulatedTrade.js';
import TradingConfig from '../models/TradingConfig.js';
import User from '../models/User.js';

// Simple mock price engine - deterministic pseudo-random around a base.
// Replace with real feed later.
let basePrice = 100; // you can persist this in DB if needed


// GET /api/trading/sim/price
export const getLivePrice = async (req, res) => {
  try {
    await ensureSimulationMode();
    const price = getMockPrice();
    return res.json({ success: true, price });
  } catch (err) {
    console.error("Live Price Error:", err);
    return res.status(500).json({ error: err.message });
  }
};


function getMockPrice() {
  // change base slightly by time to make repeated calls different
  const t = Date.now() / 10000;
  const volatility = 0.03; // 3% typical swing
  const noise = (Math.sin(t) + Math.cos(t * 0.7)) * 0.5;
  const random = (Math.random() - 0.5) * 2; // random -1..1
  const changeFactor = 1 + (noise * 0.002) + (random * volatility);
  basePrice = Math.max(0.0001, basePrice * changeFactor);
  return Number(basePrice.toFixed(6));
}

async function ensureSimulationMode() {
  const cfg = await TradingConfig.findOne();
  if (cfg && cfg.mode === 'live') {
    const error = new Error('Trading is currently enabled in LIVE mode — simulation endpoints are disabled');
    error.status = 400;
    throw error;
  }
}

// POST /api/trading/sim/buy
export const buy = async (req, res) => {
  try {
    await ensureSimulationMode();

    const userId = req.user.id;
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // FETCH ADMIN SIGNAL
    const settings = await Setting.findOne();
    const adminSignal = Number(settings?.signalStrength?.trading);

    if (!adminSignal || adminSignal <= 0) {
      return res.status(400).json({
        error: 'Trading disabled by admin'
      });
    }

    // SIGNAL CHECKS
    if (user.tradingSignalStrength <= 0) {
      return res.status(400).json({
        error: 'Your trading signal strength is exhausted'
      });
    }

    if (user.tradingSignalStrength < adminSignal) {
      return res.status(400).json({
        error: `Insufficient signal strength. You need at least ${adminSignal}%`
      });
    }

    // BALANCE LOGIC — UNTOUCHED
    if (user.balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const price = getMockPrice();
    const quantity = Number((amount / price).toFixed(8));

    // BALANCE DEDUCTION — SAME AS BEFORE
    await user.updateBalance(amount, 'debit');

    // DEDUCT SIGNAL (FIXED AMOUNT)
    user.tradingSignalStrength =
      Number((user.tradingSignalStrength - adminSignal).toFixed(2));
    user.tradingSignalUpdatedAt = new Date();

    await user.save();

    const trade = new SimulatedTrade({
      user: userId,
      side: 'buy',
      amount,
      quantity,
      entryPrice: price,
      status: 'open',
      metadata: {
        source: 'simulation',
        signalUsed: adminSignal
      }
    });

    await trade.save();

    return res.json({
      success: true,
      trade,
      remainingSignalStrength: user.tradingSignalStrength
    });

  } catch (err) {
    console.error('Sim Buy Error:', err);
    return res.status(err.status || 500).json({
      error: err.message || 'Internal error'
    });
  }
};


// POST /trading/sim/sell

// POST /trading/sim/sell
export const sell = async (req, res) => {
  try {
    await ensureSimulationMode(); // make sure simulation mode is on

    const userId = req.user.id;
    const positionId = req.params.id;
    const { symbol, amount } = req.body || {};

    if (!positionId && !symbol) {
      return res.status(400).json({
        error: "Missing required parameter: provide either position ID in URL or symbol in body"
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // FETCH ADMIN SIGNAL
    const settings = await Setting.findOne();
    const adminSignal = Number(settings?.signalStrength?.trading);

    if (!adminSignal || adminSignal <= 0) {
      return res.status(400).json({ error: 'Trading disabled by admin' });
    }

    // SIGNAL CHECKS
    if (user.tradingSignalStrength <= 0) {
      return res.status(400).json({
        error: 'Your trading signal strength is exhausted'
      });
    }

    if (user.tradingSignalStrength < adminSignal) {
      return res.status(400).json({
        error: `Insufficient signal strength. You need at least ${adminSignal}%`
      });
    }

    console.log("Sim Sell Request:", { positionId, symbol, amount });

    // --- SELL LOGIC (mocked for now) ---
    if (positionId) {
      console.log(`Selling position ID: ${positionId} with amount: ${amount || 'full'}`);
    } else {
      console.log(`Selling symbol: ${symbol} with amount: ${amount || 'full'}`);
    }

    // DEDUCT SIGNAL STRENGTH
    user.tradingSignalStrength = Number((user.tradingSignalStrength - adminSignal).toFixed(2));
    user.tradingSignalUpdatedAt = new Date();
    await user.save();

    return res.status(200).json({
      success: true,
      message: positionId ? `Position ${positionId} sold` : `Symbol ${symbol} sold`,
      data: {
        positionId,
        symbol,
        amount: amount || "full",
        signalUsed: adminSignal
      },
      remainingSignalStrength: user.tradingSignalStrength
    });

  } catch (err) {
    console.error("Sim Sell Error:", err);
    return res.status(500).json({ error: err.message });
  }
};






// GET /api/trading/sim/positions
export const getOpenPositions = async (req, res) => {
  try {
    await ensureSimulationMode();

    const userId = req.user.id;
    const open = await SimulatedTrade.find({ user: userId, status: 'open' }).sort({ openedAt: -1 });
    return res.json({ success: true, open });
  } catch (err) {
    console.error('Get Open Positions Error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};

// GET /api/trading/sim/history
export const getHistory = async (req, res) => {
  try {
    await ensureSimulationMode();

    const userId = req.user.id;
    const closed = await SimulatedTrade.find({ user: userId, status: 'closed' }).sort({ closedAt: -1 }).limit(200);
    return res.json({ success: true, history: closed });
  } catch (err) {
    console.error('Get Sim History Error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};


// Add this function to calculate real-time P/L
export const calculateRealTimePL = async (req, res) => {
  try {
    await ensureSimulationMode();
    const userId = req.user.id;
    
    // Get open positions
    const openPositions = await SimulatedTrade.find({ 
      user: userId, 
      status: 'open' 
    });
    
    // Calculate real-time P/L for each position
    const positionsWithPL = await Promise.all(
      openPositions.map(async (position) => {
        const currentPrice = getMockPrice(); // Use your price source
        const marketValue = position.quantity * currentPrice;
        const entryValue = position.quantity * position.entryPrice;
        const unrealizedPL = marketValue - entryValue;
        const unrealizedPLPercent = ((unrealizedPL / entryValue) * 100).toFixed(2);
        
        return {
          ...position.toObject(),
          currentPrice,
          marketValue: parseFloat(marketValue.toFixed(8)),
          unrealizedPL: parseFloat(unrealizedPL.toFixed(8)),
          unrealizedPLPercent: parseFloat(unrealizedPLPercent),
          updatedAt: new Date()
        };
      })
    );
    
    // Calculate total P/L
    const totalUnrealizedPL = positionsWithPL.reduce(
      (sum, pos) => sum + pos.unrealizedPL, 0
    );
    
    return res.json({
      success: true,
      positions: positionsWithPL,
      summary: {
        totalUnrealizedPL: parseFloat(totalUnrealizedPL.toFixed(8)),
        totalPositions: positionsWithPL.length,
        updatedAt: new Date().toISOString()
      }
    });
  } catch (err) {
    console.error('Calculate P/L Error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};


// Add balance management endpoints
export const topupBalance = async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const user = await User.findById(userId);
    const updatedUser = await user.updateBalance(amount, 'credit');
    
    return res.json({
      success: true,
      message: `Balance topped up successfully`,
      newBalance: updatedUser.balance,
      transactionId: uuidv4()
    });
  } catch (err) {
    console.error('Topup Error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};

export const deductBalance = async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const user = await User.findById(userId);
    
    if (user.balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const updatedUser = await user.updateBalance(amount, 'debit');
    
    return res.json({
      success: true,
      message: `Balance deducted successfully`,
      newBalance: updatedUser.balance,
      transactionId: uuidv4()
    });
  } catch (err) {
    console.error('Deduction Error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};

// Price conversion helper functions (you'll need to implement these)
async function convertPrice(price, fromCurrency, toCurrency) {
  // Implement currency conversion logic here
  // You can use an API like ExchangeRate-API or store rates in your database
  if (fromCurrency === toCurrency) return price;
  
  // For now, return a mock conversion
  const conversionRates = {
    USD: 1,
    EUR: 0.92,
    GBP: 0.79,
    NGN: 1500,
    JPY: 147
  };
  
  const fromRate = conversionRates[fromCurrency] || 1;
  const toRate = conversionRates[toCurrency] || 1;
  
  return (price * toRate) / fromRate;
}

async function convertAmount(amount, fromCurrency, toCurrency) {
  return convertPrice(amount, fromCurrency, toCurrency);
}