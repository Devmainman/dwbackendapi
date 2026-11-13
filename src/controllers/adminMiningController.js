import { escapeRegex } from '../utils/validation.js';
// controllers/adminMiningController.js
import mongoose from 'mongoose';
import User from '../models/User.js';
import MiningSession from '../models/MiningSession.js';
import MiningReward from '../models/MiningReward.js';
import MiningEquipment from '../models/MiningEquipment.js';
import MiningPool from '../models/MiningPool.js';
import MiningBooster from '../models/MiningBooster.js';

// Get overall mining statistics
export const getMiningStats = async (req, res) => {
  try {
    // Total mining statistics
    const totalSessions = await MiningSession.countDocuments();
    const activeSessions = await MiningSession.countDocuments({ status: 'active' });
    
    // Total equipment
    const totalEquipment = await MiningEquipment.countDocuments();
    const activeEquipment = await MiningEquipment.countDocuments({ status: 'active' });
    
    // Total rewards
    const totalRewards = await MiningReward.countDocuments();
    const pendingRewards = await MiningReward.countDocuments({ status: 'pending' });
    const claimedRewards = await MiningReward.countDocuments({ status: 'claimed' });
    
    // Total value
    const rewardsValue = await MiningReward.aggregate([
      { $match: { status: 'claimed' } },
      { $group: { _id: null, total: { $sum: '$value' } } }
    ]);
    
    // Daily earnings
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const dailyEarnings = await MiningReward.aggregate([
      { 
        $match: { 
          status: 'claimed',
          claimedAt: { $gte: today }
        }
      },
      { $group: { _id: null, total: { $sum: '$value' } } }
    ]);
    
    // User mining statistics
    const usersWithMining = await User.countDocuments({
      $or: [
        { 'mining.defaultPool': { $exists: true } },
        { 'mining.autoStart': true }
      ]
    });
    
    // Pool statistics
    const poolStats = await MiningPool.aggregate([
      { 
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalMiners: { $sum: '$miners' },
          avgUptime: { $avg: '$uptime' }
        }
      }
    ]);

    res.json({
      success: true,
      stats: {
        overview: {
          totalSessions,
          activeSessions,
          totalEquipment,
          activeEquipment,
          usersWithMining
        },
        rewards: {
          totalRewards,
          pendingRewards,
          claimedRewards,
          totalValue: rewardsValue[0]?.total || 0,
          dailyEarnings: dailyEarnings[0]?.total || 0
        },
        pools: poolStats
      }
    });
  } catch (err) {
    console.error('Get mining stats error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to get mining statistics'
    });
  }
};

// Get all users mining statistics
export const getAllUsersMiningStats = async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '' } = req.query;
    const skip = (page - 1) * limit;

    // Build search query
    const searchQuery = search ? {
      $or: [
        { email: { $regex: escapeRegex(search), $options: 'i' } },
        { firstName: { $regex: escapeRegex(search), $options: 'i' } },
        { lastName: { $regex: escapeRegex(search), $options: 'i' } }
      ]
    } : {};

    // Get users with mining data
    const users = await User.find(searchQuery)
      .select('email firstName lastName balance mining.status accountTypeName')
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    // Get mining statistics for each user
    const usersWithStats = await Promise.all(
      users.map(async (user) => {
        // Get user's mining sessions
        const sessions = await MiningSession.find({ userId: user._id });
        const activeSession = sessions.find(s => s.status === 'active');
        
        // Get user's equipment
        const equipment = await MiningEquipment.find({ userId: user._id });
        const activeEquipment = equipment.filter(e => e.status === 'active');
        
        // Calculate total hash rate and power
        const totalHashRate = activeEquipment.reduce((sum, eq) => sum + eq.hashRate, 0);
        const totalPower = activeEquipment.reduce((sum, eq) => sum + eq.powerConsumption, 0);
        
        // Get total earnings
        const rewards = await MiningReward.find({ userId: user._id, status: 'claimed' });
        const totalEarnings = rewards.reduce((sum, r) => sum + r.value, 0);
        
        return {
          id: user._id,
          email: user.email,
          name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
          balance: user.balance || 0,
          accountType: user.accountTypeName || 'Basic',
          isMining: !!activeSession,
          activeSession: activeSession ? {
            id: activeSession._id,
            startedAt: activeSession.startedAt,
            hashRate: activeSession.hashRate,
            poolId: activeSession.poolId
          } : null,
          equipment: {
            total: equipment.length,
            active: activeEquipment.length,
            hashRate: totalHashRate,
            power: totalPower
          },
          totalEarnings
        };
      })
    );

    // Total count for pagination
    const totalUsers = await User.countDocuments(searchQuery);

    res.json({
      success: true,
      users: usersWithStats,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalUsers,
        pages: Math.ceil(totalUsers / limit)
      }
    });
  } catch (err) {
    console.error('Get all users mining stats error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to get users mining statistics'
    });
  }
};

// Get all mining sessions
export const getAllMiningSessions = async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      status, 
      userId,
      startDate,
      endDate 
    } = req.query;
    
    const skip = (page - 1) * limit;
    
    // Build filter
    const filter = {};
    if (status) filter.status = status;
    if (userId) filter.userId = new mongoose.Types.ObjectId(userId);
    
    // Date filter
    if (startDate || endDate) {
      filter.startedAt = {};
      if (startDate) filter.startedAt.$gte = new Date(startDate);
      if (endDate) filter.startedAt.$lte = new Date(endDate);
    }
    
    const sessions = await MiningSession.find(filter)
      .populate('userId', 'email firstName lastName')
      .populate('poolId', 'name fee')
      .populate('equipment', 'name hashRate')
      .sort({ startedAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();
    
    const totalSessions = await MiningSession.countDocuments(filter);
    
    res.json({
      success: true,
      sessions: sessions.map(session => ({
        id: session._id,
        user: {
          id: session.userId?._id,
          email: session.userId?.email,
          name: `${session.userId?.firstName || ''} ${session.userId?.lastName || ''}`.trim()
        },
        pool: session.poolId?.name || 'Unknown',
        equipmentCount: session.equipment?.length || 0,
        hashRate: session.hashRate,
        powerConsumption: session.powerConsumption,
        status: session.status,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        duration: session.duration,
        earnings: session.earnings,
        createdAt: session.createdAt
      })),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalSessions,
        pages: Math.ceil(totalSessions / limit)
      }
    });
  } catch (err) {
    console.error('Get all mining sessions error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to get mining sessions'
    });
  }
};

// Get all mining rewards
export const getAllMiningRewards = async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      status, 
      coin,
      userId,
      startDate,
      endDate 
    } = req.query;
    
    const skip = (page - 1) * limit;
    
    // Build filter
    const filter = {};
    if (status) filter.status = status;
    if (coin) filter.coin = coin;
    if (userId) filter.userId = new mongoose.Types.ObjectId(userId);
    
    // Date filter
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }
    
    const rewards = await MiningReward.find(filter)
      .populate('userId', 'email firstName lastName')
      .populate('sessionId', 'startedAt endedAt')
      .populate('poolId', 'name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();
    
    const totalRewards = await MiningReward.countDocuments(filter);
    
    // Get total value
    const totalValue = await MiningReward.aggregate([
      { $match: filter },
      { $group: { _id: null, total: { $sum: '$value' } } }
    ]);
    
    res.json({
      success: true,
      rewards: rewards.map(reward => ({
        id: reward._id,
        user: {
          id: reward.userId?._id,
          email: reward.userId?.email,
          name: `${reward.userId?.firstName || ''} ${reward.userId?.lastName || ''}`.trim()
        },
        coin: reward.coin,
        amount: reward.amount,
        value: reward.value,
        status: reward.status,
        session: reward.sessionId ? {
          startedAt: reward.sessionId.startedAt,
          endedAt: reward.sessionId.endedAt
        } : null,
        pool: reward.poolId?.name || 'Unknown',
        confirmed: reward.confirmed,
        confirmations: reward.confirmations,
        claimedAt: reward.claimedAt,
        createdAt: reward.createdAt
      })),
      summary: {
        totalRewards,
        totalValue: totalValue[0]?.total || 0
      },
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalRewards,
        pages: Math.ceil(totalRewards / limit)
      }
    });
  } catch (err) {
    console.error('Get all mining rewards error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to get mining rewards'
    });
  }
};

// Get all mining equipment
export const getAllMiningEquipment = async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      type, 
      status,
      userId 
    } = req.query;
    
    const skip = (page - 1) * limit;
    
    // Build filter
    const filter = {};
    if (type) filter.type = type;
    if (status) filter.status = status;
    if (userId) filter.userId = new mongoose.Types.ObjectId(userId);
    
    const equipment = await MiningEquipment.find(filter)
      .populate('userId', 'email firstName lastName')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();
    
    const totalEquipment = await MiningEquipment.countDocuments(filter);
    
    // Calculate totals
    const totals = await MiningEquipment.aggregate([
      { $match: filter },
      { 
        $group: {
          _id: null,
          totalHashRate: { $sum: '$hashRate' },
          totalPower: { $sum: '$powerConsumption' },
          totalInvestment: { $sum: '$purchasePrice' },
          count: { $sum: 1 }
        }
      }
    ]);
    
    res.json({
      success: true,
      equipment: equipment.map(eq => ({
        id: eq._id,
        user: {
          id: eq.userId?._id,
          email: eq.userId?.email,
          name: `${eq.userId?.firstName || ''} ${eq.userId?.lastName || ''}`.trim()
        },
        name: eq.name,
        type: eq.type,
        hashRate: eq.hashRate,
        powerConsumption: eq.powerConsumption,
        efficiency: eq.efficiency,
        status: eq.status,
        temperature: eq.temperature,
        purchasePrice: eq.purchasePrice,
        totalRuntime: eq.totalRuntime,
        miningSessionId: eq.miningSessionId,
        specifications: eq.specifications,
        createdAt: eq.createdAt
      })),
      summary: totals[0] || {
        totalHashRate: 0,
        totalPower: 0,
        totalInvestment: 0,
        count: 0
      },
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalEquipment,
        pages: Math.ceil(totalEquipment / limit)
      }
    });
  } catch (err) {
    console.error('Get all mining equipment error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to get mining equipment'
    });
  }
};

// Get all mining pools
export const getAllMiningPools = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, algorithm } = req.query;
    const skip = (page - 1) * limit;
    
    // Build filter
    const filter = {};
    if (status) filter.status = status;
    if (algorithm) filter.algorithm = algorithm;
    
    const pools = await MiningPool.find(filter)
      .sort({ miners: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();
    
    const totalPools = await MiningPool.countDocuments(filter);
    
    // Get pool statistics
    const poolStats = await MiningPool.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalMiners: { $sum: '$miners' },
          totalHashRate: { $sum: '$hashRate' },
          avgUptime: { $avg: '$uptime' },
          avgFee: { $avg: '$fee' }
        }
      }
    ]);
    
    res.json({
      success: true,
      pools: pools.map(pool => ({
        id: pool._id,
        name: pool.name,
        url: pool.url,
        fee: pool.fee,
        minPayout: pool.minPayout,
        miners: pool.miners,
        hashRate: pool.hashRate,
        uptime: pool.uptime,
        algorithm: pool.algorithm,
        supportedCoins: pool.supportedCoins,
        paymentMethod: pool.paymentMethod,
        location: pool.location,
        status: pool.status,
        features: pool.features,
        statistics: pool.statistics,
        createdAt: pool.createdAt
      })),
      summary: poolStats[0] || {
        totalMiners: 0,
        totalHashRate: 0,
        avgUptime: 0,
        avgFee: 0
      },
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalPools,
        pages: Math.ceil(totalPools / limit)
      }
    });
  } catch (err) {
    console.error('Get all mining pools error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to get mining pools'
    });
  }
};

// Update mining pool
export const updateMiningPool = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    const pool = await MiningPool.findById(id);
    if (!pool) {
      return res.status(404).json({
        success: false,
        error: 'Mining pool not found'
      });
    }
    
    // Validate fee if provided
    if (updates.fee !== undefined && (updates.fee < 0 || updates.fee > 100)) {
      return res.status(400).json({
        success: false,
        error: 'Fee must be between 0 and 100'
      });
    }
    
    // Validate uptime if provided
    if (updates.uptime !== undefined && (updates.uptime < 0 || updates.uptime > 100)) {
      return res.status(400).json({
        success: false,
        error: 'Uptime must be between 0 and 100'
      });
    }
    
    // Update pool
    Object.keys(updates).forEach(key => {
      pool[key] = updates[key];
    });
    
    await pool.save();
    
    res.json({
      success: true,
      message: 'Mining pool updated successfully',
      pool: {
        id: pool._id,
        name: pool.name,
        fee: pool.fee,
        uptime: pool.uptime,
        status: pool.status,
        updatedAt: pool.updatedAt
      }
    });
  } catch (err) {
    console.error('Update mining pool error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to update mining pool'
    });
  }
};

// Get all mining boosters
export const getAllMiningBoosters = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, type, userId } = req.query;
    const skip = (page - 1) * limit;
    
    // Build filter
    const filter = {};
    if (status) filter.status = status;
    if (type) filter.type = type;
    if (userId) filter.userId = new mongoose.Types.ObjectId(userId);
    
    const boosters = await MiningBooster.find(filter)
      .populate('userId', 'email firstName lastName')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();
    
    const totalBoosters = await MiningBooster.countDocuments(filter);
    
    // Filter active boosters
    const activeBoosters = boosters.filter(b => 
      b.status === 'active' && 
      new Date(b.expiresAt) > new Date()
    );
    
    // Calculate total revenue
    const totalRevenue = await MiningBooster.aggregate([
      { $match: filter },
      { $group: { _id: null, total: { $sum: '$price' } } }
    ]);
    
    res.json({
      success: true,
      boosters: boosters.map(booster => ({
        id: booster._id,
        user: {
          id: booster.userId?._id,
          email: booster.userId?.email,
          name: `${booster.userId?.firstName || ''} ${booster.userId?.lastName || ''}`.trim()
        },
        name: booster.name,
        type: booster.type,
        multiplier: booster.multiplier,
        duration: booster.duration,
        price: booster.price,
        status: booster.status,
        expiresAt: booster.expiresAt,
        activatedAt: booster.activatedAt,
        createdAt: booster.createdAt
      })),
      summary: {
        totalBoosters,
        activeBoosters: activeBoosters.length,
        totalRevenue: totalRevenue[0]?.total || 0
      },
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalBoosters,
        pages: Math.ceil(totalBoosters / limit)
      }
    });
  } catch (err) {
    console.error('Get all mining boosters error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to get mining boosters'
    });
  }
};

// Update user mining settings
export const updateUserMiningSettings = async (req, res) => {
  try {
    const { userId } = req.params;
    const updates = req.body;
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }
    
    // Validate power limit
    if (updates.powerLimit !== undefined && updates.powerLimit < 0) {
      return res.status(400).json({
        success: false,
        error: 'Power limit cannot be negative'
      });
    }
    
    // Validate temperature alert
    if (updates.temperatureAlert !== undefined && updates.temperatureAlert < 0) {
      return res.status(400).json({
        success: false,
        error: 'Temperature alert cannot be negative'
      });
    }
    
    // Update mining settings
    if (!user.mining) user.mining = {};
    
    Object.keys(updates).forEach(key => {
      if (key === 'defaultPool') {
        user.mining.defaultPool = updates.defaultPool;
      } else if (key === 'notifications') {
        if (!user.mining.notifications) user.mining.notifications = {};
        Object.keys(updates.notifications).forEach(notifKey => {
          user.mining.notifications[notifKey] = updates.notifications[notifKey];
        });
      } else {
        user.mining[key] = updates[key];
      }
    });
    
    await user.save();
    
    res.json({
      success: true,
      message: 'User mining settings updated successfully',
      settings: user.mining
    });
  } catch (err) {
    console.error('Update user mining settings error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to update user mining settings'
    });
  }
};

// Delete mining session
export const deleteMiningSession = async (req, res) => {
  try {
    const { id } = req.params;
    
    const session = await MiningSession.findById(id);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Mining session not found'
      });
    }
    
    // Can't delete active sessions
    if (session.status === 'active') {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete active mining session'
      });
    }
    
    // Update equipment linked to this session
    await MiningEquipment.updateMany(
      { miningSessionId: id },
      { $set: { miningSessionId: null } }
    );
    
    await MiningSession.findByIdAndDelete(id);
    
    res.json({
      success: true,
      message: 'Mining session deleted successfully'
    });
  } catch (err) {
    console.error('Delete mining session error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to delete mining session'
    });
  }
};

// Delete mining reward
export const deleteMiningReward = async (req, res) => {
  try {
    const { id } = req.params;
    
    const reward = await MiningReward.findById(id);
    if (!reward) {
      return res.status(404).json({
        success: false,
        error: 'Mining reward not found'
      });
    }
    
    // Can't delete claimed rewards
    if (reward.status === 'claimed') {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete claimed rewards'
      });
    }
    
    await MiningReward.findByIdAndDelete(id);
    
    res.json({
      success: true,
      message: 'Mining reward deleted successfully'
    });
  } catch (err) {
    console.error('Delete mining reward error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to delete mining reward'
    });
  }
};

// Delete mining equipment
export const deleteMiningEquipment = async (req, res) => {
  try {
    const { id } = req.params;
    
    const equipment = await MiningEquipment.findById(id);
    if (!equipment) {
      return res.status(404).json({
        success: false,
        error: 'Mining equipment not found'
      });
    }
    
    // Can't delete active equipment
    if (equipment.status === 'active') {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete active mining equipment'
      });
    }
    
    await MiningEquipment.findByIdAndDelete(id);
    
    res.json({
      success: true,
      message: 'Mining equipment deleted successfully'
    });
  } catch (err) {
    console.error('Delete mining equipment error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to delete mining equipment'
    });
  }
};

// Get mining analytics
export const getMiningAnalytics = async (req, res) => {
  try {
    const { period = '7d' } = req.query; // 7d, 30d, 90d, 1y
    
    // Calculate date range
    const endDate = new Date();
    let startDate = new Date();
    
    switch (period) {
      case '7d':
        startDate.setDate(startDate.getDate() - 7);
        break;
      case '30d':
        startDate.setDate(startDate.getDate() - 30);
        break;
      case '90d':
        startDate.setDate(startDate.getDate() - 90);
        break;
      case '1y':
        startDate.setFullYear(startDate.getFullYear() - 1);
        break;
      default:
        startDate.setDate(startDate.getDate() - 7);
    }
    
    // Daily earnings data
    const dailyEarnings = await MiningReward.aggregate([
      {
        $match: {
          status: 'claimed',
          claimedAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$claimedAt' }
          },
          earnings: { $sum: '$value' },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);
    
    // Coin distribution
    const coinDistribution = await MiningReward.aggregate([
      {
        $match: {
          status: 'claimed',
          claimedAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: '$coin',
          totalAmount: { $sum: '$amount' },
          totalValue: { $sum: '$value' },
          count: { $sum: 1 }
        }
      },
      { $sort: { totalValue: -1 } }
    ]);
    
    // User mining activity
    const userActivity = await MiningSession.aggregate([
      {
        $match: {
          startedAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: '$userId',
          sessions: { $sum: 1 },
          totalEarnings: { $sum: '$earnings' },
          totalHours: { $sum: { $divide: ['$duration', 3600] } }
        }
      },
      { $sort: { totalEarnings: -1 } },
      { $limit: 10 }
    ]);
    
    // Pool performance
    const poolPerformance = await MiningSession.aggregate([
      {
        $match: {
          startedAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: '$poolId',
          sessions: { $sum: 1 },
          avgHashRate: { $avg: '$hashRate' },
          totalEarnings: { $sum: '$earnings' }
        }
      },
      { $sort: { totalEarnings: -1 } }
    ]);
    
    // Get pool names for performance data
    const poolIds = poolPerformance.map(p => p._id);
    const pools = await MiningPool.find({ _id: { $in: poolIds } })
      .select('name fee')
      .lean();
    
    const poolMap = pools.reduce((map, pool) => {
      map[pool._id.toString()] = pool;
      return map;
    }, {});
    
    // Format pool performance with names
    const formattedPoolPerformance = poolPerformance.map(perf => ({
      poolId: perf._id,
      poolName: poolMap[perf._id.toString()]?.name || 'Unknown',
      sessions: perf.sessions,
      avgHashRate: perf.avgHashRate,
      totalEarnings: perf.totalEarnings
    }));
    
    res.json({
      success: true,
      analytics: {
        period,
        startDate,
        endDate,
        dailyEarnings,
        coinDistribution,
        userActivity,
        poolPerformance: formattedPoolPerformance,
        summary: {
          totalDays: Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)),
          totalEarnings: dailyEarnings.reduce((sum, day) => sum + day.earnings, 0),
          totalSessions: dailyEarnings.reduce((sum, day) => sum + day.count, 0)
        }
      }
    });
  } catch (err) {
    console.error('Get mining analytics error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to get mining analytics'
    });
  }
};

// Export mining data
export const exportMiningData = async (req, res) => {
  try {
    const { type = 'rewards', format = 'json', startDate, endDate } = req.query;
    
    // Build date filter
    const dateFilter = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {};
      if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
      if (endDate) dateFilter.createdAt.$lte = new Date(endDate);
    }
    
    let data;
    let filename;
    
    switch (type) {
      case 'rewards':
        data = await MiningReward.find(dateFilter)
          .populate('userId', 'email')
          .populate('sessionId', 'startedAt endedAt')
          .populate('poolId', 'name')
          .lean();
        filename = `mining-rewards-${new Date().toISOString().split('T')[0]}`;
        break;
        
      case 'sessions':
        data = await MiningSession.find(dateFilter)
          .populate('userId', 'email')
          .populate('poolId', 'name')
          .populate('equipment', 'name hashRate')
          .lean();
        filename = `mining-sessions-${new Date().toISOString().split('T')[0]}`;
        break;
        
      case 'equipment':
        data = await MiningEquipment.find(dateFilter)
          .populate('userId', 'email')
          .lean();
        filename = `mining-equipment-${new Date().toISOString().split('T')[0]}`;
        break;
        
      default:
        return res.status(400).json({
          success: false,
          error: 'Invalid export type'
        });
    }
    
    if (format === 'csv') {
      // Convert to CSV
      const headers = Object.keys(data[0] || {}).join(',');
      const rows = data.map(row => 
        Object.values(row).map(val => 
          typeof val === 'object' ? JSON.stringify(val) : val
        ).join(',')
      );
      const csv = [headers, ...rows].join('\n');
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=${filename}.csv`);
      return res.send(csv);
    } else {
      // JSON format
      res.json({
        success: true,
        type,
        count: data.length,
        data
      });
    }
  } catch (err) {
    console.error('Export mining data error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to export mining data'
    });
  }
};