import Setting from '../models/Setting.js';

export const getCurrencySettings = async (req, res) => {
  try {
    let settings = await Setting.findOne();

    if (!settings) {
      settings = await Setting.create({
        currencyApiKey: '',
        currencyApiUrl: '',
        currencyInterval: 'Daily',
        defaultCurrency: 'USD'
      });
    }

    res.json({
      success: true,
      settings: {
        currencyApiKey: settings.currencyApiKey || '',
        currencyApiUrl: settings.currencyApiUrl || '',
        currencyInterval: settings.currencyInterval || '',
        defaultCurrency: settings.defaultCurrency || ''
      }
    });

  } catch (err) {
    console.error('Get currency settings error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error fetching currency settings'
    });
  }
};

export const updateCurrencySettings = async (req, res) => {
  try {
    const { currencyApiKey, currencyApiUrl, currencyInterval, defaultCurrency } = req.body;

    let settings = await Setting.findOne();
    if (!settings) settings = new Setting();

    settings.currencyApiKey = currencyApiKey;
    settings.currencyApiUrl = currencyApiUrl;
    settings.currencyInterval = currencyInterval;
    settings.defaultCurrency = defaultCurrency;

    await settings.save();

    res.json({
      success: true,
      message: 'Currency settings updated successfully'
    });

  } catch (err) {
    console.error('Update currency settings error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error updating currency settings'
    });
  }
};
