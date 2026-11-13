import express from 'express';
import { getPublicSignalPackages } from '../controllers/publicSignalPackageController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();


router.get('/signal-packages', authenticate, getPublicSignalPackages);

export default router;
