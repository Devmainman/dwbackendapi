import mongoose from 'mongoose';
import Setting from '../models/Setting.js';
import Package from '../models/Package.js';
import Currency from '../models/Currency.js';

export const getUserThreshold = async (user) => {
  let threshold = null;
  let packageCurrencyCode = null;

  // If populated accountType has threshold
  if (user.accountType && typeof user.accountType === 'object') {
    threshold = user.accountType.threshold;
    packageCurrencyCode = user.accountType.currency;
  }

  // If accountType is an ObjectId (not populated)
  if ((!threshold || !packageCurrencyCode) && mongoose.Types.ObjectId.isValid(user.accountType)) {
    const pkg = await Package.findById(user.accountType);
    if (pkg) {
      threshold = pkg.threshold;
      packageCurrencyCode = pkg.currency;
    }
  }

  // If accountType is object with _id but missing fields
  if ((!threshold || !packageCurrencyCode) && user.accountType && user.accountType._id) {
    const pkg = await Package.findById(user.accountType._id);
    if (pkg) {
      threshold = pkg.threshold;
      packageCurrencyCode = pkg.currency;
    }
  }

  // If still no threshold, use default system setting
  if (!threshold || isNaN(threshold)) {
    const settings = await Setting.findOne();
    threshold = settings?.defaultThreshold || 1000;
    packageCurrencyCode = settings?.defaultCurrency || 'USD';
  }

  // Currency conversion
  const userCurrency = await Currency.findOne({ code: user.currency });
  const packageCurrency = await Currency.findOne({ code: packageCurrencyCode });

  if (!userCurrency || !packageCurrency || !userCurrency.rate || !packageCurrency.rate) {
    return parseFloat(threshold); // fallback to raw threshold
  }

  // Convert threshold from packageCurrency to userCurrency
  const convertedThreshold = (threshold * userCurrency.rate) / packageCurrency.rate;
  return parseFloat(convertedThreshold.toFixed(2));
};
