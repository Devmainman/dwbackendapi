import express from 'express';
import {
  createSignalPackage,
  getAllSignalPackages,
  updateSignalPackage,
  toggleSignalPackageStatus,
  deleteSignalPackage
} from '../controllers/adminSignalPackageController.js';

import { authenticate, isAdmin } from '../middleware/auth.js';

const router = express.Router();

/* 
   Apply admin protection exactly like your other admin routes
*/

router.use(authenticate);
router.use(isAdmin);

/* SIGNAL PACKAGE ADMIN ROUTES */

router.get('/', getAllSignalPackages);                 // list packages
router.post('/', createSignalPackage);                 // create package
router.put('/:id', updateSignalPackage);               // update package
router.patch('/:id/toggle', toggleSignalPackageStatus);// activate/deactivate
router.delete('/:id', deleteSignalPackage);            // delete package

export default router;
