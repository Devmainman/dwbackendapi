// Crypto wallets: balances (fiat + every enabled coin at live prices), crypto deposits
// verified by the admin, and fiat <-> crypto conversion at live prices.
// The fiat balance (User.balance) and everything that uses it are unchanged; crypto
// only reaches it through a conversion.
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { CryptoAsset, CryptoWallet, CryptoDeposit, CryptoConversion } from '../models/Crypto.js';
import User from '../models/User.js';
import Setting from '../models/Setting.js';
import { asString } from '../utils/validation.js';
import { HttpError, withTransaction, debitUser, creditUser, recordTransaction } from '../utils/wallet.js';
import { handler, notify, paging } from '../services/productService.js';
import { ensureCryptoCatalog, getCryptoPrices, priceIn, cryptoSettings, getSparklines, getHistory } from '../services/cryptoMarket.js';
import { rateBetween } from '../services/fx.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const round2 = (n) => Math.round(n * 100) / 100;
const round8 = (n) => Math.round(n * 1e8) / 1e8;
const oid = (id) => { if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, 'Invalid id'); return id; };
const sym = (v) => asString(v, 12).toUpperCase();
const ref = (p) => `${p}-${uuidv4().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
const currencyName = (code) => {
  if (code === 'USD') return 'United States Dollar';
  try { return new Intl.DisplayNames(['en'], { type: 'currency' }).of(code) || code; } catch { return code; }
};
const fail503 = (err) => { if (err?.status === 503) throw new HttpError(503, err.message); throw err; };

/* ============================ User: wallets ============================ */

/**
 * GET /api/crypto/wallets
 * { enabled, convertEnabled, currency, fiat: {...}, assets: [...], totals: { fiat, crypto, total } }
 * Assets = every enabled coin (zero balances included) plus any coin the user still holds.
 */
export const userWallets = handler(async (req, res) => {
  await ensureCryptoCatalog();
  const [settings, user, assets, wallets, prices] = await Promise.all([
    cryptoSettings(),
    User.findById(req.user.id).select('balance currency').lean(),
    CryptoAsset.find().sort({ sortOrder: 1, symbol: 1 }).lean(),
    CryptoWallet.find({ user: req.user.id }).lean(),
    getCryptoPrices()
  ]);
  const currency = user?.currency || 'USD';
  const fx = currency === 'USD' ? 1 : await rateBetween('USD', currency);
  const held = new Map(wallets.map((w) => [w.symbol, w.balance]));
  const list = assets
    .filter((a) => a.enabled || (held.get(a.symbol) || 0) > 0)
    .map((a) => {
      const p = prices[a.symbol];
      const balance = round8(held.get(a.symbol) || 0);
      const price = p ? p.usd * fx : null;
      return {
        symbol: a.symbol, name: a.name, icon: a.icon, network: a.network, enabled: a.enabled,
        balance, price, change24h: p?.change24h ?? null, value: price != null ? round2(balance * price) : 0
      };
    })
    // Coins you hold first (by value), then the rest in catalog order.
    .sort((x, y) => (y.value - x.value) || 0);
  const cryptoTotal = round2(list.reduce((s, a) => s + a.value, 0));
  const fiat = round2(user?.balance || 0);
  res.json({
    success: true,
    data: {
      enabled: settings.enabled,
      convertEnabled: settings.convertEnabled,
      convertFeePercent: settings.convertFeePercent,
      currency,
      fiat: { symbol: currency, name: `${currencyName(currency)} (${currency})`, balance: fiat, value: fiat },
      assets: list,
      totals: { fiat, crypto: cryptoTotal, total: round2(fiat + cryptoTotal) },
      pricesAt: Math.max(0, ...Object.values(prices).map((p) => p.at || 0))
    }
  });
});

/** GET /api/crypto/markets — every catalog coin at its live price in the user's currency. */
export const markets = handler(async (req, res) => {
  await ensureCryptoCatalog();
  const [user, assets, prices] = await Promise.all([
    User.findById(req.user.id).select('currency').lean(),
    CryptoAsset.find().sort({ sortOrder: 1, symbol: 1 }).select('symbol name icon enabled').lean(),
    getCryptoPrices()
  ]);
  const currency = user?.currency || 'USD';
  const fx = currency === 'USD' ? 1 : await rateBetween('USD', currency);
  const list = assets
    .filter((a) => prices[a.symbol]?.usd > 0)
    .map((a) => {
      const p = prices[a.symbol];
      return { symbol: a.symbol, name: a.name, icon: a.icon, enabled: a.enabled, price: p.usd * fx, change24h: p.change24h ?? 0, volume: round2((p.volume || 0) * fx) };
    })
    .sort((x, y) => y.volume - x.volume);
  res.json({ success: true, data: { currency, markets: list } });
});

/** GET /api/crypto/deposit-options — enabled coins that have a deposit address */
export const depositOptions = handler(async (req, res) => {
  await ensureCryptoCatalog();
  const settings = await cryptoSettings();
  if (!settings.enabled) return res.json({ success: true, data: { enabled: false, assets: [] } });
  const user = await User.findById(req.user.id).select('currency').lean();
  const [assets, prices] = await Promise.all([
    CryptoAsset.find({ enabled: true, depositAddress: { $ne: '' } }).sort({ sortOrder: 1 }).lean(),
    getCryptoPrices()
  ]);
  const fx = (user?.currency || 'USD') === 'USD' ? 1 : await rateBetween('USD', user.currency);
  res.json({
    success: true,
    data: {
      enabled: true,
      currency: user?.currency || 'USD',
      assets: assets.map((a) => ({
        symbol: a.symbol, name: a.name, icon: a.icon, network: a.network, address: a.depositAddress, memo: a.depositMemo,
        minDeposit: a.minDeposit, price: prices[a.symbol] ? prices[a.symbol].usd * fx : null
      }))
    }
  });
});

/**
 * POST /api/crypto/deposits   multipart: symbol, amount, txHash?, proof? (file)
 * The user tells us what they sent; the admin verifies it and approves.
 */
export const createDeposit = handler(async (req, res) => {
  const settings = await cryptoSettings();
  if (!settings.enabled) throw new HttpError(403, 'Crypto deposits are not available right now');
  const symbol = sym(req.body.symbol);
  const asset = await CryptoAsset.findOne({ symbol, enabled: true }).lean();
  if (!asset || !asset.depositAddress) throw new HttpError(400, 'This coin is not available for deposits');
  const amount = Number(req.body.amount);
  if (!(amount > 0) || amount > 1e12) throw new HttpError(400, 'Enter the amount you sent');
  if (asset.minDeposit && amount < asset.minDeposit) throw new HttpError(400, `The minimum ${symbol} deposit is ${asset.minDeposit} ${symbol}`);
  const txHash = asString(req.body.txHash, 200).trim();
  const file = req.files?.proof;
  if (!txHash && !file) throw new HttpError(400, 'Add the transaction hash (TXID) or a screenshot of the transfer');
  if (txHash && !/^[A-Za-z0-9:_-]{8,200}$/.test(txHash)) throw new HttpError(400, 'The transaction hash looks wrong. Copy it from your wallet.');
  if (txHash && await CryptoDeposit.exists({ symbol, txHash, status: { $in: ['pending', 'approved'] } })) {
    throw new HttpError(409, 'This transaction was already submitted');
  }
  let proof = '';
  if (file) {
    if (!/^image\//.test(file.mimetype) && file.mimetype !== 'application/pdf') throw new HttpError(400, 'The proof must be an image or a PDF');
    const name = `${uuidv4()}${path.extname(file.name || '') || '.jpg'}`;
    await file.mv(path.join(__dirname, '../uploads/payment-proofs', name));
    proof = `/uploads/payment-proofs/${name}`;
  }
  const user = await User.findById(req.user.id).select('currency').lean();
  const p = await priceIn(symbol, user?.currency || 'USD').catch(() => null);
  try {
    const d = await CryptoDeposit.create({
      user: req.user.id, symbol, amount: round8(amount), network: asset.network, address: asset.depositAddress, memo: asset.depositMemo,
      txHash, proof, reference: ref('CDP'), priceAtSubmit: p ? round2(p.price) : 0, currency: user?.currency || 'USD'
    });
    res.status(201).json({ success: true, message: `Deposit submitted. Your ${symbol} wallet is credited once it is verified.`, data: d });
  } catch (err) {
    if (err?.code === 11000) throw new HttpError(409, 'This transaction was already submitted');
    throw err;
  }
});

/** GET /api/crypto/deposits — the user's crypto deposits */
export const userDeposits = handler(async (req, res) => {
  const items = await CryptoDeposit.find({ user: req.user.id }).sort({ createdAt: -1 }).limit(100).lean();
  res.json({ success: true, data: items });
});

/** 7-day price lines for the dashboard: ?symbols=BTC,ETH (USD closes every 4 h). */
export const sparklines = handler(async (req, res) => {
  const symbols = asString(req.query.symbols, 400).split(',').map((x) => x.trim()).filter(Boolean);
  res.set('Cache-Control', 'private, max-age=300');
  res.json({ success: true, data: await getSparklines(symbols) });
});

/** Price history for the portfolio chart: ?symbols=BTC,ETH&range=1d|1w|1m|1y (USD closes). */
export const history = handler(async (req, res) => {
  const symbols = asString(req.query.symbols, 200).split(',').map((x) => x.trim()).filter(Boolean);
  res.json({ success: true, data: await getHistory(symbols, asString(req.query.range, 4)) });
});

/* ============================ User: convert ============================ */

const readConvert = async (req) => {
  const settings = await cryptoSettings();
  if (!settings.convertEnabled) throw new HttpError(403, 'Conversion is not available right now');
  const direction = req.body.direction === 'fiat_to_crypto' ? 'fiat_to_crypto' : req.body.direction === 'crypto_to_fiat' ? 'crypto_to_fiat' : null;
  if (!direction) throw new HttpError(400, 'Choose what to convert');
  const symbol = sym(req.body.symbol);
  const asset = await CryptoAsset.findOne({ symbol }).lean();
  if (!asset) throw new HttpError(404, 'Unknown coin');
  // Buying needs an enabled coin; selling is always allowed so nobody is stuck with a coin.
  if (direction === 'fiat_to_crypto' && !asset.enabled) throw new HttpError(400, `${symbol} is not available right now`);
  const amount = Number(req.body.amount);   // source units: fiat for fiat_to_crypto, coins for crypto_to_fiat
  if (!(amount > 0)) throw new HttpError(400, 'Enter an amount');
  const user = await User.findById(req.user.id).select('currency balance').lean();
  const currency = user?.currency || 'USD';
  const { price } = await priceIn(symbol, currency).catch(fail503);
  const feePercent = settings.convertFeePercent;
  let coinAmount;
  let fiatAmount;
  let fee;
  if (direction === 'crypto_to_fiat') {
    coinAmount = round8(amount);
    const gross = coinAmount * price;
    fee = round2(gross * feePercent / 100);
    fiatAmount = round2(gross - fee);
    if (fiatAmount < 0.01) throw new HttpError(400, 'The amount is too small to convert');
  } else {
    fiatAmount = round2(amount);
    fee = round2(fiatAmount * feePercent / 100);
    coinAmount = round8((fiatAmount - fee) / price);
    if (!(coinAmount > 0)) throw new HttpError(400, 'The amount is too small to convert');
  }
  return { direction, symbol, asset, currency, price, feePercent, fee, coinAmount, fiatAmount, user };
};

/** POST /api/crypto/convert/quote  { direction, symbol, amount } — what the user would get at the live price */
export const convertQuote = handler(async (req, res) => {
  const q = await readConvert(req);
  const wallet = await CryptoWallet.findOne({ user: req.user.id, symbol: q.symbol }).lean();
  res.json({
    success: true,
    data: {
      direction: q.direction, symbol: q.symbol, name: q.asset.name, currency: q.currency, price: q.price,
      feePercent: q.feePercent, fee: q.fee,
      pay: q.direction === 'crypto_to_fiat' ? { amount: q.coinAmount, unit: q.symbol } : { amount: q.fiatAmount, unit: q.currency },
      receive: q.direction === 'crypto_to_fiat' ? { amount: q.fiatAmount, unit: q.currency } : { amount: q.coinAmount, unit: q.symbol },
      available: q.direction === 'crypto_to_fiat' ? round8(wallet?.balance || 0) : round2(q.user?.balance || 0),
      quotedAt: Date.now()
    }
  });
});

/**
 * POST /api/crypto/convert  { direction, symbol, amount, quotedPrice }
 * Fills at the live price. If the price moved more than 1.5% from the quote the user saw,
 * nothing happens and the user is asked to review the new quote. Both balances change in
 * one database transaction.
 */
export const convert = handler(async (req, res) => {
  const q = await readConvert(req);
  const quoted = Number(req.body.quotedPrice);
  if (quoted > 0 && Math.abs(q.price - quoted) / quoted > 0.015) {
    throw new HttpError(409, `The ${q.symbol} price moved to ${round2(q.price)} ${q.currency}. Review the new amount and confirm again.`);
  }
  const reference = ref('CNV');
  await withTransaction(async (session) => {
    if (q.direction === 'crypto_to_fiat') {
      const w = await CryptoWallet.findOneAndUpdate(
        { user: req.user.id, symbol: q.symbol, balance: { $gte: q.coinAmount } },
        [{ $set: { balance: { $round: [{ $subtract: ['$balance', q.coinAmount] }, 8] } } }],
        { new: true, session }
      );
      if (!w) throw new HttpError(400, `Not enough ${q.symbol}`);
      await creditUser(req.user.id, q.fiatAmount, { session });
    } else {
      await debitUser(req.user.id, q.fiatAmount, { session });   // throws "Insufficient balance"
      await CryptoWallet.findOneAndUpdate(
        { user: req.user.id, symbol: q.symbol },
        [{ $set: { balance: { $round: [{ $add: [{ $ifNull: ['$balance', 0] }, q.coinAmount] }, 8] }, user: new mongoose.Types.ObjectId(String(req.user.id)), symbol: q.symbol } }],
        { upsert: true, new: true, session }
      );
    }
    await CryptoConversion.create([{
      user: req.user.id, direction: q.direction, symbol: q.symbol, coinAmount: q.coinAmount, fiatAmount: q.fiatAmount,
      currency: q.currency, price: q.price, feePercent: q.feePercent, fee: q.fee, reference
    }], { session });
    await recordTransaction({
      userId: req.user.id, amount: q.fiatAmount, currency: q.currency, type: 'crypto_convert', session, prefix: 'CNV',
      metadata: {
        direction: q.direction, coin: q.symbol, quantity: q.coinAmount, price: round2(q.price), fee: q.fee, reference,
        description: q.direction === 'crypto_to_fiat' ? `Converted ${q.coinAmount} ${q.symbol} to ${q.currency}` : `Converted ${q.currency} to ${q.coinAmount} ${q.symbol}`
      }
    });
  });
  res.json({
    success: true,
    message: q.direction === 'crypto_to_fiat'
      ? `Converted ${q.coinAmount} ${q.symbol} to ${q.fiatAmount.toFixed(2)} ${q.currency}`
      : `Converted ${q.fiatAmount.toFixed(2)} ${q.currency} to ${q.coinAmount} ${q.symbol}`,
    data: { direction: q.direction, symbol: q.symbol, coinAmount: q.coinAmount, fiatAmount: q.fiatAmount, price: q.price, fee: q.fee, reference }
  });
});

/* ============================ Admin ============================ */

/** GET /api/admin/crypto/assets — every coin with live price, address and on/off */
export const adminAssets = handler(async (_req, res) => {
  await ensureCryptoCatalog();
  const [assets, prices, settings, holders, pendingDeposits] = await Promise.all([
    CryptoAsset.find().sort({ sortOrder: 1, symbol: 1 }).lean(),
    getCryptoPrices(),
    cryptoSettings(),
    CryptoWallet.aggregate([{ $match: { balance: { $gt: 0 } } }, { $group: { _id: '$symbol', holders: { $sum: 1 }, total: { $sum: '$balance' } } }]),
    CryptoDeposit.countDocuments({ status: 'pending' })
  ]);
  const by = Object.fromEntries(holders.map((h) => [h._id, h]));
  res.json({
    success: true,
    data: {
      settings, pendingDeposits,
      assets: assets.map((a) => ({
        ...a, priceUsd: prices[a.symbol]?.usd ?? null, change24h: prices[a.symbol]?.change24h ?? null,
        holders: by[a.symbol]?.holders || 0, held: round8(by[a.symbol]?.total || 0)
      }))
    }
  });
});

/** PUT /api/admin/crypto/assets/:symbol  { depositAddress?, depositMemo?, network?, minDeposit?, enabled? } */
export const adminUpdateAsset = handler(async (req, res) => {
  const symbol = sym(req.params.symbol);
  const b = req.body || {};
  const set = {};
  if (b.depositAddress !== undefined) {
    set.depositAddress = asString(b.depositAddress, 200).trim();
    if (set.depositAddress && !/^[A-Za-z0-9:._-]{10,200}$/.test(set.depositAddress)) throw new HttpError(400, 'The wallet address has unexpected characters. Paste it exactly as your wallet shows it.');
  }
  if (b.depositMemo !== undefined) set.depositMemo = asString(b.depositMemo, 100).trim();
  if (b.network !== undefined) set.network = asString(b.network, 60).trim();
  if (b.minDeposit !== undefined && b.minDeposit !== '') {
    const n = Number(b.minDeposit);
    if (!(n >= 0)) throw new HttpError(400, 'Minimum deposit must be 0 or more');
    set.minDeposit = n;
  }
  if (typeof b.enabled === 'boolean') set.enabled = b.enabled;
  if (!Object.keys(set).length) throw new HttpError(400, 'Nothing to update');
  const asset = await CryptoAsset.findOneAndUpdate({ symbol }, { $set: set }, { new: true }).lean();
  if (!asset) throw new HttpError(404, 'Coin not found');
  const warn = asset.enabled && !asset.depositAddress ? ' Add a deposit address so users can deposit it.' : '';
  res.json({ success: true, message: `${symbol} saved.${warn}`, data: asset });
});

/** POST /api/admin/crypto/assets/bulk  { symbols: [...], enabled } */
export const adminBulkAssets = handler(async (req, res) => {
  const symbols = (Array.isArray(req.body?.symbols) ? req.body.symbols : []).map(sym).filter(Boolean).slice(0, 500);
  if (!symbols.length) throw new HttpError(400, 'Select at least one coin');
  if (typeof req.body?.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');
  const r = await CryptoAsset.updateMany({ symbol: { $in: symbols } }, { $set: { enabled: req.body.enabled } });
  res.json({ success: true, message: `${r.modifiedCount} coin${r.modifiedCount === 1 ? '' : 's'} ${req.body.enabled ? 'enabled' : 'disabled'}` });
});

/** PUT /api/admin/crypto/settings  { enabled?, convertEnabled?, convertFeePercent? } */
export const adminUpdateSettings = handler(async (req, res) => {
  const b = req.body || {};
  const set = {};
  if (typeof b.enabled === 'boolean') set['cryptoDeposits.enabled'] = b.enabled;
  if (typeof b.convertEnabled === 'boolean') set['cryptoDeposits.convertEnabled'] = b.convertEnabled;
  if (b.convertFeePercent !== undefined && b.convertFeePercent !== '') {
    const n = Number(b.convertFeePercent);
    if (!(n >= 0 && n <= 10)) throw new HttpError(400, 'Conversion fee must be between 0 and 10%');
    set['cryptoDeposits.convertFeePercent'] = n;
  }
  if (!Object.keys(set).length) throw new HttpError(400, 'Nothing to update');
  await Setting.updateOne({}, { $set: set }, { upsert: true });
  const settings = await cryptoSettings();
  res.json({ success: true, message: typeof b.enabled === 'boolean' ? `Crypto Deposit System ${b.enabled ? 'enabled' : 'disabled'}` : 'Crypto settings saved', data: settings });
});

/** GET /api/admin/crypto/deposits?status=&search= */
export const adminDeposits = handler(async (req, res) => {
  const { page, limit, skip } = paging(req.query, 25);
  const q = {};
  if (['pending', 'approved', 'rejected'].includes(req.query.status)) q.status = req.query.status;
  if (req.query.search) {
    const rx = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const users = await User.find({ $or: [{ email: rx }, { firstName: rx }, { lastName: rx }] }).select('_id').limit(200).lean();
    q.$or = [{ user: { $in: users.map((u) => u._id) } }, { symbol: rx }, { txHash: rx }, { reference: rx }];
  }
  const [items, total, counts] = await Promise.all([
    CryptoDeposit.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('user', 'firstName lastName email accountId currency').lean(),
    CryptoDeposit.countDocuments(q),
    CryptoDeposit.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])
  ]);
  res.json({ success: true, data: { items, total, page, limit, counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) } });
});

/**
 * PATCH /api/admin/crypto/deposits/:id/:decision   decision = approve | reject
 * body: { amount? (coins to credit, defaults to what the user entered), note? }
 * Approval credits the user's coin wallet exactly once.
 */
export const adminDecideDeposit = handler(async (req, res) => {
  const decision = req.params.decision;
  if (!['approve', 'reject'].includes(decision)) throw new HttpError(400, 'Unknown action');
  const note = asString(req.body?.note, 500);
  const d = await CryptoDeposit.findById(oid(req.params.id)).lean();
  if (!d) throw new HttpError(404, 'Deposit not found');
  if (d.status !== 'pending') throw new HttpError(409, 'This deposit was already decided');

  if (decision === 'reject') {
    if (!note) throw new HttpError(400, 'Give the user a reason');
    const r = await CryptoDeposit.findOneAndUpdate({ _id: d._id, status: 'pending' }, { $set: { status: 'rejected', note, reviewedAt: new Date(), reviewedBy: req.user?.id } }, { new: true });
    if (!r) throw new HttpError(409, 'This deposit was already decided');
    notify(d.user, { title: `${d.symbol} deposit rejected`, content: `Your ${d.amount} ${d.symbol} deposit was rejected: ${note}`, type: 'deposit', link: '/wallet' }).catch(() => {});
    return res.json({ success: true, message: 'Deposit rejected', data: r });
  }

  const amount = req.body?.amount !== undefined && req.body.amount !== '' ? round8(Number(req.body.amount)) : d.amount;
  if (!(amount > 0)) throw new HttpError(400, 'Enter the amount to credit');
  const user = await User.findById(d.user).select('currency').lean();
  if (!user) throw new HttpError(404, 'The user no longer exists');
  const p = await priceIn(d.symbol, user.currency).catch(() => null);
  const value = p ? round2(amount * p.price) : 0;
  const result = await withTransaction(async (session) => {
    // The status + credited guard makes sure a deposit is credited only once.
    const r = await CryptoDeposit.findOneAndUpdate(
      { _id: d._id, status: 'pending', credited: false },
      { $set: { status: 'approved', credited: true, creditedAmount: amount, note, reviewedAt: new Date(), reviewedBy: req.user?.id } },
      { new: true, session }
    );
    if (!r) throw new HttpError(409, 'This deposit was already decided');
    await CryptoWallet.findOneAndUpdate(
      { user: d.user, symbol: d.symbol },
      [{ $set: { balance: { $round: [{ $add: [{ $ifNull: ['$balance', 0] }, amount] }, 8] }, user: d.user, symbol: d.symbol } }],
      { upsert: true, new: true, session }
    );
    const tx = await recordTransaction({
      userId: d.user, amount: value, currency: user.currency, type: 'crypto_deposit', session, prefix: 'CDP',
      metadata: { coin: d.symbol, quantity: amount, price: p ? round2(p.price) : null, txHash: d.txHash, deposit: String(d._id), reference: d.reference, description: `${amount} ${d.symbol} deposit` }
    });
    r.transaction = tx?._id;
    await r.save({ session });
    return r;
  });
  notify(d.user, { title: `${d.symbol} deposit confirmed`, content: `${amount} ${d.symbol} was added to your ${d.symbol} wallet.`, type: 'deposit', link: '/wallet' }).catch(() => {});
  res.json({ success: true, message: `${amount} ${d.symbol} credited to the user's ${d.symbol} wallet`, data: result });
});

/** GET /api/admin/crypto/users/:id/wallets — one user's coin balances */
export const adminUserWallets = handler(async (req, res) => {
  const wallets = await CryptoWallet.find({ user: oid(req.params.id), balance: { $gt: 0 } }).lean();
  const user = await User.findById(req.params.id).select('currency').lean();
  const prices = await getCryptoPrices();
  const fx = (user?.currency || 'USD') === 'USD' ? 1 : await rateBetween('USD', user.currency);
  res.json({ success: true, data: wallets.map((w) => ({ symbol: w.symbol, balance: w.balance, value: prices[w.symbol] ? round2(w.balance * prices[w.symbol].usd * fx) : null })) });
});

