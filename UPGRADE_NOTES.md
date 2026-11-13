# Upgrade notes: security hardening + new products

## Before you deploy (required)

1. **Rotate every secret.** `src/config/config.env` was committed to git, so the MongoDB password, JWT secret, SMTP, Cloudinary and Twilio credentials in it are in the repo history. Change all of them. The file is no longer tracked. Copy `src/config/config.env.example` locally, or set the variables in Render.
2. **Set the allowed origins.** CORS now only accepts `FRONTEND_URL`, `ADMIN_URL` and `CORS_ORIGINS` (comma separated). **Set `ADMIN_URL` to your admin panel's URL, or the admin panel will be blocked.**
3. **Set `API_BASE_URL`** to this API's public URL. Admins get signed, 15-minute links to KYC documents that use it.
4. **Create admins from the CLI.** The open `POST /api/admin/create-admin` endpoint is gone:
   `npm run create-admin -- admin@example.com "a-long-password"`
5. Optionally seed starter products with `npm run seed:products`. The stock prices are placeholders.

All existing user sessions stay valid.

## Security fixes

| Issue | Fix |
|---|---|
| `POST /api/trading/sim/balance/topup` let any user credit their own balance | Route removed. The market page now opens Deposit/Withdraw instead |
| `POST /api/admin/create-admin` was unauthenticated | Removed. Use the CLI script |
| `/api/admin/dashboard/*` and `/api/admin/withdrawals/*` were open to any logged-in user | Admin only |
| `PUT /api/withdrawals/:id/status` let users approve their own withdrawals | Admin only |
| `/api/admin/popup-assignments` had no auth | Admin only |
| Admin rejection referenced an undefined `User` (crash). Rejecting a pending withdrawal never refunded | The refund now happens exactly once, in a transaction. A rejected withdrawal can no longer change |
| Concurrent debits could overdraw (read-then-write) | Balance debits are conditional and atomic and round to the cent |
| KYC images (IDs, faces, addresses) were public static files and committed to git | Not served statically any more. Admins get HMAC-signed short-lived links. Files are untracked |
| Uploads used client-supplied filenames (path traversal) and accepted any type | Filenames are sanitized. Only JPG/PNG/GIF/WEBP/PDF are allowed |
| NoSQL operator injection (`{"$ne": …}`) in body/query | Operator keys are stripped globally. Login coerces inputs to strings |
| Regex injection / ReDoS in admin search | All search input is escaped |
| `/me` returned email/phone verification codes and the withdrawal token | These are redacted |
| `isAdmin` trusted the token flag alone | It also checks that the Admin record still exists. JWT algorithm is pinned to HS256 |
| Hard-coded Twilio test endpoints that sent SMS to fixed numbers | Removed |
| No helmet, open CORS, no rate limits on login | Helmet, origin allow-list, rate limits on auth, money and admin routes |
| Mixed `Uploads`/`uploads` paths broke on Linux | One upload root (`src/uploads`). Legacy `/Uploads/...` URLs still resolve |
| Shadowed admin copy-trading routes (`/stats`, `/export`) | Reordered |
| Sim "sell" endpoint the frontend called (`/sell/:id`) did not exist | Added |
| Startup crashed without a `config.env` file, the DB connected twice, and there was dead or broken `server.js` code | Fixed or removed |

## New products (user API)

All routes require a user token. Admins can switch each module off (`/api/admin/products/config`).

- **Cold storage** `/api/cold-storage`: create vaults (flexible or time-locked), deposit, request unlock (security delay, default 48h, user notified), cancel, release, close.
- **Cards** `/api/cards`: request a virtual or physical card (fee charged), fund, unload, freeze, set a limit, cancel (balance refunded). Full card numbers and CVVs are never stored. Plug in an issuing provider via `providerCardId` when you approve a card.
- **Wallet connect** `/api/wallets`: the page lists 26 wallet apps with search, plus "Add new wallet". Browser wallets (MetaMask, Trust, Coinbase…) connect by signing a nonce, which the server checks with `ethers`. Any wallet can instead be linked by its public BTC/EVM/SOL/TRON address (watch-only). `provider` stores the wallet app (e.g. `trust`, `exodus`). Requests containing a seed phrase or private key are rejected, and the page never asks for one.
- **Stocks** `/api/stocks`: market list, buy by amount (fractional), sell shares or all, portfolio with P/L, order history.
- **Staking** `/api/staking`: crypto pools (`GET /pools`) with min/max **in the coin** (e.g. 9–1000 AVAX), a reward cycle (daily/weekly/monthly), APY and an optional lock. Stake cost and payouts convert at the live Binance USD price (the pool `price` is only a fallback; `PRICE_FEED=off` disables live prices). Rewards are earned in the coin after each completed cycle. `GET /history`, `POST /stake {poolId, amount}`, `POST /positions/:id/claim`, `POST /positions/:id/unstake`. Admin pool fields: `asset, name, icon, apy, cycle, lockDays, minAmount, maxAmount, price, capacity, allowEarlyUnstake, earlyUnstakePenaltyPercent, sortOrder, isActive`.
- **Real estate** `/api/real-estate`: projects in Open and Closed lists (`GET /projects?status=open|closed`), a project page (`GET /projects/:idOrSlug`), and investing by amount (`POST /projects/:id/invest {amount}`, minimum enforced, never over-subscribed; a project closes automatically when fully funded). Returns (amount × ROI%) build up evenly over the term and can be collected at any time; principal is returned at maturity. Admin project fields: `title, summary, overview, images, location, propertyType, assetType, stories, strategy, objective, minimumInvestment, roi, durationMonths, fundingTarget, whyProject[], sponsor{name, about}, whySponsor[], documents[{title, url}], status, featured, sortOrder`. **Breaking change:** the old share-based fields (`sharePrice`, `totalShares`, `expectedAnnualYield`) are gone, so recreate any projects made with the earlier version.
- **Portfolio** `GET /api/portfolio/summary`: totals across cash, vaults, cards, stocks, staking and real estate.

Prices and limits are set in the platform base currency (`Setting.defaultCurrency`) and converted to each user's currency.

## Admin API (`/api/admin/products`, admin token)

```
GET/PUT  /config                                  feature switches, card fees, vault delay/min
GET      /cold-storage             PATCH /cold-storage/:id {adminHold, adminNote, releaseNow}
GET      /cards                    POST /cards/:id/approve {last4?, expiryMonth?, expiryYear?, providerCardId?}
POST     /cards/:id/reject {reason}            PATCH /cards/:id/status {status: active|frozen}
GET      /wallets
GET/POST /stocks                   PUT /stocks/:id         POST /stocks/prices {prices:[{symbol, price, previousClose?}]}
GET      /stock-holdings
GET/POST /staking/plans            PUT/DELETE /staking/plans/:id      GET /staking/positions
GET/POST /real-estate/properties   PUT/DELETE /real-estate/properties/:id   GET /real-estate/investments
```

Screens for these endpoints still need to be added to the admin panel, which is a separate project.

## Copy trading (rebuilt)

The old implementation silently dropped admin-added trades (`trader.trades` was not in the schema). It moved prices at random, kept positions in three disagreeing places, and could not settle P/L reliably. It is replaced by one engine, `src/services/copyTradingEngine.js`:

- **Copy = ring-fenced sub-account.** Starting a copy debits the user's balance into `CopyTrade.cash`. Stopping it closes the open positions at the current price and pays everything back.
- **Master trades.** An admin opens a trade on a trader (`symbol, side, entryPrice, allocationPercent, leverage`). Each active copy opens a position with `allocationPercent`% of its equity. Closing the master trade settles every copier at the same exit price.
- **Fair money rules.** A position can't lose more than its margin. The trader's commission (`settings.commissionRate`) is taken only from winning trades. Copiers can add funds, pause, set a stop-loss or take-profit (auto-stop), or close one position early.
- **Real stats.** ROI, win rate, max drawdown, 7/30-day return and the equity curve are computed from closed trades. Admins can't type them in.
- **Live prices.** Crypto pairs quoted in USD/USDT (e.g. `BTC/USDT`) are marked to Binance every minute. Other symbols use the price the admin sets. Turn the feed off with `COPY_PRICE_FEED=off`.
- **Safety.** One open copy per trader per user (enforced by an index). Each position settles exactly once, even under concurrent requests. Crash recovery runs on startup.
- **Existing data.** On first start, old active copies get `cash = amount + recorded profit`. Their unsettled old positions are retired (they never had funds reserved).

User API (`/api/copy-trading`): `GET /traders`, `GET /traders/:traderId`, `POST /copy`, `GET /copies`, `GET /copies/:id`, `POST /copies/:id/add-funds|pause|resume|stop`, `PUT /copies/:id/settings`, `POST /positions/:id/close`, `GET /history`.

Admin API (`/api/admin/copy-trading`): trader CRUD (`/traders`, `/traders/:traderId/profile|settings|status|verification|avatar`), trades (`GET/POST /traders/:traderId/trades`, `PUT /traders/:traderId/trades/:tradeId {markPrice}`, `POST .../:tradeId/close {exitPrice}`, `DELETE .../:tradeId` = cancel with refund), `POST /prices {prices:[{symbol, price}]}`, `GET /copies`, `POST /copy-trades/:copyId/suspend|resume|force-stop`, `GET /positions`, `GET /platform/stats`. The older `/api/admin/traders/...` trade paths still work.

**Profiles, ticks and followers**
- Every trader always has a profile picture. If an admin doesn't upload one, a generated picture (initials on a gradient) is created. Existing traders without a picture get one on server start.
- Verification ticks: set `PUT /api/admin/copy-trading/traders/:traderId/verification {badge: 'gold' | 'blue' | 'none'}` (also accepted when creating a trader). Gold = elite (stored as verified + level `pro`), blue = verified, none = shown as "Unverified".
- Followers: users can follow/unfollow (`POST`/`DELETE /api/copy-trading/traders/:traderId/follow`). The follower count is recounted on every change, so it can't drift. Sort experts with `?sort=followers`.
- The user page has two tabs: **Top Experts** (`/copytrade`) and **Copying** (`/copy-positions`).

`npm run seed:trading` creates three starter traders with no track record. The old seed script was removed because it created an `admin@example.com / admin123` user.

## Other notes

- `npm start` now runs `node src/app.js`. The obfuscated build is still available as `npm run secure` + `npm run start:obf`.
- `RATE_LIMIT_MULTIPLIER` scales every rate limit (e.g. `2` doubles them).

## Notifications (rebuilt)

- **Storage:** notifications live in their own `notifications` collection, not inside each user document. On first start, existing embedded notifications are moved over automatically. They expire after 180 days.
- **Single entry point:** everything goes through `services/notificationService.js` → `notifyUser(userId, { type, title, content, link, metadata, dedupeKey })`. It saves the notification and pushes it live over the WebSocket together with the current unread count. `createNotification` still works for older callers.
- **Unread counts can't drift:** they're always counted from the collection.
- **Duplicates:** `dedupeKey` makes an event notify only once (e.g. the welcome message).
- **Preferences:** `notificationPreferences.inApp = false` mutes everything except `security` notices.
- **New events:** deposit confirmed / declined, withdrawal status changes, admin messages, and sign-in from a new device or network. The old "Welcome back" on every login is gone.
- **API** (`/api/notifications`, user token):
  - `GET /?filter=all|unread&limit=20&before=<cursor>` — newest first, with `hasMore` / `nextCursor`
  - `GET /count`
  - `PATCH /:id/read`, `PATCH /:id/unread`, `PATCH /read-all`
  - `DELETE /:id`, `DELETE /?scope=read|all`
  - `GET /preferences`, `PUT /preferences`
  - `POST /welcome`
- **Live updates:** the WebSocket at `/api/notifications/ws?token=…` sends `{ type: 'notification', data: { kind: 'notification.created' | 'notification.count', notification?, unreadCount } }`.
- **Admin:** `GET /api/admin/dashboard/notifications` now reads from the collection.
