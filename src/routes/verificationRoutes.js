import express from 'express';
import { 
  completeProfile,
  // verifyPhone,
  uploadIdDocument,
  uploadAddressProof,
  uploadFaceImage,
  verifyOtp,
  saveAddress,
  getCurrentUser,
  getVerificationStatus
} from '../controllers/verificationController.js';

import { authenticate } from '../middleware/auth.js';

const router = express.Router();

router.get('/verification-status', authenticate, getVerificationStatus);

// @route   POST /api/verification/profile
// @desc    Complete user profile
// @access  Private
router.post('/profile', authenticate, completeProfile);

// @route   POST /api/verification/phone
// @desc    Send phone verification OTP
// @access  Private
// router.post('/phone', authenticate, verifyPhone);

// @route   POST /api/verification/verify-otp
// @desc    Verify phone OTP
// @access  Private
router.post('/verify-otp', authenticate, verifyOtp);

// @route   POST /api/verification/id-document
// @desc    Upload ID document
// @access  Private
router.post('/id-document', authenticate, uploadIdDocument);

// @route   POST /api/verification/address-proof
// @desc    Upload address proof
// @access  Private
router.post('/address-proof', authenticate, uploadAddressProof);

// @route   POST /api/verification/face-image
// @desc    Upload face image
// @access  Private
router.post('/face-image', authenticate, uploadFaceImage);

router.post('/address', authenticate, saveAddress);

// Add with your other routes
router.get('/users', authenticate, getCurrentUser);

export default router;