import Package from '../models/Package.js';
import Setting from '../models/Setting.js';
import Currency from '../models/Currency.js';
import { getOrCreateBasicPackage } from '../utils/initBasicPackage.js';
import UpgradeInvoice from '../models/UpgradeInvoice.js';
import User from '../models/User.js';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

// Configure __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const handleIconUpload = (req) => {
  if (!req.files || !req.files.icon) return '';
  
  const icon = req.files.icon;
  const uploadPath = path.join(__dirname, '../uploads/icons', icon.name);
  
  // Create the icons directory if it doesn't exist
  if (!fs.existsSync(path.join(__dirname, '../uploads/icons'))) {
    fs.mkdirSync(path.join(__dirname, '../uploads/icons'), { recursive: true });
  }

  // Move the file to the uploads directory
  icon.mv(uploadPath, (err) => {
    if (err) {
      console.error('File upload error:', err);
      return '';
    }
  });
  
  return `/uploads/icons/${icon.name}`;
};

// Helper to get default currency from settings
export const getDefaultCurrency = async () => {
  try {
    const setting = await Setting.findOne().lean();
    if (!setting?.defaultCurrency) {
      console.warn('Default currency not set in settings, using USD as fallback');
      return 'USD';
    }
    return setting.defaultCurrency;
  } catch (error) {
    console.error('Error fetching default currency:', error);
    return 'USD';
  }
};

export const createPackage = async (req, res) => {
  try {
    const { 
      name, 
      amount, 
      status, 
      benefits, 
      threshold, 
      requiredSignal 
    } = req.body;

    // Basic validation
    if (!name || !amount || !benefits) {
      return res.status(400).json({ 
        success: false,
        message: 'Name, amount, and benefits are required' 
      });
    }

    // Handle file upload
    let iconPath = '';
    if (req.files?.icon) {
      const icon = req.files.icon;
      
      // Ensure the uploads directory exists
      const uploadDir = path.join(__dirname, '../uploads/icons');
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }

      // Create unique filename
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      const filename = `icon-${uniqueSuffix}${path.extname(icon.name)}`;
      const uploadPath = path.join(uploadDir, filename);
      
      await icon.mv(uploadPath);
      iconPath = `/uploads/icons/${filename}`;
    }

    // Parse benefits if it's a string (from FormData)
    const parsedBenefits = typeof benefits === 'string' 
      ? JSON.parse(benefits) 
      : benefits;

    const newPackage = new Package({
      name,
      icon: iconPath,
      // NO currency field - will use settings' default currency
      amount: parseFloat(amount),
      status: status || 'Active',
      benefits: Array.isArray(parsedBenefits) 
        ? parsedBenefits.filter(b => b.trim() !== '') 
        : [],
      threshold: threshold ? parseFloat(threshold) : undefined,
      requiredSignal: requiredSignal ? parseFloat(requiredSignal) : undefined
    });

    await newPackage.save();

    res.status(201).json({
      success: true,
      package: newPackage
    });
  } catch (err) {
    console.error('Create Package Error:', err);
    res.status(500).json({ 
      success: false,
      message: err.message || 'Server error creating package' 
    });
  }
};

// Get all packages
export const getPackages = async (req, res) => {
  try {
    const packages = await Package.find().sort({ amount: 1 }).lean();
    
    // Get default currency from settings
    const defaultCurrency = await getDefaultCurrency();

    // Ensure Basic package is always included
    const basic = await getOrCreateBasicPackage();
    const exists = packages.some(p => p._id.toString() === basic._id.toString());
    if (!exists) packages.unshift(basic); // add at the top

    // Add currency info to each package
    const packagesWithCurrency = packages.map(pkg => ({
      ...pkg,
      currency: defaultCurrency
    }));

    res.json({
      success: true,
      packages: packagesWithCurrency,
      count: packages.length,
      currency: defaultCurrency
    });
  } catch (err) {
    console.error('Get Packages Error:', err);
    res.status(500).json({ success: false, message: 'Server error fetching packages' });
  }
};

export const getUserPackages = async (req, res) => {
  try {
    const userId = req.user?.id || req.query.userId;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID required' });
    }

    const user = await User.findById(userId).lean();
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Get default currency from settings
    const defaultCurrency = await getDefaultCurrency();
    
    // Check if user's currency is different from default
    const userCurrencyCode = user.currency || defaultCurrency;
    
    const userCurrency = await Currency.findOne({ code: userCurrencyCode });
    if (!userCurrency) {
      return res.status(400).json({ 
        success: false, 
        message: 'Currency not supported' 
      });
    }

    // Fetch only active packages excluding "Basic"
    let packages = await Package.find({
      status: 'Active',
      name: { $ne: 'Basic' }  // exclude Basic
    }).sort({ amount: 1 }).lean();

    // Remove user's current package
    const userAccountTypeId = user.accountType?.toString();
    packages = packages.filter(pkg => pkg._id.toString() !== userAccountTypeId);

    // What the plans page needs to explain itself: the user's signal strength and
    // which plans already have a payment under review.
    const userSignal = Number(user.tradingSignalStrength || 0);
    const pendingIds = new Set(
      (await UpgradeInvoice.find({ user: user._id, status: { $in: ['pending', 'disputed'] } }).select('package').lean())
        .map((i) => String(i.package))
    );
    packages = packages.map((pkg) => ({
      ...pkg,
      requiredSignal: Number(pkg.requiredSignal || 0),
      paymentPending: pendingIds.has(String(pkg._id))
    }));

    // If user currency is same as default, no conversion needed
    if (userCurrencyCode === defaultCurrency) {
      const packagesWithCurrency = packages.map(pkg => ({
        ...pkg,
        currency: defaultCurrency
      }));

      return res.json({
        success: true,
        userSignal,
        packages: packagesWithCurrency
      });
    }

    // Convert to user's currency
    const currencyRates = await Currency.find({});
    const rateMap = {};
    currencyRates.forEach(c => { rateMap[c.code] = c.rate });

    const defaultRate = rateMap[defaultCurrency] || 1;
    const targetRate = userCurrency.rate;

    const convert = (val) =>
      defaultRate && targetRate ? (val * targetRate) / defaultRate : val;

    const convertedPackages = packages.map(pkg => {
      const convertedAmount = convert(pkg.amount);
      const convertedThreshold = pkg.threshold ? convert(pkg.threshold) : undefined;

      return {
        ...pkg,
        originalAmount: pkg.amount,
        originalCurrency: defaultCurrency,
        amount: parseFloat(convertedAmount.toFixed(2)),
        threshold: convertedThreshold ? parseFloat(convertedThreshold.toFixed(2)) : undefined,
        currency: userCurrency.code
      };
    });

    res.json({
      success: true,
      userSignal,
      packages: convertedPackages
    });
  } catch (err) {
    console.error('Get User Packages Error:', err);
    res.status(500).json({ success: false, message: 'Server error fetching packages' });
  }
};

// Update a package
export const updatePackage = async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      name, 
      amount, 
      status, 
      benefits, 
      threshold, 
      requiredSignal 
    } = req.body;

    // Basic validation
    if (!name || !amount || !benefits) {
      return res.status(400).json({ 
        success: false,
        message: 'Name, amount, and benefits are required' 
      });
    }

    // Handle file upload if new icon provided
    let iconPath;
    if (req.files?.icon) {
      const icon = req.files.icon;
      
      // Ensure the uploads directory exists
      const uploadDir = path.join(__dirname, '../uploads/icons');
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }

      // Create unique filename
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      const filename = `icon-${uniqueSuffix}${path.extname(icon.name)}`;
      const uploadPath = path.join(uploadDir, filename);
      
      await icon.mv(uploadPath);
      iconPath = `/uploads/icons/${filename}`;
    }

    // Parse benefits if it's a string (from FormData)
    const parsedBenefits = typeof benefits === 'string' 
      ? JSON.parse(benefits) 
      : benefits;

    const updateData = {
      name,
      // NO currency field - will use settings' default currency
      amount: parseFloat(amount),
      status: status || 'Active',
      benefits: Array.isArray(parsedBenefits) 
        ? parsedBenefits.filter(b => b.trim() !== '') 
        : [],
      threshold: threshold ? parseFloat(threshold) : undefined,
      requiredSignal: requiredSignal ? parseFloat(requiredSignal) : undefined,
      updatedAt: Date.now()
    };

    // Only update icon if a new one was uploaded
    if (iconPath) {
      updateData.icon = iconPath;
    }

    const updatedPackage = await Package.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    );

    if (!updatedPackage) {
      return res.status(404).json({ 
        success: false,
        message: 'Package not found' 
      });
    }

    // Get default currency from settings to include in response
    const defaultCurrency = await getDefaultCurrency();

    res.json({
      success: true,
      package: {
        ...updatedPackage.toObject(),
        currency: defaultCurrency
      }
    });
  } catch (err) {
    console.error('Update Package Error:', err);
    res.status(500).json({ 
      success: false,
      message: err.message || 'Server error updating package' 
    });
  }
};

// Delete a package
export const deletePackage = async (req, res) => {
  try {
    const { id } = req.params;

    const deletedPackage = await Package.findByIdAndDelete(id);

    if (!deletedPackage) {
      return res.status(404).json({ 
        success: false,
        message: 'Package not found' 
      });
    }

    res.json({
      success: true,
      message: 'Package deleted successfully'
    });
  } catch (err) {
    console.error('Delete Package Error:', err);
    res.status(500).json({ 
      success: false,
      message: 'Server error deleting package' 
    });
  }
};

// Toggle package status
export const togglePackageStatus = async (req, res) => {
  try {
    const { id } = req.params;

    const pkg = await Package.findById(id);
    if (!pkg) {
      return res.status(404).json({ 
        success: false,
        message: 'Package not found' 
      });
    }

    pkg.status = pkg.status === 'Active' ? 'Inactive' : 'Active';
    await pkg.save();

    // Get default currency from settings to include in response
    const defaultCurrency = await getDefaultCurrency();

    res.json({
      success: true,
      package: {
        ...pkg.toObject(),
        currency: defaultCurrency
      }
    });
  } catch (err) {
    console.error('Toggle Package Status Error:', err);
    res.status(500).json({ 
      success: false,
      message: 'Server error toggling package status' 
    });
  }
};

export const getPackagesWithStats = async (req, res) => {
  try {
    const packages = await Package.aggregate([
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: 'packageId',
          as: 'users'
        }
      },
      {
        $addFields: {
          userCount: { $size: '$users' }
        }
      },
      {
        $project: {
          users: 0
        }
      },
      { $sort: { amount: 1 } }
    ]);

    // Get default currency from settings
    const defaultCurrency = await getDefaultCurrency();

    // Add currency info to each package
    const packagesWithCurrency = packages.map(pkg => ({
      ...pkg,
      currency: defaultCurrency
    }));

    res.json({
      success: true,
      packages: packagesWithCurrency,
      currency: defaultCurrency
    });
  } catch (err) {
    console.error('Get packages with stats error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error fetching package stats'
    });
  }
};

// Get users by package
export const getUsersByPackage = async (req, res) => {
  try {
    const { packageId } = req.params;
    const { page = 1, limit = 10 } = req.query;
    
    const users = await User.find({ packageId })
      .select('fullName email accountId status walletBalance joinedDate currency')
      .skip((page - 1) * limit)
      .limit(limit)
      .sort({ joinedDate: -1 });
    
    const total = await User.countDocuments({ packageId });
    
    res.json({
      success: true,
      users,
      total,
      page: Number(page),
      pages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error('Get users by package error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error fetching package users'
    });
  }
};
// Public: active account plans for the landing page (display fields only).
export const getPublicPlans = async (req, res) => {
  try {
    const packages = await Package.find({ status: 'Active' }).sort({ amount: 1 }).select('name amount benefits -_id').lean();
    const currency = await getDefaultCurrency();
    res.json({ success: true, currency, plans: packages });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Could not load plans' });
  }
};

/**
 * A plan's price in the user's own currency (same conversion the plans page shows).
 * Used to price upgrade payments on the server, so the browser can't change the amount.
 */
export const priceForUser = async (pkg, user) => {
  const defaultCurrency = await getDefaultCurrency();
  const code = user?.currency || defaultCurrency;
  if (code === defaultCurrency) return { amount: pkg.amount, currency: defaultCurrency };
  const [from, to] = await Promise.all([
    Currency.findOne({ code: defaultCurrency }).lean(),
    Currency.findOne({ code }).lean()
  ]);
  if (!to?.rate) return { amount: pkg.amount, currency: defaultCurrency };
  const fromRate = from?.rate || 1;
  return { amount: parseFloat(((pkg.amount * to.rate) / fromRate).toFixed(2)), currency: code };
};
