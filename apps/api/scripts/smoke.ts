import { config } from '../src/config.js';
import { seed, describe as describeSeed, DEMO_PASSWORD } from '../src/seed/index.js';
import { getDb } from '../src/db/index.js';
import * as quotes from '../src/domain/quotes.js';
import * as payments from '../src/domain/payments.js';
import * as sandbox from '../src/domain/sandbox.js';
import * as ledger from '../src/domain/ledger.js';
import * as wallets from '../src/domain/wallets.js';
import * as receipts from '../src/domain/receipts.js';
import * as refunds from '../src/domain/refunds.js';
import { runDue, sweep, stats } from '../src/workers/queue.js';

if (config.mode !== 'sandbox') {
  console.error('run with MODE=sandbox');
  process.exit(1);
}

payments; // wiring check

const summary = await seed({ runDemoPayments: true });
console.log('seed:', JSON.stringify(summary, null, 2));
console.log(describeSeed());

const db = getDb();
const kelvin = db.one<{ id: string }>(`SELECT id FROM users WHERE email = 'kelvin@aurapay.dev'`);
const recipient = db.one<{ id: string; phone: string | null }>(
  `SELECT id, phone FROM payment_recipients WHERE user_id = ? AND kind = 'PHONE' LIMIT 1`,
  [kelvin.id],
);

const quote = quotes.create({
  userId: kelvin.id,
  asset: 'USDT',
  network: 'TRON',
  kind: 'PHONE',
  recipientAmountKesMajor: 3200,
  recipientId: recipient.id,
  verifiedRecipient: true,
});
console.log('quote:', {
  recipient: quote.recipientAmountMinor.toString(),
  crypto: quote.cryptoAmountMinor.toString(),
  networkFee: quote.networkFeeMinor.toString(),
  serviceFee: quote.serviceFeeMinor.toString(),
  total: quote.totalDebitMinor.toString(),
  rate: Number(quote.fxRate) / 1e12,
  rail: quote.rail,
  provider: quote.route.provider,
});

const created = await payments.create({
  userId: kelvin.id,
  quoteId: quote.quoteId,
  recipientId: recipient.id,
  strongConfirmation: true,
});
console.log('created (queue jobs scheduled):', JSON.stringify(stats()));
console.log('created:', created.payment.reference, created.payment.status, 'deposit', String(created.payment.depositAddress).slice(0, 18));

await sandbox.simulateDeposit({ paymentId: created.payment.id });
// Drive it the way production does: the worker loop only. Nothing here calls the
// payment engine directly — if the queues and evidence are right, it completes.
for (let i = 0; i < 120; i += 1) {
  await sweep();
  await runDue(30);
  const state = payments.view(created.payment.id, { userId: kelvin.id });
  if (state.terminal) break;
  await new Promise((r) => setTimeout(r, 250));
}
console.log('queue stats:', JSON.stringify(stats()));

const view = payments.view(created.payment.id, { userId: kelvin.id });
console.log('final state:', view.status, view.displayStatus, 'progress', view.progress);
console.log('steps:', view.steps.map((s) => `${s.step}:${s.status}`).join(' '));
console.log('payout:', view.payout ? { state: view.payout.state, ref: view.payout.providerReference } : null);
console.log('ledger entries:', db.maybeOne<{ c: number }>(
  'SELECT COUNT(*) AS c FROM ledger_entries WHERE payment_intent_id = ?',
  [created.payment.id],
)?.c);
console.log('verify(payment):', ledger.verify({ paymentIntentId: created.payment.id }));
console.log('verify(all):', ledger.verify());
console.log('wallet after:', wallets.listWallets(kelvin.id).map((w) => `${w.asset}/${w.network} avail=${w.available_minor} res=${w.reserved_minor}`));

// refund path on the completed payment
const refund = await refunds.refund(created.payment.id, { actor: 'smoke', mode: 'AUTO', reason: 'smoke test refund', reasonCode: 'SMOKE' }).catch((error) => ({ error: (error as Error).message }));
console.log('refund:', refund);
console.log('verify(after refund):', ledger.verify());

const row0 = db.maybeOne<{ id: string; reference: string; content_sha256: string }>(
  'SELECT id, reference, content_sha256 FROM receipts WHERE payment_intent_id = ?',
  [created.payment.id],
);
console.log('receipt row:', row0 ? { id: row0.id, reference: row0.reference, sha: row0.content_sha256.slice(0, 16) } : null);
const payload = receipts.byPayment(created.payment.id);
const text = payload ? receipts.asText(payload) : '';
console.log('--- receipt excerpt ---\n' + text.split('\n').slice(0, 18).join('\n'));
console.log('integrity:', row0 ? receipts.verifyIntegrity(row0.id) : null);
console.log('password for demo accounts:', DEMO_PASSWORD);
