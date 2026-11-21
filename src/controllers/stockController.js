import mongoose from 'mongoose';
import { StockAsset, StockHolding, StockOrder } from '../models/Stock.js';
import User from '../models/User.js';
import { parseAmount, round2, round8 } from '../utils/money.js';
import { asString, escapeRegex } from '../utils/validation.js';
import { withTransaction, debitUser, creditUser, recordTransaction, convertFromBase, HttpError } from '../utils/wallet.js';
import { handler, loadActiveUser, paging } from '../services/productService.js';
import { ensureDefaultStocks, refreshStockPrices, refreshStock, installStock, POPULAR_STOCKS } from '../services/stockPrices.js';
import { getBaseCurrency } from '../services/fx.js';

/** Wait for `p` at most `ms` (the work keeps going in the background). */
const within = (p, ms) => Promise.race([p.catch(() => null), new Promise((r) => setTimeout(r, ms))]);

/** Fresh price for a trade: a live stock whose market price can't be fetched is not traded on an old price. */
const tradablePrice = async (stock) => {
  const s = await freshen(stock);
  if (s.priceSource !== 'manual' && (!s.lastPriceAt || Date.now() - new Date(s.lastPriceAt).getTime() > 15 * 60e3)) {
    throw new HttpError(409, `The live price of ${s.symbol} is unavailable right now. Please try again shortly.`);
  }
  return s;
};

/** Make sure a live stock's price is at most a minute old before it is shown or traded. */
const freshen = async (stock) => {
  if (stock.priceSource === 'manual' || (stock.lastPriceAt && Date.now() - new Date(stock.lastPriceAt).getTime() < 60e3)) return stock;
  await refreshStock(stock, await getBaseCurrency());
  return (await StockAsset.findById(stock._id)) || stock;
};

const MIN_SHARES = 0.0001;

const findStock = async (symbol, session) => {
  const sym = asString(symbol, 10).toUpperCase();
  if (!sym) throw new HttpError(400, 'Symbol is required');
  const stock = await StockAsset.findOne({ symbol: sym, isActive: true }).session(session || null);
  if (!stock) throw new HttpError(404, 'Stock not found');
  return stock;
};

/** Value holdings at current prices, in the user's currency. */
const valueHoldings = async (userId, currency) => {
  const holdings = await StockHolding.find({ user: userId, shares: { $gt: 0 } }).populate('stock');
  const { rate } = await convertFromBase(1, currency);
  const positions = holdings.filter((h) => h.stock).map((h) => {
    const marketValue = round2(h.shares * h.stock.price * rate);
    const pnl = round2(marketValue - h.costBasis);
    return {
      id: h._id,
      symbol: h.stock.symbol,
      name: h.stock.name,
      logo: h.stock.logo,
      shares: h.shares,
      price: round2(h.stock.price * rate),
      avgCost: h.shares ? round2(h.costBasis / h.shares) : 0,
      costBasis: h.costBasis,
      marketValue,
      pnl,
      pnlPercent: h.costBasis ? round2((pnl / h.costBasis) * 100) : 0,
      changePercent: h.stock.changePercent
    };
  });
  const totals = positions.reduce((t, p) => ({
    marketValue: round2(t.marketValue + p.marketValue),
    costBasis: round2(t.costBasis + p.costBasis)
  }), { marketValue: 0, costBasis: 0 });
  totals.pnl = round2(totals.marketValue - totals.costBasis);
  return { positions, totals, rate };
};

/** GET /api/stocks?search=&sector= */
export const listStocks = handler(async (req, res) => {
  const filter = { isActive: true };
  if (req.query.search) {
    const rx = new RegExp(escapeRegex(req.query.search), 'i');
    filter.$or = [{ symbol: rx }, { name: rx }];
  }
  if (req.query.sector) filter.sector = asString(req.query.sector, 50);

  // New platform: wait for the popular stocks; existing platform: add them once in the background.
  if (!(await StockAsset.exists({}))) await within(ensureDefaultStocks(), 25000);
  else ensureDefaultStocks().catch(() => {});
  await within(refreshStockPrices(), 5000);
  const user = await User.findById(req.user.id).select('currency');
  const [stocks, sectors, { rate }] = await Promise.all([
    StockAsset.find(filter).select('-priceHistory').sort({ marketCap: -1, symbol: 1 }).limit(200),
    StockAsset.distinct('sector', { isActive: true }),
    convertFromBase(1, user.currency)
  ]);
  res.json({
    success: true,
    data: {
      currency: user.currency,
      sectors,
      stocks: stocks.map((s) => ({ ...s.toJSON(), localPrice: round2(s.price * rate) }))
    }
  });
});

/** GET /api/stocks/:symbol */
export const getStock = handler(async (req, res) => {
  const stock = await within(findStock(req.params.symbol).then(freshen), 6000) || await findStock(req.params.symbol);
  const user = await User.findById(req.user.id).select('currency balance');
  const [{ rate }, holding] = await Promise.all([
    convertFromBase(1, user.currency),
    StockHolding.findOne({ user: req.user.id, stock: stock._id })
  ]);
  res.json({
    success: true,
    data: {
      stock: { ...stock.toJSON(), localPrice: round2(stock.price * rate) },
      currency: user.currency,
      availableBalance: user.balance,
      holding: holding ? { shares: holding.shares, costBasis: holding.costBasis } : { shares: 0, costBasis: 0 }
    }
  });
});

/** GET /api/stocks/portfolio */
export const getPortfolio = handler(async (req, res) => {
  const user = await User.findById(req.user.id).select('currency balance');
  const data = await valueHoldings(req.user.id, user.currency);
  res.json({ success: true, data: { ...data, currency: user.currency, availableBalance: user.balance } });
});

/** GET /api/stocks/orders */
export const getOrders = handler(async (req, res) => {
  const { page, limit, skip } = paging(req.query);
  const [items, total] = await Promise.all([
    StockOrder.find({ user: req.user.id }).sort({ createdAt: -1 }).skip(skip).limit(limit),
    StockOrder.countDocuments({ user: req.user.id })
  ]);
  res.json({ success: true, data: { items, total, page, limit } });
});

/** POST /api/stocks/buy  { symbol, amount }  (amount in user currency, fees included on top) */
export const buyStock = handler(async (req, res) => {
  const amount = parseAmount(req.body.amount);
  if (amount === null) throw new HttpError(400, 'Enter how much you want to invest');
  const user = await loadActiveUser(req.user.id);
  const stock = await tradablePrice(await findStock(req.body.symbol));
  const { rate } = await convertFromBase(1, user.currency);

  const localPrice = stock.price * rate;
  if (!(localPrice > 0)) throw new HttpError(400, 'This stock is not tradable right now');
  const shares = round8(amount / localPrice);
  if (shares < MIN_SHARES) throw new HttpError(400, 'Amount is too small');
  const gross = round2(amount);
  const fee = round2(gross * (stock.feePercent / 100));
  const total = round2(gross + fee);

  const order = await withTransaction(async (session) => {
    await debitUser(user._id, total, { session });
    await StockHolding.findOneAndUpdate(
      { user: user._id, stock: stock._id },
      { $inc: { shares, costBasis: gross }, $setOnInsert: { currency: user.currency } },
      { upsert: true, new: true, session }
    );
    const [o] = await StockOrder.create([{
      user: user._id, stock: stock._id, symbol: stock.symbol, side: 'buy',
      shares, price: stock.price, amount: gross, fee, currency: user.currency
    }], { session });
    await recordTransaction({
      userId: user._id, amount: total, currency: user.currency, type: 'stock',
      metadata: { side: 'buy', symbol: stock.symbol, shares, fee, orderId: o._id }, session, prefix: 'STK'
    });
    return o;
  });

  res.status(201).json({ success: true, message: `Bought ${shares} ${stock.symbol}`, data: order });
});

/** POST /api/stocks/sell  { symbol, shares }  (or { symbol, all: true }) */
export const sellStock = handler(async (req, res) => {
  const user = await loadActiveUser(req.user.id);
  const stock = await tradablePrice(await findStock(req.body.symbol));
  const { rate } = await convertFromBase(1, user.currency);

  const order = await withTransaction(async (session) => {
    const holding = await StockHolding.findOne({ user: user._id, stock: stock._id }).session(session);
    if (!holding || holding.shares <= 0) throw new HttpError(400, `You don't own any ${stock.symbol}`);

    const shares = req.body.all === true ? holding.shares : round8(parseAmount(req.body.shares) || 0);
    if (!(shares >= MIN_SHARES)) throw new HttpError(400, 'Enter a valid number of shares');
    if (shares > holding.shares + 1e-9) throw new HttpError(400, 'You cannot sell more shares than you own');

    const gross = round2(shares * stock.price * rate);
    const fee = round2(gross * (stock.feePercent / 100));
    const proceeds = round2(gross - fee);
    const costPortion = round2(holding.costBasis * (shares / holding.shares));
    const realizedPnl = round2(proceeds - costPortion);

    const remaining = round8(holding.shares - shares);
    holding.shares = remaining < MIN_SHARES ? 0 : remaining;
    holding.costBasis = holding.shares === 0 ? 0 : round2(holding.costBasis - costPortion);
    await holding.save({ session });

    if (proceeds > 0) await creditUser(user._id, proceeds, { session });
    const [o] = await StockOrder.create([{
      user: user._id, stock: stock._id, symbol: stock.symbol, side: 'sell',
      shares, price: stock.price, amount: gross, fee, currency: user.currency, realizedPnl
    }], { session });
    await recordTransaction({
      userId: user._id, amount: proceeds, currency: user.currency, type: 'stock',
      metadata: { side: 'sell', symbol: stock.symbol, shares, fee, realizedPnl, orderId: o._id }, session, prefix: 'STK'
    });
    return o;
  });

  res.json({ success: true, message: `Sold ${order.shares} ${stock.symbol}`, data: order });
});

/* ------------------------------ Admin ------------------------------ */

const stockFields = (body) => {
  const out = {};
  for (const k of ['name', 'exchange', 'sector', 'logo', 'description']) {
    if (body[k] !== undefined) out[k] = asString(body[k], k === 'description' ? 2000 : 200);
  }
  if (body.symbol !== undefined) out.symbol = asString(body.symbol, 10).toUpperCase();
  for (const k of ['price', 'previousClose', 'marketCap', 'dividendYield', 'feePercent']) {
    if (body[k] !== undefined) {
      const n = parseAmount(body[k], { allowZero: true, max: 1e15 });
      if (n === null) throw new HttpError(400, `Invalid ${k}`);
      out[k] = n;
    }
  }
  if (typeof body.isActive === 'boolean') out.isActive = body.isActive;
  if (body.priceSource === 'live' || body.priceSource === 'manual') out.priceSource = body.priceSource;
  return out;
};

export const adminListStocks = handler(async (_req, res) => {
  const stocks = await StockAsset.find().select('-priceHistory').sort({ symbol: 1 });
  res.json({ success: true, data: stocks });
});

export const adminCreateStock = handler(async (req, res) => {
  const fields = stockFields(req.body);
  if (!fields.symbol) throw new HttpError(400, 'Enter the stock symbol, e.g. AAPL');
  // No price given: add it from the market (real name, live price, one year of history).
  if (!(fields.price > 0) && fields.priceSource !== 'manual') {
    if (await StockAsset.exists({ symbol: fields.symbol })) throw new HttpError(409, `${fields.symbol} is already listed`);
    try {
      await installStock(fields.symbol, fields.sector);
    } catch (err) {
      throw new HttpError(400, `${fields.symbol} was not found on the market (${err.message}). Check the symbol, or set a manual price.`);
    }
    const extra = { ...fields };
    delete extra.symbol; delete extra.price; delete extra.previousClose;
    const stock = await StockAsset.findOneAndUpdate({ symbol: fields.symbol }, { $set: extra }, { new: true }).select('-priceHistory');
    return res.status(201).json({ success: true, message: `${stock.name} added with its live market price`, data: stock });
  }
  if (!fields.name || !(fields.price > 0)) throw new HttpError(400, 'A manual stock needs a name and a price');
  fields.priceSource = 'manual';
  fields.previousClose = fields.previousClose || fields.price;
  fields.priceHistory = [{ price: fields.price, at: new Date() }];
  const stock = await StockAsset.create(fields);
  res.status(201).json({ success: true, data: stock });
});

export const adminUpdateStock = handler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw new HttpError(400, 'Invalid id');
  const stock = await StockAsset.findById(req.params.id);
  if (!stock) throw new HttpError(404, 'Stock not found');
  const fields = stockFields(req.body);
  const priceChanged = fields.price !== undefined && fields.price !== stock.price;
  // Typing a price takes the stock off the live feed until the admin switches it back to live.
  if (priceChanged && fields.priceSource !== 'live') fields.priceSource = 'manual';
  Object.assign(stock, fields);
  if (priceChanged) {
    stock.priceHistory.push({ price: fields.price, at: new Date() });
    if (stock.priceHistory.length > 365) stock.priceHistory = stock.priceHistory.slice(-365);
  }
  await stock.save();
  if (fields.priceSource === 'live') await refreshStock(stock, await getBaseCurrency());
  res.json({ success: true, data: await StockAsset.findById(stock._id).select('-priceHistory') });
});

/** POST /api/admin/products/stocks/prices  { prices: [{ symbol, price, previousClose? }] } */
export const adminBulkPrices = handler(async (req, res) => {
  const list = Array.isArray(req.body.prices) ? req.body.prices.slice(0, 500) : [];
  let updated = 0;
  for (const item of list) {
    const price = parseAmount(item?.price);
    const symbol = asString(item?.symbol, 10).toUpperCase();
    if (!price || !symbol) continue;
    const set = { price, priceSource: 'manual' };
    const prev = parseAmount(item.previousClose);
    if (prev) set.previousClose = prev;
    const r = await StockAsset.updateOne(
      { symbol },
      { $set: set, $push: { priceHistory: { $each: [{ price, at: new Date() }], $slice: -365 } } }
    );
    updated += r.modifiedCount;
  }
  res.json({ success: true, message: `${updated} prices updated` });
});

export const adminListHoldings = handler(async (req, res) => {
  const { page, limit, skip } = paging(req.query);
  const [items, total] = await Promise.all([
    StockHolding.find({ shares: { $gt: 0 } }).populate('user', 'email firstName lastName accountId').populate('stock', 'symbol name price')
      .sort({ updatedAt: -1 }).skip(skip).limit(limit),
    StockHolding.countDocuments({ shares: { $gt: 0 } })
  ]);
  res.json({ success: true, data: { items, total, page, limit } });
});

/** POST /api/admin/products/stocks/refresh — fetch live prices now */
export const adminRefreshStocks = handler(async (_req, res) => {
  const r = await refreshStockPrices({ force: true });
  res.json({ success: true, message: `${r.updated} of ${r.checked} live prices updated`, data: r });
});

/** POST /api/admin/products/stocks/install-popular — add the popular stocks that are not listed yet */
export const adminInstallPopular = handler(async (_req, res) => {
  const results = await ensureDefaultStocks({ force: true });
  const installed = results.filter((r) => r.status === 'installed').length;
  const failed = results.filter((r) => r.status === 'failed');
  res.json({
    success: true,
    message: installed ? `${installed} stocks added from the market` : 'All popular stocks are already listed',
    data: { installed, failed: failed.map((f) => `${f.symbol}: ${f.error}`), total: POPULAR_STOCKS.length }
  });
});

/**
 * DELETE /api/admin/products/stocks/:id
 * Removes a listing nobody holds. While users still hold shares it is refused
 * (hide it instead, so holders can still sell). Order history is kept.
 */
export const adminDeleteStock = handler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw new HttpError(400, 'Invalid id');
  const stock = await StockAsset.findById(req.params.id).select('symbol name');
  if (!stock) throw new HttpError(404, 'Stock not found');
  const holders = await StockHolding.countDocuments({ stock: stock._id, shares: { $gt: 0 } });
  if (holders) {
    throw new HttpError(409, `${holders} user${holders === 1 ? ' holds' : 's hold'} ${stock.symbol}. Set it to Hidden instead so ${holders === 1 ? 'they' : 'they'} can still sell, and delete it once nobody holds it.`);
  }
  await StockHolding.deleteMany({ stock: stock._id });
  await StockAsset.deleteOne({ _id: stock._id });
  res.json({ success: true, message: `${stock.symbol} deleted` });
});
