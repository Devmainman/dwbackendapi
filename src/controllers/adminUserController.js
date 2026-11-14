import { notifyUser } from '../services/notificationService.js';
import { escapeRegex } from '../utils/validation.js';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Message from '../models/Message.js'; 
import Transaction from '../models/Transaction.js';
import Assignment from '../models/Assignment.js';
import Package from '../models/Package.js';
import Setting from '../models/Setting.js';
import jwt from 'jsonwebtoken';
import Currency from '../models/Currency.js';
import { switchUserCurrency, withTransaction, creditUser, debitUser, recordTransaction } from '../utils/wallet.js';
import { sendNotification } from '../services/realtime.js';
import { activeConnections } from '../services/realtime.js';


const transformUserForFrontend = (user) => {
    if (!user) return null;

    const formatPhone = (phone) => {
        if (!phone || phone.trim() === '') return 'Not set';
        const cleaned = phone.replace(/\D/g, '');
        if (cleaned.startsWith('234') && cleaned.length === 12) {
            return `+${cleaned.substring(0, 3)} ${cleaned.substring(3, 6)} ${cleaned.substring(6, 9)} ${cleaned.substring(9)}`;
        }
        if (cleaned.startsWith('0') && cleaned.length === 11) {
            return `+234 ${cleaned.substring(1, 4)} ${cleaned.substring(4, 7)} ${cleaned.substring(7)}`;
        }
        return phone;
    };

    return {
        _id: user._id,
        accountId: user.accountId,
        email: user.email,
        fullName: [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Not set',
        country: user.country || user.address?.country || 'Not set',
        currency: user.currency,
        accountType: user.accountType || 'Basic',
        accountTypeName: user.accountType?.name || 'Basic',
        walletBalance: typeof user.balance === 'number' ? user.balance : 0,
        mobile: formatPhone(user.mobile),
        status: user.status || 'Active',
        joinedDate: user.joinedDate,
        firstName: user.firstName,
        lastName: user.lastName,
        address: user.address,
        verification: user.verification,
        _rawMobile: (user.mobile || user.phoneNumber || '').replace(/\D/g, ''),
        tradingEnabled: user.tradingEnabled || false,
        tradingSignal: user.tradingSignal || 'hold',
        tradingSignalUpdatedAt: user.tradingSignalUpdatedAt,
        withdrawalLocked: user.withdrawalLocked || false,
        messages: user.messages || [],
        lastLogin: user.lastLogin || null,
        signalStrength: user.tradingSignalStrength ?? 0,
        blockReason: user.blockReason || '',
        gender: user.gender || '',
        isOnline: activeConnections.has(user._id.toString())
    };
};


// Only profile fields can be edited here; money, status, passwords and
// verification have their own audited endpoints.
const EDITABLE = ['firstName', 'lastName', 'email', 'mobile', 'phoneNumber', 'country', 'gender', 'address', 'currency', 'dateOfBirth'];
const transformRequestToDB = (data = {}) => {
    const transformed = Object.fromEntries(Object.entries(data).filter(([k]) => EDITABLE.includes(k)));
    for (const k of ['firstName', 'lastName', 'country', 'gender']) {
        if (typeof transformed[k] === 'string') transformed[k] = transformed[k].trim().slice(0, 80);
        else if (k in transformed && transformed[k] != null) delete transformed[k];
    }
    if (transformed.email !== undefined) {
        const email = String(transformed.email).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            const e = new Error('Enter a valid email address');
            e.status = 400;
            throw e;
        }
        transformed.email = email;
    }
    
    const phoneValue = data.phoneNumber ?? data.mobile;
    
    if (phoneValue !== undefined) {
        const cleaned = phoneValue.replace(/\D/g, '');
    
        if (!cleaned) {
            delete transformed.mobile;
        } else if (cleaned.length === 11 && cleaned.startsWith('0')) {
            transformed.mobile = '+234' + cleaned.slice(1);
        } else if (cleaned.length >= 7 && cleaned.length <= 15) {
            transformed.mobile = '+' + cleaned;
        } else {
            const e = new Error('Phone number must have 7 to 15 digits');
            e.status = 400;
            throw e;
        }
    }
    
    delete transformed.phoneNumber;
    delete transformed._rawMobile;
    delete transformed.balance; // Prevent overwriting balance during user update
    
    return transformed;
};

// adminUserController.js
export const getSimpleUserList = async (req, res) => {
    try {
      const users = await User.find({}, 'firstName lastName accountId email');
  
      const formattedUsers = users.map(user => ({
        _id: user._id,
        accountId: user.accountId,
        email: user.email,
        fullName: `${user.firstName || ''} ${user.lastName || ''}`.trim()
      }));
  
      res.json({ success: true, users: formattedUsers });
    } catch (error) {
      console.error('Error fetching user list:', error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  };
  
export const getUsers = async (req, res) => {
    try {
        const { search = '', status, page = 1, limit = 10 } = req.query;
        
        const query = {};
        
        if (search) {
            query.$or = [
                { firstName: { $regex: escapeRegex(search), $options: 'i' } },
                { lastName: { $regex: escapeRegex(search), $options: 'i' } },
                { email: { $regex: escapeRegex(search), $options: 'i' } },
                { accountId: { $regex: escapeRegex(search), $options: 'i' } },
                { mobile: { $regex: escapeRegex(search), $options: 'i' } }
            ];
        }
        
        if (status) {
            query.status = status;
        }
        
        const users = await User.find(query)
            .select('firstName lastName email mobile country currency accountId accountType balance status joinedDate address verification tradingEnabled tradingSignal tradingSignalUpdatedAt withdrawalLocked messages lastLogin createdAt blockReason gender tradingSignalStrength') // CHANGED: walletBalance → balance
            .populate('accountType')
            .skip((Math.max(1, parseInt(page, 10) || 1) - 1) * Math.min(100, Math.max(1, parseInt(limit, 10) || 10)))
            .limit(Math.min(100, Math.max(1, parseInt(limit, 10) || 10)))
            .sort({ joinedDate: -1 });
        
        const total = await User.countDocuments(query);
        
        res.json({
            success: true,
            users: users.map(transformUserForFrontend),
            total,
            page: Number(page),
            pages: Math.ceil(total / Math.min(100, Math.max(1, parseInt(limit, 10) || 10)))
        });
    } catch (err) {
        console.error('Admin getUsers error:', err);
        res.status(500).json({ 
            success: false,
            message: 'Server error fetching users' 
        });
    }
};

export const getUser = async (req, res) => {
    try {
        const user = await User.findById(req.params.id)
  .select('firstName lastName email mobile country currency accountId accountType balance status joinedDate address verification tradingEnabled tradingSignal tradingSignalUpdatedAt withdrawalLocked messages lastLogin createdAt blockReason gender tradingSignalStrength')
  .populate('accountType');


        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }
        
        res.json({
            success: true,
            user: transformUserForFrontend(user)
        });
    } catch (err) {
        console.error('Admin getUser error:', err);
        res.status(500).json({ 
            success: false,
            message: 'Server error fetching user' 
        });
    }
};

export const updateUser = async (req, res) => {
    try {
        const { id } = req.params;
        
        const updates = transformRequestToDB(req.body);
        const currentUser = await User.findById(id);


        if ('balance' in req.body) {
            console.warn('[SECURITY] Attempt to update balance via profile update blocked.');
            delete req.body.balance;
          }
          
        if (!currentUser) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        if (updates.mobile !== undefined) {
            if (updates.mobile === '' || updates.mobile === 'Not set') {
                updates.mobile = '';
                updates.verification = {
                    ...currentUser.verification,
                    phoneVerified: false
                };
            }
            else if (updates.mobile !== currentUser.mobile) {
                updates.verification = {
                    ...currentUser.verification,
                    phoneVerified: false
                };
            }
        }

        if (updates.currency) {
            const currencyExists = await Currency.exists({ 
                code: updates.currency, 
                status: 'Enabled' 
            });
            
            if (!currencyExists) {
                const enabledCurrencies = await Currency.find({ status: 'Enabled' }).select('code');
                const validCurrencyCodes = enabledCurrencies.map(c => c.code);
                
                return res.status(400).json({
                    success: false,
                    message: `Invalid currency. Must be one of: ${validCurrencyCodes.join(', ')}`
                });
            }
        }
        
        // Currency changes go through the converter so the balance follows the currency.
        const newCurrency = updates.currency ? String(updates.currency).toUpperCase() : null;
        delete updates.currency;
        delete updates.balance;
        if (newCurrency && newCurrency !== currentUser.currency) {
            await switchUserCurrency(id, newCurrency, { by: 'admin' });
        }

        const user = await User.findByIdAndUpdate(
            id, 
            updates, 
            {
                new: true,
                runValidators: true,
                context: 'query'
            }
        ).select('-password -__v -verification.identityDocuments -verification.proofOfAddress');
        
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }
        
        res.json({
            success: true,
            user: transformUserForFrontend(user),
            message: updates.mobile !== undefined && updates.mobile !== currentUser.mobile
                ? 'Mobile number updated. Verification required.'
                : 'User updated successfully'
        });
    } catch (err) {
        console.error('Admin updateUser error:', err);
        
        if (err.name === 'ValidationError') {
            const errors = {};
            Object.keys(err.errors).forEach(key => {
                errors[key] = err.errors[key].message;
            });
            
            return res.status(400).json({ 
                success: false,
                message: 'Validation error',
                errors
            });
        }
        
        if (err.code === 11000) {
            const field = Object.keys(err.keyPattern || err.keyValue || {})[0] || 'value';
            return res.status(400).json({
                success: false,
                message: field === 'email' ? 'That email is already used by another account' : `That ${field} is already in use`
            });
        }

        if (err.status && err.status < 500) {
            return res.status(err.status).json({ success: false, message: err.message });
        }

        res.status(500).json({
            success: false,
            message: 'Server error updating user',
            error: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    }
};
 

export const deleteUser = async (req, res) => {
    try {
        const user = await User.findByIdAndDelete(req.params.id);
        
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }
        
        res.json({
            success: true,
            message: 'User deleted successfully'
        });
    } catch (err) {
        console.error('Admin deleteUser error:', err);
        res.status(500).json({ 
            success: false,
            message: 'Server error deleting user' 
        });
    }
};

export const toggleUserStatus = async (req, res) => {
    try {
      const user = await User.findById(req.params.id);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found',
        });
      }
  
      const newStatus = user.status === 'Active' ? 'Inactive' : 'Active';
      user.status = newStatus;
  
      if (newStatus === 'Inactive') {
        user.blockReason = req.body.reason || 'No reason provided';
      } else {
        user.blockReason = undefined; // Clear reason on unblock
      }
  
      await user.save();
  
      res.json({
        success: true,
        user: transformUserForFrontend(user),
      });
    } catch (err) {
      console.error('Admin toggleUserStatus error:', err);
      res.status(500).json({
        success: false,
        message: 'Server error toggling user status',
      });
    }
  };
  

export const updateWalletBalance = async (req, res) => {
    try {
      const { id } = req.params;
      const { amount, type, notes } = req.body || {};
      const parsedAmount = Math.round(Number(amount) * 100) / 100;
      if (!['credit', 'debit'].includes(type)) {
        return res.status(400).json({ success: false, message: 'type must be credit or debit' });
      }
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0 || parsedAmount > 1e12) {
        return res.status(400).json({ success: false, message: 'Valid positive numeric amount is required' });
      }
      // Atomic: a debit can never take the balance below zero, even with concurrent requests.
      const updatedUser = await withTransaction(async (session) => {
        const u = type === 'credit'
          ? await creditUser(id, parsedAmount, { session })
          : await debitUser(id, parsedAmount, { session });
        await recordTransaction({
          userId: id, amount: parsedAmount, currency: u.currency,
          type: type === 'credit' ? 'admin_credit' : 'admin_debit',
          metadata: { note: String(notes || '').slice(0, 300), by: req.user?.id }, session, prefix: 'ADJ'
        });
        return u;
      });
      await notifyUser(id, {
        type: 'transaction',
        title: type === 'credit' ? 'Balance credited' : 'Balance debited',
        content: `${type === 'credit' ? '+' : '-'}${parsedAmount} ${updatedUser.currency}${notes ? ` · ${String(notes).slice(0, 120)}` : ''}`,
        link: '/transactionhistory'
      });
      res.json({ success: true, user: transformUserForFrontend(updatedUser), newBalance: updatedUser.balance });
    } catch (err) {
      const status = err.status && err.status < 500 ? err.status : 500;
      if (status === 500) console.error('Admin updateWalletBalance error:', err);
      res.status(status).json({ success: false, message: status === 500 ? 'Server error updating wallet balance' : err.message });
    }
  };

export const resetUserPassword = async (req, res) => {
    try {
        const { newPassword, confirmPassword } = req.body;
        const user = await User.findById(req.params.id);
        
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        if (!newPassword || !confirmPassword) {
            return res.status(400).json({
                success: false,
                message: 'Both new password and confirmation are required'
            });
        }

        if (String(newPassword).length < 8) {
            return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
        }

        if (newPassword !== confirmPassword) {
            return res.status(400).json({
                success: false,
                message: 'Passwords do not match'
            });
        }

        // Set new password
        user.password = newPassword;
        await user.save();
        
        res.json({
            success: true,
            message: 'Password reset successfully'
        });
    } catch (err) {
        console.error('Admin resetUserPassword error:', err);
        res.status(500).json({ 
            success: false,
            message: 'Server error resetting password',
            error: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    }
};

export const toggleWithdrawalLock = async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }
        
        user.withdrawalLocked = !user.withdrawalLocked;
        await user.save();
        
        res.json({
            success: true,
            user: transformUserForFrontend(user),
            message: `Withdrawals ${user.withdrawalLocked ? 'locked' : 'unlocked'} successfully`
        });
    } catch (err) {
        console.error('Admin toggleWithdrawalLock error:', err);
        res.status(500).json({ 
            success: false,
            message: 'Server error toggling withdrawal lock' 
        });
    }
};

export const generateAdminAccess = async (req, res) => {
    try {
        const { id } = req.params; // Changed from req.params.id to req.params.id
        console.log(`Generating admin access for user ID: ${id}`);
      
      // Fetch user
      const user = await User.findById(id);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
      
      // Fetch frontendURL from settings
      const settings = await Setting.findOne().select('frontendURL');
      let frontendURL = process.env.FRONTEND_URL || settings?.frontendURL || 'http://localhost:1200';
      if (/\/api(\/|$)/.test(frontendURL) && process.env.FRONTEND_URL) frontendURL = process.env.FRONTEND_URL;
      
      // Ensure frontendURL is a valid URL (basic validation)
      if (!frontendURL.startsWith('http://') && !frontendURL.startsWith('https://')) {
        console.warn(`Invalid frontendURL format: ${frontendURL}, using fallback`);
        frontendURL = 'http://localhost:1200';
      }
      
      // Remove trailing slash for consistency
      frontendURL = frontendURL.replace(/\/$/, '');
      
      // Generate admin access token
      const tempToken = jwt.sign(
        { userId: user._id, isAdminAccess: true },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
      );
      
      // Construct dashboard URL
      const dashboardUrl = `${frontendURL}/?adminAccessToken=${tempToken}`;
      
      res.json({
        success: true,
        token: tempToken,
        redirectUrl: dashboardUrl,
        message: 'Temporary admin access granted'
      });
    } catch (err) {
      console.error('Admin generateAdminAccess error:', err);
      
      if (err.name === 'JsonWebTokenError') {
        return res.status(500).json({ 
          success: false,
          message: 'JWT configuration error' 
        });
      }
      
      res.status(500).json({ 
        success: false,
        message: 'Server error generating admin access',
        error: err.message
      });
    }
  };

export const requestEmailVerification = async (req, res) => {
try {
    const user = await User.findById(req.params.id);

    if (!user) {
    return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (user.verification?.emailVerified) {
    return res.status(400).json({ success: false, message: 'Email is already verified' });
    }

    const verificationToken = jwt.sign(
    { userId: user._id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
    );

    user.verification.emailVerificationToken = verificationToken;
    user.verification.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await user.save();

    // Send notification
    sendNotification(user._id.toString(), {
    title: 'Email Verification Requested',
    message: 'Please verify your email address. A link has been generated.',
    type: 'verification',
    });

    const response = {
    success: true,
    message: 'Email verification requested'
    };

    if (process.env.NODE_ENV === 'development') {
    response.verificationLink = `${process.env.CLIENT_URL}/verify-email?token=${verificationToken}`;
    }

    res.json(response);
} catch (err) {
    console.error('Admin requestEmailVerification error:', err);
    res.status(500).json({ success: false, message: 'Server error requesting email verification' });
}
};
  

export const requestPhoneVerification = async (req, res) => {
    try {
      const user = await User.findById(req.params.id);
  
      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }
  
      if (!user.mobile) {
        return res.status(400).json({ success: false, message: 'User has no phone number set' });
      }
  
      if (user.verification?.phoneVerified) {
        return res.status(400).json({ success: false, message: 'Phone is already verified' });
      }
  
      const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
  
      user.verification.phoneVerificationCode = verificationCode;
      user.verification.phoneVerificationExpires = new Date(Date.now() + 10 * 60 * 1000);
      await user.save();
  
      // Send notification
      sendNotification(user._id.toString(), {
        title: 'Phone Verification Requested',
        message: 'A phone verification code has been generated.',
        type: 'verification',
      });
  
      const response = {
        success: true,
        message: 'Phone verification requested'
      };
  
      if (process.env.NODE_ENV === 'development') {
        response.verificationCode = verificationCode;
      }
  
      res.json(response);
    } catch (err) {
      console.error('Admin requestPhoneVerification error:', err);
      res.status(500).json({ success: false, message: 'Server error requesting phone verification' });
    }
  };
  
  

export const changeUserCurrency = async (req, res) => {
    try {
        const { currency: newCurrencyCode } = req.body;
        const userId = req.params.id;

        // 1. Fetch user and validate
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // 2. Validate new currency exists and is enabled
        const newCurrency = await Currency.findOne({ 
            code: newCurrencyCode, 
            status: 'Enabled' 
        });
        
        if (!newCurrency) {
            return res.status(400).json({
                success: false,
                message: 'Invalid or disabled currency'
            });
        }

        // 3. Check if currency is actually changing
        if (user.currency === newCurrencyCode) {
            return res.status(400).json({
                success: false,
                message: 'User already has this currency'
            });
        }

        // 4. Convert atomically at today's rate (and log it)
        const r = await switchUserCurrency(userId, newCurrencyCode, { by: 'admin' });
        res.json({
            success: true,
            user: transformUserForFrontend(r.user),
            conversion: { oldAmount: r.oldBalance, oldCurrency: r.from, newAmount: r.newBalance, newCurrency: r.to, rate: r.rate },
            message: `Currency changed from ${r.from} to ${r.to}`
        });

    } catch (err) {
        console.error('Admin changeUserCurrency error:', err);
        res.status(500).json({ 
            success: false,
            message: 'Server error changing currency',
            error: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    }
};

export const deleteUserAccount = async (req, res) => {
    try {
        const { confirmation } = req.body;
        
        if (confirmation !== 'DELETE') {
            return res.status(400).json({
                success: false,
                message: 'Confirmation text "DELETE" is required'
            });
        }
        
        const user = await User.findByIdAndDelete(req.params.id);
        
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }
        
        res.json({
            success: true,
            message: 'User account permanently deleted'
        });
    } catch (err) {
        console.error('Admin deleteUserAccount error:', err);
        res.status(500).json({ 
            success: false,
            message: 'Server error deleting user account'
        });
    }
};

export const assignBotToUser = async (req, res) => {
    try {
        const { botId } = req.body;
        const user = await User.findById(req.params.id);
        
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }
        
        if (!botId || !/^[a-f\d]{24}$/i.test(botId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid bot ID'
            });
        }
        
        const existingAssignment = await Assignment.findOne({
            userId: user._id,
            itemId: botId,
            type: 'bot_assignment'
        });
        
        if (existingAssignment) {
            return res.status(400).json({
                success: false,
                message: 'This bot is already assigned to the user'
            });
        }
        
        const assignment = new Assignment({
            userId: user._id,
            adminId: req.user.id,
            type: 'bot_assignment',
            itemId: botId,
            status: 'active',
            metadata: {
                assignedAt: new Date(),
                notes: 'Trading bot assigned by admin'
            }
        });
        
        await assignment.save();
        
        res.json({
            success: true,
            user: transformUserForFrontend(user),
            assignment,
            message: 'Bot assigned successfully'
        });
    } catch (err) {
        console.error('Admin assignBotToUser error:', err);
        res.status(500).json({ 
            success: false,
            message: 'Server error assigning bot' 
        });
    }
};

export const toggleTradeStatus = async (req, res) => {
    try {
      const user = await User.findById(req.params.id);
      
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
      
      user.tradingEnabled = !user.tradingEnabled;
      await user.save();
      
      res.json({
        success: true,
        user: transformUserForFrontend(user),
        message: `Trading ${user.tradingEnabled ? 'enabled' : 'disabled'} successfully`
      });
    } catch (err) {
      console.error('Admin toggleTradeStatus error:', err);
      res.status(500).json({ 
        success: false,
        message: 'Server error toggling trade status' 
      });
    }
  };

  export const updateUserSignal = async (req, res) => {
    try {
        const { strength } = req.body;
        const user = await User.findById(req.params.id);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        const parsedStrength = parseInt(strength);
        if (isNaN(parsedStrength) || parsedStrength < 0 || parsedStrength > 100) {
            return res.status(400).json({
                success: false,
                message: 'Signal strength must be a number between 0 and 100'
            });
        }

        user.tradingSignalStrength = parsedStrength;
        user.tradingSignalUpdatedAt = new Date();
        await user.save();

        res.json({
            success: true,
            user: transformUserForFrontend(user),
            message: `Signal strength updated to ${parsedStrength}% successfully`
        });
    } catch (err) {
        console.error('Admin updateUserSignal error:', err);
        res.status(500).json({ 
            success: false,
            message: 'Server error updating signal strength' 
        });
    }
};






export const sendMessageToUser = async (req, res) => {
    try {
        const { subject, message, sendEmail } = req.body;
        const user = await User.findById(req.params.id);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        if (!subject || !message) {
            return res.status(400).json({
                success: false,
                message: 'Subject and message are required'
            });
        }

        // Create and save to Message model
        const newMessage = new Message({
            sender: req.user.id,
            recipient: user._id,
            subject,
            content: message,
            status: 'sent',
            isSystemMessage: true
        });

        await newMessage.save();

        // Optional: you may skip pushing into user.messages[] if using Message model consistently
        // user.messages.push(...); // This is redundant unless you're using it elsewhere

        // In-app notification (stored + pushed live over the WebSocket).
        await notifyUser(user._id, {
            type: 'message',
            title: subject,
            content: message,
            link: '/notification',
            metadata: {
                from: 'admin',
                method: sendEmail ? 'email+inApp' : 'inApp',
                adminId: req.user.id,
                messageId: newMessage._id
            }
        });

        // Send email if selected
        if (sendEmail) {
            await sendEmailToUser(user.email, subject, message);
        }

        res.json({
            success: true,
            message: 'Message sent, saved, and delivered'
        });
    } catch (err) {
        console.error('Admin sendMessageToUser error:', err);
        res.status(500).json({
            success: false,
            message: 'Server error sending message'
        });
    }
};

export const verifyEmail = async (req, res) => {
    try {
      const user = await User.findById(req.params.id);
  
      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }
  
      if (user.verification?.emailVerified) {
        return res.status(400).json({ success: false, message: 'Email is already verified' });
      }
  
      user.verification.emailVerified = true;
      user.verification.emailVerificationToken = undefined;
      user.verification.emailVerificationExpires = undefined;
      await user.save();
  
      // Send notification
      sendNotification(user._id.toString(), {
        title: 'Email Verified',
        message: 'Your email has been verified by the admin.',
        type: 'success',
      });
  
      res.json({ success: true, message: 'Email marked as verified successfully' });
    } catch (err) {
      console.error('Admin verifyEmail error:', err);
      res.status(500).json({ success: false, message: 'Server error verifying email' });
    }
  };
  
  
  
export const verifyPhoneNumber = async (req, res) => {
try {
    const user = await User.findById(req.params.id);

    if (!user) {
    return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (user.verification?.phoneVerified) {
    return res.status(400).json({ success: false, message: 'Phone number is already verified' });
    }

    user.verification.phoneVerified = true;
    user.verification.phoneVerificationCode = undefined;
    user.verification.phoneVerificationExpires = undefined;
    await user.save();

    // Send notification
    sendNotification(user._id.toString(), {
    title: 'Phone Verified',
    message: 'Your phone number has been verified by the admin.',
    type: 'success',
    });

    res.json({ success: true, message: 'Phone number marked as verified successfully' });
} catch (err) {
    console.error('Admin verifyPhoneNumber error:', err);
    res.status(500).json({ success: false, message: 'Server error verifying phone number' });
}
};
  
  
  

  