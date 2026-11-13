// routes/userTradeRoutes.js
import express from 'express';
import { 
  getAvailablePackages,
  getPackageDetails,
  createUserTrade,
  getUserTrades,
  getUserTradeStatistics,
  cancelTrade,
  getTradeDetails
} from '../controllers/userTradeController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// @route   GET /api/user-trades/packages
// @desc    Get all available trade packages
// @access  Private
router.get('/packages', authenticate, getAvailablePackages);

// @route   GET /api/user-trades/packages/:id
// @desc    Get specific trade package details
// @access  Private
router.get('/packages/:id', authenticate, getPackageDetails);

// @route   POST /api/user-trades/create
// @desc    Create a new trade with package
// @access  Private
router.post('/create', authenticate, createUserTrade);

// @route   GET /api/user-trades
// @desc    Get user's trades with pagination
// @access  Private
router.get('/', authenticate, getUserTrades);

// @route   GET /api/user-trades/statistics
// @desc    Get user's trading statistics
// @access  Private
router.get('/statistics', authenticate, getUserTradeStatistics);

// @route   POST /api/user-trades/:id/cancel
// @desc    Cancel a pending trade
// @access  Private
router.post('/:id/cancel', authenticate, cancelTrade);

// @route   GET /api/user-trades/:id
// @desc    Get specific trade details
// @access  Private
router.get('/:id', authenticate, getTradeDetails);

export default router;