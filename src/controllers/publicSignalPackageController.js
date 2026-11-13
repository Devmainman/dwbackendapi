
import SignalPackage from '../models/SignalPackage.js';
import User from '../models/User.js';
import Currency from '../models/Currency.js';

export const getPublicSignalPackages = async (req, res) => {
  try {
    const packages = await SignalPackage.find({ active: true })
      .sort({ amount: 1 })
      .lean();

    let userCurrencyCode = null;

    if (req.user?.id) {
      const user = await User.findById(req.user.id).lean();
      if (user?.currency) userCurrencyCode = user.currency;
    }

    // If no user currency → just return raw USD/base prices
    if (!userCurrencyCode) {
      return res.json({
        success: true,
        packages: packages.map(p => ({
          ...p,
          baseAmount: p.amount,
          baseCurrency: 'USD',
          amount: p.amount,
          currency: 'USD'
        }))
      });
    }

    const baseCurrency = await Currency.findOne({ code: 'USD', status: 'Enabled' });
    const userCurrency = await Currency.findOne({ code: userCurrencyCode, status: 'Enabled' });

    // If currency missing → graceful fallback
    if (!baseCurrency || !userCurrency) {
      return res.json({
        success: true,
        packages: packages.map(p => ({
          ...p,
          baseAmount: p.amount,
          baseCurrency: 'USD',
          amount: p.amount,
          currency: 'USD'
        }))
      });
    }

    const rate = userCurrency.rate / baseCurrency.rate;

    console.log("RATE USED:", rate);
    console.log("FROM:", baseCurrency.code, "TO:", userCurrency.code);

    const converted = packages.map(pkg => {
      const convertedAmount = pkg.amount * rate;

      return {
        ...pkg,
        baseAmount: pkg.amount,
        baseCurrency: baseCurrency.code,
        amount: Number(convertedAmount.toFixed(2)),
        currency: userCurrency.code
      };
    });

    return res.json({
      success: true,
      packages: converted
    });

  } catch (err) {
    console.error('Get public signal packages error:', err);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching signal packages'
    });
  }
};



