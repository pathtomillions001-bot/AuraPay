import { formatKes, formatCrypto, type AssetCode } from '@aurapay/shared';
import { getDb } from '../src/db/index.js';
import * as ledger from '../src/domain/ledger.js';

/** `npm run verify:ledger` — prints the book-integrity report for the configured database. */
const db = getDb();
void db;
const problems = ledger.verify();
if (problems.length === 0) {
  console.log('Ledger integrity: OK — every journal balances, conversions tie out, wallet cache matches customer liabilities.');
} else {
  console.log(`Ledger integrity: ${problems.length} problem(s)`);
  for (const p of problems.slice(0, 50)) console.log(`  ${p.kind} [${p.ref}] ${p.detail}`);
  process.exitCode = 1;
}
const to = new Date().toISOString();
const from = new Date(Date.now() - 90 * 86_400_000).toISOString();
console.log(`\nRevenue and expense recognised in the last 90 days (sandbox data is simulated):`);
for (const row of ledger.incomeStatement(from, to)) {
  // Printed in major units: an ops script that shows "2807 BTC" for 0.00002807
  // BTC invites exactly the kind of wrong decision it exists to prevent.
  const shown =
    row.asset === 'KES'
      ? formatKes(row.amountMinor)
      : formatCrypto(row.amountMinor, row.asset as AssetCode);
  console.log(`  ${row.account.padEnd(34)} ${shown.padStart(18)}`);
}
