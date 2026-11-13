// routes/priceRoutes.js
import express from 'express';
import axios from 'axios';

const router = express.Router();

// Get live prices from Binance
router.get('/prices', async (req, res) => {
  try {
    const symbols = ['BTCUSDT', 'ETHUSDT', 'DOGEUSDT', 'SOLUSDT', 'XRPUSDT'];
    
    // Fetch all prices in parallel
    const pricePromises = symbols.map(symbol => 
      axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`)
    );
    
    const responses = await Promise.all(pricePromises);
    
    const prices = {
      "BTC/USDT": {
        price: parseFloat(responses[0].data.lastPrice).toFixed(4),
        change: parseFloat(responses[0].data.priceChangePercent).toFixed(2),
        high: responses[0].data.highPrice,
        low: responses[0].data.lowPrice,
        volume: responses[0].data.volume
      },
      "ETH/USDT": {
        price: parseFloat(responses[1].data.lastPrice).toFixed(4),
        change: parseFloat(responses[1].data.priceChangePercent).toFixed(2),
        high: responses[1].data.highPrice,
        low: responses[1].data.lowPrice,
        volume: responses[1].data.volume
      },
      "DOGE/USDT": {
        price: parseFloat(responses[2].data.lastPrice).toFixed(4),
        change: parseFloat(responses[2].data.priceChangePercent).toFixed(2),
        high: responses[2].data.highPrice,
        low: responses[2].data.lowPrice,
        volume: responses[2].data.volume
      },
      "SOL/USDT": {
        price: parseFloat(responses[3].data.lastPrice).toFixed(4),
        change: parseFloat(responses[3].data.priceChangePercent).toFixed(2),
        high: responses[3].data.highPrice,
        low: responses[3].data.lowPrice,
        volume: responses[3].data.volume
      },
      "XRP/USDT": {
        price: parseFloat(responses[4].data.lastPrice).toFixed(4),
        change: parseFloat(responses[4].data.priceChangePercent).toFixed(2),
        high: responses[4].data.highPrice,
        low: responses[4].data.lowPrice,
        volume: responses[4].data.volume
      }
    };
    
    res.json({ 
      success: true, 
      prices,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Price fetch error:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch prices',
      message: error.message 
    });
  }
});

export default router;