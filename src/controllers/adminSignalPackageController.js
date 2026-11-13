

import SignalPackage from '../models/SignalPackage.js';
import Setting from '../models/Setting.js';

/* ==========================================
   CREATE SIGNAL PACKAGE (ADMIN)
   ========================================== */
export const createSignalPackage = async (req, res) => {
  try {
    const {
  name,
  strength,
  amount,
  benefits,
  icon
} = req.body;

if (!name || strength === undefined || !amount) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }

    // 🔥 Fetch default currency from settings
    const setting = await Setting.findOne();
    const currency = setting?.defaultCurrency || 'USD';

    let benefitsParsed = benefits;

if (typeof benefits === 'string') {
  benefitsParsed = JSON.parse(benefits);
}


    const pkg = await SignalPackage.create({
      name,
      strength,
      amount,
      benefits: benefitsParsed,
      icon
    });


    res.json({
      success: true,
      message: 'Signal package created successfully',
      package: {
        ...pkg.toObject(),
        currency   // return currency dynamically
      }
    });

  } catch (err) {
    console.error('Create signal package error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error creating signal package'
    });
  }
};


/* ==========================================
   GET ALL SIGNAL PACKAGES (ADMIN)
   ========================================== */
export const getAllSignalPackages = async (req, res) => {
  try {
    const packages = await SignalPackage.find()
      .sort({ createdAt: -1 });

    // 🔥 Get currency from settings
    const setting = await Setting.findOne();
    const currency = setting?.defaultCurrency || 'USD';

    const enriched = packages.map(pkg => ({
      ...pkg.toObject(),
      currency
    }));

    res.json({
      success: true,
      packages: enriched
    });

  } catch (err) {
    console.error('Get admin signal packages error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error fetching signal packages'
    });
  }
};


/* ==========================================
   UPDATE SIGNAL PACKAGE
   ========================================== */
export const updateSignalPackage = async (req, res) => {
  try {
    const { id } = req.params;

    let { benefits } = req.body;

    let benefitsParsed = benefits;
    if (typeof benefits === 'string') {
      benefitsParsed = JSON.parse(benefits);
    }

    const updated = await SignalPackage.findByIdAndUpdate(
      id,
      {
        ...req.body,
        benefits: benefitsParsed   // 🔥 FIXED
      },
      { new: true }
    );


    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Signal package not found'
      });
    }

    // 🔥 Attach currency dynamically
    const setting = await Setting.findOne();
    const currency = setting?.defaultCurrency || 'USD';

    res.json({
      success: true,
      message: 'Signal package updated',
      package: {
        ...updated.toObject(),
        currency
      }
    });

  } catch (err) {
    console.error('Update signal package error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error updating signal package'
    });
  }
};


/* ==========================================
   TOGGLE ACTIVE / INACTIVE
   ========================================== */
export const toggleSignalPackageStatus = async (req, res) => {
  try {
    const { id } = req.params;

    const pkg = await SignalPackage.findById(id);

    if (!pkg) {
      return res.status(404).json({
        success: false,
        message: 'Signal package not found'
      });
    }

    pkg.active = !pkg.active;
    await pkg.save();

    res.json({
      success: true,
      message: `Signal package ${pkg.active ? 'activated' : 'deactivated'}`,
      active: pkg.active
    });

  } catch (err) {
    console.error('Toggle signal package error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error toggling status'
    });
  }
};


/* ==========================================
   DELETE SIGNAL PACKAGE
   ========================================== */
export const deleteSignalPackage = async (req, res) => {
  try {
    const { id } = req.params;

    const deleted = await SignalPackage.findByIdAndDelete(id);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Signal package not found'
      });
    }

    res.json({
      success: true,
      message: 'Signal package deleted'
    });

  } catch (err) {
    console.error('Delete signal package error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error deleting package'
    });
  }
};
