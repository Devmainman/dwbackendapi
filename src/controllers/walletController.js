import crypto from 'crypto';
import mongoose from 'mongoose';
import { verifyMessage, getAddress, isAddress } from 'ethers';
import ConnectedWallet from '../models/ConnectedWallet.js';
import WalletNonce from '../models/WalletNonce.js';
import { asString } from '../utils/validation.js';
import { HttpError } from '../utils/wallet.js';
import { handler, paging } from '../services/productService.js';

const providerSlug = (v) => (typeof v === 'string' && /^[a-z0-9-]{2,40}$/.test(v.toLowerCase()) ? v.toLowerCase() : 'other');
const MAX_WALLETS = 10;

const allowedChains = () => (process.env.WALLET_ALLOWED_CHAINS || '1,56,137,8453,42161,10')
  .split(',').map((c) => Number(c.trim())).filter(Number.isInteger);

// Address formats for watch-only (unverified) wallets.
const ADDRESS_RULES = {
  bitcoin: /^(bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/
};

const SECRET_FIELDS = ['seed', 'seedphrase', 'seed_phrase', 'mnemonic', 'privatekey', 'private_key', 'recoveryphrase', 'secret', 'keystore'];

/**
 * Defensive guard: this API never needs a recovery phrase or private key.
 * If a client (or a phishing clone of the client) sends one, refuse it outright.
 */
const rejectSecrets = (body) => {
  const keys = Object.keys(body || {}).map((k) => k.toLowerCase().replace(/[^a-z_]/g, ''));
  if (keys.some((k) => SECRET_FIELDS.includes(k))) {
    throw new HttpError(400, 'Never share your recovery phrase or private key. We only ask you to sign a message.');
  }
};

/** GET /api/wallets */
export const listWallets = handler(async (req, res) => {
  const wallets = await ConnectedWallet.find({ user: req.user.id }).sort({ isPrimary: -1, createdAt: -1 });
  res.json({ success: true, data: { wallets, allowedChains: allowedChains() } });
});

/** POST /api/wallets/nonce — returns the message the wallet must sign */
export const createNonce = handler(async (req, res) => {
  const nonce = crypto.randomBytes(16).toString('hex');
  const issuedAt = new Date();
  const appName = process.env.APP_NAME || 'our platform';
  const message = [
    `${appName} wants you to link this wallet to your account.`,
    '',
    'Signing is free and does not send a transaction or give access to your funds.',
    '',
    `Account: ${req.user.id}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt.toISOString()}`
  ].join('\n');

  await WalletNonce.deleteMany({ user: req.user.id });
  await WalletNonce.create({ user: req.user.id, nonce, message, expiresAt: new Date(issuedAt.getTime() + 10 * 60 * 1000) });
  res.json({ success: true, data: { message, nonce } });
});

/** POST /api/wallets/connect  { address, signature, nonce, chainId, provider, label } */
export const connectWallet = handler(async (req, res) => {
  rejectSecrets(req.body);
  const address = asString(req.body.address, 64);
  const signature = asString(req.body.signature, 200);
  const nonce = asString(req.body.nonce, 64);
  const chainId = Number(req.body.chainId);

  if (!isAddress(address)) throw new HttpError(400, 'Invalid wallet address');
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new HttpError(400, 'Invalid signature');
  if (!allowedChains().includes(chainId)) throw new HttpError(400, 'This network is not supported');

  const challenge = await WalletNonce.findOneAndDelete({ user: req.user.id, nonce, expiresAt: { $gt: new Date() } });
  if (!challenge) throw new HttpError(400, 'Signature request expired. Please try again.');

  let recovered;
  try {
    recovered = verifyMessage(challenge.message, signature);
  } catch {
    throw new HttpError(400, 'Signature could not be verified');
  }
  const checksum = getAddress(address);
  if (getAddress(recovered) !== checksum) throw new HttpError(400, 'Signature does not match this wallet');

  const count = await ConnectedWallet.countDocuments({ user: req.user.id });
  const existing = await ConnectedWallet.findOne({ user: req.user.id, network: 'evm', address: checksum });
  if (!existing && count >= MAX_WALLETS) throw new HttpError(400, `You can link at most ${MAX_WALLETS} wallets`);

  const wallet = await ConnectedWallet.findOneAndUpdate(
    { user: req.user.id, network: 'evm', address: checksum },
    {
      $set: {
        chainId,
        provider: providerSlug(req.body.provider),
        label: asString(req.body.label, 40) || existing?.label || 'My Wallet',
        verified: true,
        verifiedAt: new Date()
      },
      $setOnInsert: { isPrimary: count === 0 }
    },
    { new: true, upsert: true }
  );

  res.status(existing ? 200 : 201).json({ success: true, message: 'Wallet connected', data: wallet });
});

/** POST /api/wallets/watch  { address, network, label } — unverified address book entry */
export const addWatchWallet = handler(async (req, res) => {
  rejectSecrets(req.body);
  const network = ['bitcoin', 'solana', 'tron', 'evm'].includes(req.body.network) ? req.body.network : null;
  if (!network) throw new HttpError(400, 'Unsupported network');
  let address = asString(req.body.address, 100);

  if (network === 'evm') {
    if (!isAddress(address)) throw new HttpError(400, 'Invalid EVM address');
    address = getAddress(address);
  } else if (!ADDRESS_RULES[network].test(address)) {
    throw new HttpError(400, `Invalid ${network} address`);
  }

  const count = await ConnectedWallet.countDocuments({ user: req.user.id });
  if (count >= MAX_WALLETS) throw new HttpError(400, `You can link at most ${MAX_WALLETS} wallets`);

  const wallet = await ConnectedWallet.create({
    user: req.user.id,
    address,
    network,
    provider: providerSlug(req.body.provider),
    label: asString(req.body.label, 40) || `${network.toUpperCase()} address`,
    verified: false,
    isPrimary: count === 0
  });
  res.status(201).json({ success: true, message: 'Address saved', data: wallet });
});

/** PATCH /api/wallets/:id  { label, isPrimary } */
export const updateWallet = handler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw new HttpError(400, 'Invalid wallet id');
  const wallet = await ConnectedWallet.findOne({ _id: req.params.id, user: req.user.id });
  if (!wallet) throw new HttpError(404, 'Wallet not found');

  if (req.body.label !== undefined) wallet.label = asString(req.body.label, 40);
  if (req.body.isPrimary === true) {
    await ConnectedWallet.updateMany({ user: req.user.id }, { $set: { isPrimary: false } });
    wallet.isPrimary = true;
  }
  await wallet.save();
  res.json({ success: true, data: wallet });
});

/** DELETE /api/wallets/:id */
export const removeWallet = handler(async (req, res) => {
  const wallet = await ConnectedWallet.findOneAndDelete({ _id: req.params.id, user: req.user.id });
  if (!wallet) throw new HttpError(404, 'Wallet not found');
  if (wallet.isPrimary) {
    await ConnectedWallet.findOneAndUpdate({ user: req.user.id }, { $set: { isPrimary: true } }, { sort: { createdAt: 1 } });
  }
  res.json({ success: true, message: 'Wallet disconnected' });
});

/* ------------------------------ Admin ------------------------------ */

export const adminListWallets = handler(async (req, res) => {
  const { page, limit, skip } = paging(req.query);
  const filter = {};
  if (req.query.userId && mongoose.Types.ObjectId.isValid(req.query.userId)) filter.user = req.query.userId;
  const [items, total] = await Promise.all([
    ConnectedWallet.find(filter).populate('user', 'email firstName lastName accountId').sort({ createdAt: -1 }).skip(skip).limit(limit),
    ConnectedWallet.countDocuments(filter)
  ]);
  res.json({ success: true, data: { items, total, page, limit } });
});
