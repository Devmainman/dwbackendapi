// utils/initBasicPackage.js
import Package from '../models/Package.js';
import Setting from '../models/Setting.js';

export const getOrCreateBasicPackage = async () => {
  let basic = await Package.findOne({ name: 'Basic' });

  if (!basic) {
    const setting = await Setting.findOne().lean();
    // REMOVED: defaultCurrency fetch (no longer needed in package)
    const defaultThreshold = setting?.defaultThreshold || 0;

    const rawSignal = setting?.signalStrengthLimit;
    const requiredSignal = parseFloat(rawSignal);
    const isValidSignal = !isNaN(requiredSignal) && requiredSignal >= 0;

    basic = await Package.create({
      name: 'Basic',
      // REMOVED: currency field
      amount: 0,
      threshold: defaultThreshold,
      requiredSignal: 100,
      benefits: ['Free access'],
      status: 'Active',
      icon: '',
    });
  }

  return basic;
};