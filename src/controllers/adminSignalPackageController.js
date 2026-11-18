import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import SignalPackage from '../models/SignalPackage.js';
import Setting from '../models/Setting.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// First number in free text: "20 +" -> 20, "$1,500" -> 1500, "80%" -> 80.
const numberIn = (v) => {
  const m = String(v ?? '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : NaN;
};

/**
 * Read a signal package from the admin form. Admins may type text like "20 +"
 * for strength or "$150" for price: the number is used for logic, and the text
 * as typed is kept as a display label so users see exactly what the admin wrote.
 */
const readPackage = (body, { partial = false } = {}) => {
  const errors = [];
  const data = {};
  if (!partial || body.name !== undefined) {
    data.name = String(body.name || '').trim();
    if (!data.name) errors.push('Name is required');
  }
  if (!partial || body.strength !== undefined) {
    const raw = String(body.strength ?? '').trim();
    const n = numberIn(raw);
    if (!Number.isFinite(n) || n < 0 || n > 100) errors.push('Signal strength must contain a number from 0 to 100 (for example "20" or "20 +")');
    else {
      data.strength = n;
      data.strengthLabel = raw && raw !== String(n) ? raw : '';
    }
  }
  if (!partial || body.amount !== undefined) {
    const raw = String(body.amount ?? '').trim();
    const n = numberIn(raw);
    if (!Number.isFinite(n) || n <= 0) errors.push('Price must contain a number above 0');
    else data.amount = n;
  }
  if (body.benefits !== undefined) {
    let list = body.benefits;
    if (typeof list === 'string') {
      try { list = JSON.parse(list); } catch { list = list.split('\n'); }
    }
    data.benefits = (Array.isArray(list) ? list : [list]).map((b) => String(b ?? '').trim()).filter(Boolean);
  }
  if (body.active !== undefined) data.active = body.active === true || body.active === 'true';
  return { errors, data };
};

// Optional icon upload (goes to Blob storage on Vercel through the upload middleware).
const saveIcon = async (file) => {
  if (!file) return null;
  const name = `${uuidv4()}${path.extname(file.name || '') || '.png'}`;
  await file.mv(path.join(__dirname, '../uploads/signal-icons', name));
  return `/uploads/signal-icons/${name}`;
};

const withCurrency = async (doc) => {
  const setting = await Setting.findOne().lean();
  return { ...(doc.toObject ? doc.toObject() : doc), currency: setting?.defaultCurrency || 'USD' };
};

/* ==========================================
   CREATE SIGNAL PACKAGE (ADMIN)
   ========================================== */
export const createSignalPackage = async (req, res) => {
  try {
    const { errors, data } = readPackage(req.body);
    if (errors.length) return res.status(400).json({ success: false, message: errors.join('. ') });
    const icon = await saveIcon(req.files?.icon);
    if (icon) data.icon = icon;
    const pkg = await SignalPackage.create(data);
    res.json({ success: true, message: 'Signal package created successfully', package: await withCurrency(pkg) });
  } catch (err) {
    console.error('Create signal package error:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error creating signal package' });
  }
};

/* ==========================================
   GET ALL SIGNAL PACKAGES (ADMIN)
   ========================================== */
export const getAllSignalPackages = async (req, res) => {
  try {
    const packages = await SignalPackage.find()
      .sort({ createdAt: -1 });

    // Get currency from settings
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
    const { errors, data } = readPackage(req.body, { partial: true });
    if (errors.length) return res.status(400).json({ success: false, message: errors.join('. ') });
    const icon = await saveIcon(req.files?.icon);
    if (icon) data.icon = icon;
    const updated = await SignalPackage.findByIdAndUpdate(req.params.id, { $set: data }, { new: true, runValidators: true });
    if (!updated) return res.status(404).json({ success: false, message: 'Signal package not found' });
    res.json({ success: true, message: 'Signal package updated', package: await withCurrency(updated) });
  } catch (err) {
    console.error('Update signal package error:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error updating signal package' });
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
