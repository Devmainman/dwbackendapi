import express from 'express';
import TradingConfig from '../../models/TradingConfig.js';

const router = express.Router();

// GET current mode
router.get('/', async (req, res) => {
  try {
    const cfg = await TradingConfig.findOne();
    if (!cfg) return res.json({ mode: 'simulation' });
    res.json({ mode: cfg.mode, updatedAt: cfg.updatedAt || cfg.updatedAt });
  } catch (err) {
    console.error('Get trading mode error', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT toggle/set mode
router.put('/', async (req, res) => {
  try {
    const { mode } = req.body;
    if (!['simulation', 'live'].includes(mode)) {
      return res.status(400).json({ error: 'Invalid mode. Allowed: simulation, live' });
    }
    let cfg = await TradingConfig.findOne();
    if (!cfg) cfg = new TradingConfig({ mode });
    else cfg.mode = mode;
    cfg.updatedAt = new Date();
    await cfg.save();
    res.json({ success: true, mode: cfg.mode });
  } catch (err) {
    console.error('Set trading mode error', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
