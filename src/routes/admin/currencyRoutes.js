import { escapeRegex } from '../../utils/validation.js';
import express from 'express';
import Currency from '../../models/Currency.js';
import { authenticate, isAdmin } from '../../middleware/auth.js';
import Setting from '../../models/Setting.js';
import { syncLiveRates, invalidateRates, rateBetween } from '../../services/fx.js';

const router = express.Router();

// Live-rate sync status: last sync, source, auto-sync flag and interval
router.get('/fx-status', authenticate, isAdmin, async (_req, res) => {
  const s = await Setting.findOne().select('currencyAutoSync currencyLastSyncedAt currencyRateSource currencyInterval defaultCurrency').lean();
  res.json({
    success: true,
    data: {
      autoSync: s?.currencyAutoSync !== false,
      lastSyncedAt: s?.currencyLastSyncedAt || null,
      source: s?.currencyRateSource || 'open.er-api.com',
      interval: s?.currencyInterval || 'Every 6 Hours',
      defaultCurrency: s?.defaultCurrency || 'USD'
    }
  });
});

// Pull live market rates now
router.post('/sync', authenticate, isAdmin, async (_req, res) => {
  try {
    const r = await syncLiveRates();
    res.json({ success: true, message: `Updated ${r.updated} rates`, data: r });
  } catch (e) {
    res.status(502).json({ success: false, message: `Rate feed unavailable: ${e.message}` });
  }
});

// Turn automatic syncing on/off
router.put('/auto-sync', authenticate, isAdmin, async (req, res) => {
  const on = req.body?.enabled !== false;
  await Setting.updateOne({}, { $set: { currencyAutoSync: on } }, { upsert: true });
  res.json({ success: true, data: { autoSync: on } });
});

// Quick converter for admins to sanity-check rates: /convert?amount=100&from=USD&to=EUR
router.get('/convert', authenticate, isAdmin, async (req, res) => {
  try {
    const amount = Number(req.query.amount || 1);
    const rate = await rateBetween(req.query.from || 'USD', req.query.to || 'USD');
    res.json({ success: true, data: { amount, from: req.query.from, to: req.query.to, rate, result: Math.round(amount * rate * 100) / 100 } });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message });
  }
});

// Get all currencies with pagination
router.get('/', authenticate, isAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 10, search = '' } = req.query;
    
    const filter = {
      $or: [
        { title: { $regex: escapeRegex(search), $options: 'i' } },
        { code: { $regex: escapeRegex(search), $options: 'i' } }
      ]
    };

    const currencies = await Currency.find(filter)
      .sort({ code: 1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();

    const count = await Currency.countDocuments(filter);

    res.json({
  success: true,
  currencies,
  totalPages: Math.ceil(count / limit),
  currentPage: Number(page),
  totalCurrencies: count
});

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update currency status
router.put('/:id/status', authenticate, isAdmin, async (req, res) => {
  try {
    const currency = await Currency.findById(req.params.id);
    if (!currency) return res.status(404).json({ error: 'Currency not found' });

    currency.status = currency.status === 'Enabled' ? 'Disabled' : 'Enabled';
    await currency.save();

    res.json(currency);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update currency rate
router.put('/:id/rate', authenticate, isAdmin, async (req, res) => {
  try {
    const { rate } = req.body;
    if (!rate || isNaN(rate)) {
      return res.status(400).json({ error: 'Valid rate required' });
    }

    const currency = await Currency.findById(req.params.id);
    if (!currency) return res.status(404).json({ error: 'Currency not found' });

    if (!(parseFloat(rate) > 0)) return res.status(400).json({ error: 'Rate must be greater than zero' });
    if (currency.code === 'USD' && parseFloat(rate) !== 1) return res.status(400).json({ error: 'USD is the reference currency and must stay at 1' });
    currency.rate = parseFloat(rate);
    await currency.save();
    invalidateRates();

    res.json(currency);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Batch update status
router.put('/batch-status', authenticate, isAdmin, async (req, res) => {
  try {
    const { ids, status } = req.body;
    
    if (!ids || !ids.length || !['Enabled', 'Disabled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    await Currency.updateMany(
      { _id: { $in: ids } },
      { $set: { status } }
    );

    res.json({ message: 'Currencies updated successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;