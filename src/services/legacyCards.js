// The old debit-card system (collection "cards") has been removed; the card system
// is now Card Settings + Card Invoices (CardRequest). Before it goes, any money still
// sitting on an old card goes back to its owner, once:
//   - active / frozen cards: the card balance is returned to the main balance;
//   - pending requests: the issuance fee that was charged is refunded.
// Each refund is recorded as a transaction and the user is notified.
import mongoose from 'mongoose';
import Setting from '../models/Setting.js';
import { creditUser, recordTransaction, withTransaction } from '../utils/wallet.js';
import { notifyUser } from './notificationService.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
let done = false;

export async function closeLegacyCards() {
  if (done) return 0;
  const s = await Setting.findOne().select('flags').lean();
  if (s?.flags?.legacyCardsClosed) { done = true; return 0; }
  const col = mongoose.connection.collection('cards');
  const cards = await col.find({ status: { $in: ['active', 'frozen', 'pending'] } }).toArray();
  let refunded = 0;
  for (const c of cards) {
    const amount = round2(c.status === 'pending' ? c.issuanceFee : c.balance);
    // Claim the card first so a second run can never refund it again.
    // eslint-disable-next-line no-await-in-loop
    const claimed = await col.findOneAndUpdate(
      { _id: c._id, status: c.status },
      { $set: { status: 'cancelled', cancelledAt: new Date(), adminNote: 'Closed: the old card system was retired' } }
    );
    if (!(claimed?.value ?? claimed) || !(amount > 0)) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await withTransaction(async (session) => {
        await creditUser(c.user, amount, { session });
        await recordTransaction({
          userId: c.user, amount, currency: c.currency, type: 'card', session, prefix: 'CRD',
          metadata: { action: c.status === 'pending' ? 'legacy_card_fee_refund' : 'legacy_card_balance_refund', card: String(c._id), last4: c.last4 || null }
        });
      });
      refunded += 1;
      notifyUser(c.user, {
        type: 'transaction',
        title: 'Card balance returned',
        content: `${amount} ${c.currency} from your ${c.last4 ? `card ending ${c.last4}` : 'card request'} was returned to your balance. You can get a new card from Cards.`,
        link: '/cards',
        dedupeKey: `legacy-card:${c._id}`
      }).catch(() => {});
    } catch (err) {
      // Put it back so the next run retries it.
      // eslint-disable-next-line no-await-in-loop
      await col.updateOne({ _id: c._id }, { $set: { status: c.status }, $unset: { cancelledAt: '' } });
      console.error(`Legacy card ${c._id} refund failed:`, err.message);
      return refunded;
    }
  }
  await Setting.updateOne({}, { $set: { 'flags.legacyCardsClosed': true } }, { upsert: true });
  done = true;
  return refunded;
}
