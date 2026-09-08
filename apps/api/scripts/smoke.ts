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

// Refresh unconditionally. `seed()` is a no-op on an already-seeded database, so without
// this a second `npm run smoke` quotes against the *previous* run's price rows and every
// quote dies with QUOTE_STALE_RATE — a failure that looks like a pricing bug and is
// really a fixture that only works once.
{
  const fx = await import('../src/domain/fx.js');
  const refreshed = await fx.refreshRates();
  console.log('rates:', JSON.stringify(refreshed));
}
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

// Formatting invariants on the printed document. These exist because this codebase has
// twice rendered money correctly in the database and wrongly on paper: a 6-decimal asset
// printed at 2 decimals ("0.00 BTC") and a rate stored ×10^12 printed un-divided
// ("1 USDT = 128,934,652,108,500.00 KES"). Both were invisible to every other check.
// The expectations are shape + value, not a snapshot of the formatters.
const printed = (label: string): string => {
  const line = text.split('\n').find((l) => l.trimStart().startsWith(label));
  if (!line) return '';
  return line.slice(line.indexOf(label) + label.length).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
};
const formatFaults: string[] = [];
const expectShape = (name: string, value: string, pattern: RegExp, sanity?: (v: number) => boolean) => {
  if (!pattern.test(value)) formatFaults.push(`${name}: "${value}" is not shaped like a money/rate figure`);
  else if (sanity) {
    const num = Number(value.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(num) || !sanity(num)) formatFaults.push(`${name}: "${value}" is out of any sane range`);
  }
};
const KES_FIGURE = /^Ksh \d{1,3}(,\d{3})*\.\d{2}$/;
const USDT_FIGURE = /^\d+\.\d{2,6} USDT( \(.*)?$/; // formatCrypto puts the unit after the number
expectShape('receipt.recipientGets', printed('Recipient gets:'), KES_FIGURE, (n) => n === 3200);
expectShape('receipt.paidWith', printed('Paid with:'), new RegExp(`(${KES_FIGURE.source}|${USDT_FIGURE.source})`), (n) => n > 1 && n < 100_000);
expectShape('receipt.assetAmount', printed('amount:'), USDT_FIGURE, (n) => n > 1 && n < 1000);
expectShape('receipt.networkFee', printed('network fee:'), USDT_FIGURE, (n) => n >= 0 && n < 100);
expectShape('receipt.midRate', printed('Mid-market rate:'), /^1 USDT = \d{1,3}(,\d{3})*\.\d{2,6} KES$/, (n) => n > 1 && n < 1_000_000);
expectShape('receipt.appliedRate', printed('Your rate:'), /^1 USDT = \d{1,3}(,\d{3})*\.\d{2,6} KES$/, (n) => n > 1 && n < 1_000_000);
if (payload) {
  if (payload.amounts.cryptoAmountMinor === '0') formatFaults.push('receipt.cryptoAmountMinor parsed to zero');
  if (BigInt(payload.amounts.recipientAmountMinor) !== 320_000n) formatFaults.push('recipient amount is not Ksh 3,200.00 in minor units');
}
if (formatFaults.length > 0) {
  console.error('FORMATTING FAULTS:\n' + formatFaults.map((f) => `  · ${f}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log('receipt formatting: recipient/asset amounts and both rates render at sane precision');
}
console.log('integrity:', row0 ? receipts.verifyIntegrity(row0.id) : null);
console.log('password for demo accounts:', DEMO_PASSWORD);
