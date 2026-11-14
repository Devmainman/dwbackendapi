import { settleTrade } from '../services/botTradeEngine.js';
// controllers/adminTradingController.js
import Trade from '../models/Trade.js';
import TradePackage from '../models/TradePackage.js';
import Setting from '../models/Setting.js';
import User from '../models/User.js';
import mongoose from 'mongoose';

// Get all trades (admin view)
export const getAllTrades = async (req, res) => {
  try {
    const { status, userId, page = 1, limit = 20 } = req.query;
    
    const query = {};
    if (status) query.status = status;
    if (userId && mongoose.Types.ObjectId.isValid(userId)) query.userId = userId;
    
    const packages = await TradePackage.find(query)
  .sort({ createdAt: -1 })
  .lean();

res.json({
  success: true,
  packages
});

  } catch (err) {
    console.error('Get all trades error:', err);
    res.status(500).json({ 
      success: false,
      message: 'Server error fetching trades' 
    });
  }
};

// Admin update trade status
export const adminUpdateTrade = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    // Completing pays stake + full profit; terminating refunds the stake. Both settle exactly once.
    if (!['completed', 'terminated'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "status must be 'completed' (pay stake + profit) or 'terminated' (refund stake)"
      });
    }

    const settled = await settleTrade(id, status === 'completed' ? 'admin_completed' : 'admin_terminated');
    if (!settled) {
      return res.status(400).json({ success: false, message: 'Trade not found or already settled' });
    }
    const updatedTrade = await Trade.findById(id).populate('userId', 'accountId email firstName lastName');
    
    if (!updatedTrade) {
      return res.status(404).json({
        success: false,
        message: 'Trade not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Trade updated successfully',
      trade: updatedTrade
    });
  } catch (err) {
    console.error('Admin update trade error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error updating trade'
    });
  }
};


export const createTradePackage = async (req, res) => {
  try {
    const {
      name,
      description,
      minAmount,
      maxAmount,
      profitRate,
      profitInterval,
      duration,
      status
    } = req.body;

    // Validation
    if (!name || !minAmount || !maxAmount || !profitRate || !duration) {
      return res.status(400).json({
        success: false,
        message: 'Required fields: name, minAmount, maxAmount, profitRate, duration'
      });
    }

    if (minAmount >= maxAmount) {
      return res.status(400).json({
        success: false,
        message: 'maxAmount must be greater than minAmount'
      });
    }

    // Get default currency from settings
    const settings = await Setting.findOne().lean();
    const defaultCurrency = settings?.defaultCurrency || 'USD';

    const newPackage = new TradePackage({
      name,
      description,
      minAmount,
      maxAmount,
      profitRate,
      profitInterval,
      duration,
      defaultCurrency,
      status
    });

    await newPackage.save();

    res.status(201).json({
      success: true,
      message: 'Trade package created successfully',
      package: newPackage
    });

  } catch (err) {
    console.error('Create trade package error:', err);

    if (err.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'A trade package with this name already exists'
      });
    }

    res.status(500).json({
      success: false,
      message: err.message || 'Server error creating trade package'
    });
  }
};


export const getTradePackages = async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    
    const query = {};
    if (status) query.status = status;
    
    const options = {
      page: parseInt(page),
      limit: parseInt(limit),
      sort: { createdAt: -1 }
    };
    
    const packages = await TradePackage.find(query)
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      packages
    });

  } catch (err) {
    console.error('Get trade packages error:', err);
    res.status(500).json({ 
      success: false,
      message: 'Server error fetching trade packages' 
    });
  }
};

export const updateTradePackage = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Block currency edits
    delete updates.currency;
    delete updates.defaultCurrency;

    if (updates.minAmount && updates.maxAmount && updates.minAmount >= updates.maxAmount) {
      return res.status(400).json({
        success: false,
        message: 'maxAmount must be greater than minAmount'
      });
    }

    const updatedPackage = await TradePackage.findByIdAndUpdate(
      id,
      updates,
      { new: true }
    );

    if (!updatedPackage) {
      return res.status(404).json({
        success: false,
        message: 'Trade package not found'
      });
    }

    res.json({
      success: true,
      message: 'Trade package updated successfully',
      package: updatedPackage
    });

  } catch (err) {
    console.error('Update trade package error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error updating trade package'
    });
  }
};


export const deleteTradePackage = async (req, res) => {
  try {
    const { id } = req.params;
    
    const deletedPackage = await TradePackage.findByIdAndDelete(id);
    
    if (!deletedPackage) {
      return res.status(404).json({
        success: false,
        message: 'Trade package not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Trade package deleted successfully'
    });
  } catch (err) {
    console.error('Delete trade package error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error deleting trade package'
    });
  }
};

// Admin trade statistics
export const getTradeStatistics = async (req, res) => {
  try {
    const [totalTrades, activeTrades, completedTrades, totalProfit] = await Promise.all([
      Trade.countDocuments(),
      Trade.countDocuments({ status: 'in-progress' }),
      Trade.countDocuments({ status: 'completed' }),
      Trade.aggregate([
        { $match: { status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$profit' } } }
      ])
    ]);
    
    const profit = totalProfit.length > 0 ? totalProfit[0].total : 0;
    
    res.json({
      success: true,
      statistics: {
        totalTrades,
        activeTrades,
        completedTrades,
        totalProfit: profit
      }
    });
  } catch (err) {
    console.error('Get trade statistics error:', err);
    res.status(500).json({ 
      success: false,
      message: 'Server error fetching trade statistics' 
    });
  }
};