import mongoose from 'mongoose';
import User from '../models/User.js';
import Package from '../models/Package.js';
import PackageUpgradeInteraction from '../models/PackageUpgradeInteraction.js'; // ⬅️ import this


export const assignPackage = async (req, res) => {
  try {
    console.log('🔥 assignPackage hit', req.params);
    const { userId, packageId } = req.params;

    const user = await User.findById(userId);
    const pkg = await Package.findById(packageId);

    if (!user || !pkg) {
      return res.status(404).json({
        success: false,
        message: 'User or package not found'
      });
    }

    // 🔥 Reset interaction so modal can show again
    await PackageUpgradeInteraction.findOneAndDelete({ userId });

    // 🔥 Clear previous pending package to force change
    user.pendingPackage = null;
    await user.save();

    // ✅ Assign new pending package
    user.pendingPackage = pkg._id;
    user.hasNewPendingPackage = true;
    await user.save();

    await user.populate('pendingPackage');

    res.json({
      success: true,
      message: 'Package assigned and pending user payment',
      user
    });
  } catch (err) {
    console.error('Admin assignPackage error:', err);
    res.status(500).json({ 
      success: false,
      message: 'Server error assigning package' 
    });
  }
};

export const unassignPackage = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Delete interaction to reset modal state
    await PackageUpgradeInteraction.findOneAndDelete({ userId });

    // Remove pending package assignment
    user.pendingPackage = null;
    user.hasNewPendingPackage = false;
    await user.save();

    res.json({
      success: true,
      message: 'Pending package unassigned successfully',
      user,
    });
  } catch (error) {
    console.error('❌ Error unassigning package:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};




export const editUserPackage = async (req, res) => {
  try {
    const { id } = req.params;
    const { packageId } = req.body;

    console.log('📦 Editing user package for user ID:', id, 'with packageId:', packageId);

    const user = await User.findById(id);
    if (!user) {
      console.log('❌ User not found');
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const pkg = await Package.findById(packageId);
    if (!pkg) {
      console.log('❌ Package not found');
      return res.status(404).json({ success: false, message: 'Package not found' });
    }

    console.log('🎯 Assigning accountType =', pkg._id, typeof pkg._id);
    user.accountType = pkg._id;
    console.log('👤 user.accountType before save:', user.accountType);

    const updated = await user.save({ validateBeforeSave: true }).catch(err => {
      console.error('❌ Save validation failed:', err);
      throw err;
    });

    console.log('✅ Saved user with accountType:', updated.accountType);

    const populatedUser = await User.findById(id).populate('accountType');
    console.log('✅ Populated User accountType name:', populatedUser.accountType?.name);

    res.json({
      success: true,
      message: 'User package updated successfully',
      user: populatedUser
    });

  } catch (error) {
    console.error('🔥 Error editing user package:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};



  