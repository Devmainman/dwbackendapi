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


// Appearance: the colour tone of the user dashboard.
export const DASHBOARD_THEMES = ['amber', 'classic-blue', 'navy', 'gold', 'silver'];

export const getAppearanceSettings = async (req, res) => {
  try {
    const settings = await Setting.findOne().lean();
    res.json({ success: true, settings: { dashboardTheme: settings?.dashboardTheme || 'amber', themes: DASHBOARD_THEMES } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error fetching appearance settings' });
  }
};

export const updateAppearanceSettings = async (req, res) => {
  try {
    const { dashboardTheme } = req.body || {};
    if (!DASHBOARD_THEMES.includes(dashboardTheme)) {
      return res.status(400).json({ success: false, message: 'Unknown dashboard theme' });
    }
    const settings = await Setting.findOneAndUpdate({}, { $set: { dashboardTheme } }, { new: true, upsert: true });
    res.json({ success: true, message: 'Dashboard theme updated', settings: { dashboardTheme: settings.dashboardTheme } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error updating appearance settings' });
  }
};
