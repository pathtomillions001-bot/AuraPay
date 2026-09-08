/**
 * AuraPay data model — schema of record.
 *
 * The same DDL is mirrored for PostgreSQL in `db/postgres/0001_init.sql`.
 * SQLite (embedded, driver `sqlite`) is used for sandbox/demo/tests so the
 * platform is runnable with zero infrastructure; production uses managed
 * Postgres. Amounts are stored as decimal strings of *minor units* so no
 * 64-bit or float truncation can occur on ETH-scale values.
 *
 * Invariants enforced in the database (not only in application code):
 *   - ledger_entries is append-only (UPDATE/DELETE blocked by triggers)
 *   - audit_logs and payment_events are append-only
 *   - idempotency keys are unique per (user, scope)
 *   - payment_intents.reference and all public tokens are unique
 */

export const SCHEMA_SQL = `
-- ─────────────────────────────────────────────────────────────── identity ──
CREATE TABLE IF NOT EXISTS users (
  id                    TEXT PRIMARY KEY,
  email                 TEXT NOT NULL UNIQUE,
  email_verified_at     TEXT,
  password_hash         TEXT NOT NULL,
  password_algo         TEXT NOT NULL DEFAULT 'scrypt',
  full_name             TEXT NOT NULL,
  phone                 TEXT,
  country               TEXT NOT NULL DEFAULT 'KE',
  locale                TEXT NOT NULL DEFAULT 'en-KE',
  roles                 TEXT NOT NULL DEFAULT '[]',
  status                TEXT NOT NULL DEFAULT 'ACTIVE',
  kyc_status            TEXT NOT NULL DEFAULT 'NOT_STARTED',
  kyc_tier              INTEGER NOT NULL DEFAULT 0,
  two_factor_enabled    INTEGER NOT NULL DEFAULT 0,
  two_factor_secret_enc TEXT,
  passkey_credential_id TEXT,
  default_settlement_rail TEXT NOT NULL DEFAULT 'MPESA',
  payout_limit_override_minor TEXT,
  failed_login_count    INTEGER NOT NULL DEFAULT 0,
  locked_until          TEXT,
  marketing_consent     INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  last_login_at         TEXT
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id        TEXT PRIMARY KEY REFERENCES users(id),
  avatar_seed    TEXT,
  city           TEXT,
  occupation     TEXT,
  source_of_funds TEXT,
  pep            INTEGER NOT NULL DEFAULT 0,
  tax_id_enc     TEXT,
  home_asset     TEXT NOT NULL DEFAULT 'USDT',
  notes          TEXT,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kyc_profiles (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  provider          TEXT NOT NULL,
  provider_ref      TEXT,
  status            TEXT NOT NULL,
  tier              INTEGER NOT NULL DEFAULT 0,
  document_type     TEXT,
  document_number_masked TEXT,
  country           TEXT,
  reviewed_by       TEXT,
  reviewed_at       TEXT,
  data_origin       TEXT NOT NULL DEFAULT 'sandbox',
  notes             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS businesses (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  legal_name      TEXT,
  category        TEXT,
  country         TEXT NOT NULL DEFAULT 'KE',
  currency        TEXT NOT NULL DEFAULT 'KES',
  registration_number TEXT,
  tax_number_masked   TEXT,
  kyb_status      TEXT NOT NULL DEFAULT 'NOT_STARTED',
  logo_mark       TEXT,
  website         TEXT,
  settlement_rail TEXT NOT NULL DEFAULT 'MPESA_TILL',
  settlement_target TEXT,
  till_number     TEXT,
  paybill_number  TEXT,
  merchant_code   TEXT NOT NULL UNIQUE,
  accept_crypto   INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'ACTIVE',
  mrr_tier        TEXT NOT NULL DEFAULT 'standard',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS business_members (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  role        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ACTIVE',
  invited_by  TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (business_id, user_id)
);

-- ────────────────────────────────────────────────────────────── wallets ────
CREATE TABLE IF NOT EXISTS wallets (
  id              TEXT PRIMARY KEY,
  user_id         TEXT REFERENCES users(id),
  business_id     TEXT REFERENCES businesses(id),
  kind            TEXT NOT NULL,           -- CUSTODIAL | EXTERNAL | TREASURY | FEE | SETTLEMENT
  label           TEXT,
  asset           TEXT NOT NULL,
  network         TEXT NOT NULL,
  available_minor TEXT NOT NULL DEFAULT '0',
  reserved_minor  TEXT NOT NULL DEFAULT '0',
  address         TEXT,
  address_index   INTEGER,
  custody_mode    TEXT NOT NULL DEFAULT 'partner',  -- partner | self_custody | hsm
  data_origin     TEXT NOT NULL DEFAULT 'sandbox',
  status          TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wallets_user_idx ON wallets(user_id, asset, network);
CREATE INDEX IF NOT EXISTS wallets_address_idx ON wallets(network, address);

CREATE TABLE IF NOT EXISTS wallet_addresses (
  id            TEXT PRIMARY KEY,
  wallet_id     TEXT NOT NULL REFERENCES wallets(id),
  payment_intent_id TEXT,
  address       TEXT NOT NULL,
  network       TEXT NOT NULL,
  purpose       TEXT NOT NULL,             -- DEPOSIT | TREASURY | REFUND
  derivation_index INTEGER,
  used_count    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  UNIQUE (network, address, payment_intent_id)
);

CREATE TABLE IF NOT EXISTS assets (
  code           TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL,
  scale          INTEGER NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  sandbox_payable INTEGER NOT NULL DEFAULT 0,
  production_enabled INTEGER NOT NULL DEFAULT 0,
  usd_price_minor TEXT NOT NULL DEFAULT '0',
  change24h_bps  INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS networks (
  code                   TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  confirmations_required INTEGER NOT NULL,
  block_time_seconds     REAL NOT NULL,
  fee_estimate_usd_cents INTEGER NOT NULL DEFAULT 0,
  dynamic_fee            INTEGER NOT NULL DEFAULT 0,
  adapter                TEXT,
  status                 TEXT NOT NULL DEFAULT 'OPERATIONAL',
  enabled                INTEGER NOT NULL DEFAULT 1,
  last_checked_at        TEXT,
  updated_at             TEXT NOT NULL
);

-- ─────────────────────────────────────────────────── pricing / quotes ──────
CREATE TABLE IF NOT EXISTS fees (
  id               TEXT PRIMARY KEY,
  asset            TEXT NOT NULL,
  rail             TEXT NOT NULL DEFAULT '*',
  platform_fee_bps INTEGER NOT NULL,
  platform_fee_min_kes INTEGER NOT NULL,
  spread_bps       INTEGER NOT NULL,
  rail_surcharge_minor INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1,
  effective_from   TEXT NOT NULL,
  updated_by       TEXT,
  note             TEXT,
  UNIQUE (asset, rail, effective_from)
);

CREATE TABLE IF NOT EXISTS exchange_rates (
  id           TEXT PRIMARY KEY,
  base         TEXT NOT NULL,
  quote        TEXT NOT NULL,
  rate_scaled  TEXT NOT NULL,              -- rate * 10^12
  mid_rate_scaled TEXT,
  source       TEXT NOT NULL,              -- aurapay-sandbox-feed | coinbase | partner
  is_simulated INTEGER NOT NULL DEFAULT 1,
  fetched_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS exchange_rates_pair_idx ON exchange_rates(base, quote, fetched_at DESC);

CREATE TABLE IF NOT EXISTS quotes (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT REFERENCES users(id),
  business_id         TEXT REFERENCES businesses(id),
  asset               TEXT NOT NULL,
  network             TEXT NOT NULL,
  rail                TEXT NOT NULL,
  recipient_country   TEXT NOT NULL DEFAULT 'KE',
  recipient_currency  TEXT NOT NULL DEFAULT 'KES',
  recipient_amount_minor TEXT NOT NULL,
  crypto_amount_minor TEXT NOT NULL,
  network_fee_minor   TEXT NOT NULL,
  service_fee_minor   TEXT NOT NULL,
  total_debit_minor   TEXT NOT NULL,
  fx_rate_scaled      TEXT NOT NULL,
  mid_rate_scaled     TEXT NOT NULL,
  fee_snapshot        TEXT NOT NULL,
  route_snapshot      TEXT NOT NULL,
  liquidity_snapshot  TEXT NOT NULL,
  risk_hint           TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'ACTIVE',
  mode                TEXT NOT NULL,
  data_origin         TEXT NOT NULL DEFAULT 'sandbox',
  ttl_seconds         INTEGER NOT NULL,
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  consumed_at         TEXT,
  invalidated_reason  TEXT
);
CREATE INDEX IF NOT EXISTS quotes_user_idx ON quotes(user_id, created_at DESC);

-- ────────────────────────────────────────────────────────── payments ───────
CREATE TABLE IF NOT EXISTS payment_recipients (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT REFERENCES users(id),
  business_id        TEXT REFERENCES businesses(id),
  kind               TEXT NOT NULL,
  display_name       TEXT NOT NULL,
  phone              TEXT,
  till               TEXT,
  paybill            TEXT,
  account_reference  TEXT,
  bank_code          TEXT,
  bank_account_enc   TEXT,
  wallet_address     TEXT,
  network            TEXT,
  country            TEXT NOT NULL DEFAULT 'KE',
  rail               TEXT NOT NULL,
  note               TEXT,
  favourite          INTEGER NOT NULL DEFAULT 0,
  default_amount_minor TEXT,
  verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
  verified_name      TEXT,
  verified_at        TEXT,
  last_used_at       TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS recipients_user_idx ON payment_recipients(user_id, favourite DESC, last_used_at DESC);

CREATE TABLE IF NOT EXISTS payment_intents (
  id                    TEXT PRIMARY KEY,
  reference             TEXT NOT NULL UNIQUE,
  external_id           TEXT,                    -- merchant's own order id
  idempotency_key       TEXT,
  user_id               TEXT REFERENCES users(id),
  business_id           TEXT REFERENCES businesses(id),
  payment_link_id       TEXT,
  quote_id              TEXT REFERENCES quotes(id),
  recipient_id          TEXT,
  recipient_snapshot    TEXT NOT NULL,
  direction             TEXT NOT NULL DEFAULT 'OUT',
  kind                  TEXT NOT NULL DEFAULT 'SEND',
  status                TEXT NOT NULL,
  asset                 TEXT NOT NULL,
  network               TEXT NOT NULL,
  rail                  TEXT NOT NULL,
  provider              TEXT NOT NULL,
  recipient_currency    TEXT NOT NULL DEFAULT 'KES',
  recipient_amount_minor TEXT NOT NULL,
  crypto_amount_minor   TEXT NOT NULL,
  network_fee_minor     TEXT NOT NULL,
  service_fee_minor     TEXT NOT NULL,
  total_debit_minor     TEXT NOT NULL,
  fx_rate_scaled        TEXT NOT NULL,
  mid_rate_scaled       TEXT NOT NULL,
  fee_snapshot          TEXT NOT NULL,
  route_snapshot        TEXT NOT NULL,
  deposit_address       TEXT,
  deposit_memo          TEXT,
  deposit_expires_at    TEXT,
  liquidity_reservation_id TEXT,
  -- FUNDED once KES float is reserved; WAITING_FLOAT when the payout must wait
  -- for a treasury top-up (never reported as a success to the user).
  settlement_state      TEXT NOT NULL DEFAULT 'FUNDED',
  risk_score            INTEGER NOT NULL DEFAULT 0,
  risk_level            TEXT NOT NULL DEFAULT 'LOW',
  risk_decision         TEXT NOT NULL DEFAULT 'AUTO_APPROVE',
  risk_json             TEXT,
  compliance_case_id    TEXT,
  strong_confirmation   INTEGER NOT NULL DEFAULT 0,
  mode                  TEXT NOT NULL,
  data_origin           TEXT NOT NULL DEFAULT 'sandbox',
  failure_code          TEXT,
  failure_message       TEXT,
  failure_recovery      TEXT,
  receipt_id            TEXT,
  amount_kes_real       REAL NOT NULL DEFAULT 0,
  amount_usd_real       REAL NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  expires_at            TEXT,
  completed_at          TEXT,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS intents_user_idx ON payment_intents(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS intents_status_idx ON payment_intents(status, updated_at);
CREATE INDEX IF NOT EXISTS intents_business_idx ON payment_intents(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS intents_worker_idx ON payment_intents(status, updated_at);

CREATE TABLE IF NOT EXISTS payment_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_intent_id TEXT NOT NULL,
  from_state        TEXT,
  to_state          TEXT NOT NULL,
  actor             TEXT NOT NULL,
  note              TEXT,
  metadata          TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payment_events_pi_idx ON payment_events(payment_intent_id, id);

CREATE TABLE IF NOT EXISTS payments (
  id                TEXT PRIMARY KEY,
  payment_intent_id TEXT NOT NULL,
  kind              TEXT NOT NULL,             -- CRYPTO_DEPOSIT | INTERNAL_TRANSFER | LINK_DEPOSIT
  asset             TEXT NOT NULL,
  network           TEXT NOT NULL,
  status            TEXT NOT NULL,
  amount_minor      TEXT NOT NULL,
  expected_minor    TEXT NOT NULL,
  tx_hash           TEXT,
  from_address      TEXT,
  to_address        TEXT,
  confirmations     INTEGER NOT NULL DEFAULT 0,
  confirmations_required INTEGER NOT NULL,
  block_height      TEXT,
  block_hash        TEXT,
  detected_at       TEXT,
  finalized_at      TEXT,
  data_origin       TEXT NOT NULL DEFAULT 'sandbox',
  raw               TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_intent_idx ON payments(payment_intent_id);

CREATE TABLE IF NOT EXISTS blockchain_transactions (
  id            TEXT PRIMARY KEY,
  payment_id    TEXT,
  network       TEXT NOT NULL,
  tx_hash       TEXT NOT NULL,
  from_address  TEXT,
  to_address    TEXT,
  asset         TEXT NOT NULL,
  amount_minor  TEXT NOT NULL,
  block_height  TEXT,
  confirmations INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  confirmed_at  TEXT,
  data_origin   TEXT NOT NULL DEFAULT 'sandbox',
  raw           TEXT,
  UNIQUE (network, tx_hash)
);

CREATE TABLE IF NOT EXISTS payouts (
  id                 TEXT PRIMARY KEY,
  payment_intent_id  TEXT NOT NULL,
  reference          TEXT NOT NULL UNIQUE,
  provider           TEXT NOT NULL,
  rail               TEXT NOT NULL,
  currency           TEXT NOT NULL DEFAULT 'KES',
  amount_minor       TEXT NOT NULL,
  fee_minor          TEXT NOT NULL DEFAULT '0',
  recipient_snapshot TEXT NOT NULL,
  state              TEXT NOT NULL,
  provider_reference TEXT,
  phone              TEXT,
  external_id        TEXT,
  attempts           INTEGER NOT NULL DEFAULT 0,
  next_retry_at      TEXT,
  submitted_at       TEXT,
  confirmed_at       TEXT,
  failure_code       TEXT,
  failure_message    TEXT,
  data_origin        TEXT NOT NULL DEFAULT 'sandbox',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payouts_intent_idx ON payouts(payment_intent_id);
CREATE INDEX IF NOT EXISTS payouts_worker_idx ON payouts(state, next_retry_at);

CREATE TABLE IF NOT EXISTS refunds (
  id                TEXT PRIMARY KEY,
  reference         TEXT NOT NULL UNIQUE,
  payment_intent_id TEXT NOT NULL,
  payout_id         TEXT,
  amount_minor      TEXT NOT NULL,
  crypto_amount_minor TEXT NOT NULL,
  asset             TEXT NOT NULL,
  currency          TEXT NOT NULL,
  destination       TEXT NOT NULL,
  method            TEXT NOT NULL,           -- BALANCE_CREDIT | RAIL_REVERSAL | MANUAL_REQUEST
  state             TEXT NOT NULL,           -- REFUND_STATES
  reason            TEXT,
  reason_code       TEXT,
  automation        TEXT NOT NULL DEFAULT 'MANUAL',  -- AUTO | MANUAL (who can move it)
  recovery_state    TEXT NOT NULL DEFAULT 'NONE',    -- NONE | PENDING | RECOVERED | WRITTEN_OFF
  requested_by      TEXT,
  approved_by       TEXT,
  provider_reference TEXT,
  ledger_journal_id TEXT,
  data_origin       TEXT NOT NULL DEFAULT 'live',
  note              TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  completed_at      TEXT
);
CREATE INDEX IF NOT EXISTS refunds_intent_idx ON refunds(payment_intent_id, created_at DESC);

-- ─────────────────────────────────────────────────────── history view ──────
CREATE TABLE IF NOT EXISTS transactions (
  id                 TEXT PRIMARY KEY,
  reference          TEXT NOT NULL,
  user_id            TEXT REFERENCES users(id),
  business_id        TEXT,
  payment_intent_id  TEXT,
  kind               TEXT NOT NULL,
  direction          TEXT NOT NULL,
  status             TEXT NOT NULL,
  state              TEXT NOT NULL,
  asset              TEXT NOT NULL,
  network            TEXT,
  amount_minor       TEXT NOT NULL,
  crypto_amount_minor TEXT NOT NULL,
  fx_rate_scaled     TEXT,
  fee_minor          TEXT NOT NULL DEFAULT '0',
  recipient_label    TEXT NOT NULL,
  recipient_handle   TEXT,
  merchant_name      TEXT,
  counterparty_user_id TEXT,
  receipt_id         TEXT,
  mode               TEXT NOT NULL,
  amount_kes_real    REAL NOT NULL DEFAULT 0,
  amount_usd_real    REAL NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  completed_at       TEXT
);
CREATE INDEX IF NOT EXISTS tx_user_idx ON transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tx_status_idx ON transactions(user_id, status);

CREATE TABLE IF NOT EXISTS receipts (
  id                TEXT PRIMARY KEY,
  reference         TEXT NOT NULL UNIQUE,
  payment_intent_id TEXT NOT NULL UNIQUE,
  payload           TEXT NOT NULL,           -- the full receipt document (JSON snapshot)
  content_sha256    TEXT NOT NULL,           -- integrity hash of the payload
  mode              TEXT NOT NULL,
  data_origin       TEXT NOT NULL DEFAULT 'sandbox',
  status            TEXT NOT NULL DEFAULT 'ISSUED',   -- ISSUED | REISSUED | VOID
  share_token       TEXT,
  share_expires_at  TEXT,
  shared_at         TEXT,
  share_accessed_at TEXT,
  delivery          TEXT,                    -- { inApp, email, whatsapp… } delivery log
  issued_at         TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- ────────────────────────────────────────────────────── ledger (2-sided) ───
CREATE TABLE IF NOT EXISTS ledger_accounts (
  code         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL,                -- ASSET | LIABILITY | EQUITY | REVENUE | EXPENSE
  owner        TEXT NOT NULL,                -- USER | TREASURY | SETTLEMENT | FEE | PROVIDER | EXTERNAL
  asset        TEXT,
  currency     TEXT,
  user_id      TEXT,
  business_id  TEXT,
  normal_side  TEXT NOT NULL,                -- DEBIT | CREDIT
  status       TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_accounts_owner_idx ON ledger_accounts(owner, user_id);

CREATE TABLE IF NOT EXISTS ledger_journals (
  id                TEXT PRIMARY KEY,
  journal_group     TEXT NOT NULL,
  type              TEXT NOT NULL,           -- STANDARD | CONVERSION
  asset             TEXT,                    -- primary asset (STANDARD journals)
  from_asset        TEXT,                    -- CONVERSION journals
  to_asset          TEXT,
  rate_scaled       TEXT,                    -- executed conversion rate (to per from, *1e12)
  gross_to_minor    TEXT,                    -- gross to_asset debited by the conversion
  tolerance_minor   TEXT,                    -- drift the quote allowed, used by verify()
  pnl_minor         TEXT,                    -- realized margin/loss, denominated in to_asset
  pnl_asset         TEXT,
  payment_intent_id TEXT,
  payout_id         TEXT,
  refund_id         TEXT,
  memo              TEXT,
  occurred_at       TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_journals_group_idx ON ledger_journals(journal_group);
CREATE INDEX IF NOT EXISTS ledger_journals_intent_idx ON ledger_journals(payment_intent_id);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id                TEXT PRIMARY KEY,           -- journal_id_seq; rowid preserves insertion order
  journal_id        TEXT NOT NULL,
  seq               INTEGER NOT NULL,
  account_code      TEXT NOT NULL REFERENCES ledger_accounts(code),
  direction         TEXT NOT NULL,           -- DEBIT | CREDIT
  asset             TEXT NOT NULL,
  amount_minor      TEXT NOT NULL,
  payment_intent_id TEXT,
  payout_id         TEXT,
  refund_id         TEXT,
  code              TEXT NOT NULL,           -- USER_CRYPTO_DEBIT, TREASURY_KES_DEBIT, ...
  memo              TEXT,
  occurred_at       TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  reverses_entry_id TEXT,
  is_adjustment     INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_unique_idx ON ledger_entries(journal_id, seq);
CREATE INDEX IF NOT EXISTS ledger_entries_account_idx ON ledger_entries(account_code, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ledger_entries_intent_idx ON ledger_entries(payment_intent_id);

-- ────────────────────────────────────────────────────────── liquidity ──────
CREATE TABLE IF NOT EXISTS liquidity_accounts (
  id                   TEXT PRIMARY KEY,
  provider             TEXT NOT NULL,
  rail                 TEXT NOT NULL,
  currency             TEXT NOT NULL,
  country              TEXT NOT NULL,
  label                TEXT,
  available_minor      TEXT NOT NULL,
  reserved_minor       TEXT NOT NULL DEFAULT '0',
  pending_payout_minor TEXT NOT NULL DEFAULT '0',
  float_target_minor   TEXT NOT NULL,
  health               TEXT NOT NULL DEFAULT 'HEALTHY',
  data_origin          TEXT NOT NULL DEFAULT 'sandbox',
  updated_at           TEXT NOT NULL,
  UNIQUE (provider, rail, currency)
);

CREATE TABLE IF NOT EXISTS liquidity_events (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES liquidity_accounts(id),
  direction     TEXT NOT NULL,               -- IN | OUT | RESERVE | RELEASE | CONSUME | PENDING
  amount_minor  TEXT NOT NULL,
  reason        TEXT,
  actor         TEXT,
  payment_intent_id TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS liquidity_events_account_idx ON liquidity_events(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS liquidity_reservations (
  id                  TEXT PRIMARY KEY,
  liquidity_account_id TEXT NOT NULL,
  payment_intent_id   TEXT NOT NULL,
  amount_minor        TEXT NOT NULL,
  status              TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  consumed_at         TEXT,
  released_at         TEXT
);
CREATE INDEX IF NOT EXISTS liq_res_intent_idx ON liquidity_reservations(payment_intent_id);

CREATE TABLE IF NOT EXISTS provider_accounts (
  id             TEXT PRIMARY KEY,
  provider       TEXT NOT NULL,
  kind           TEXT NOT NULL,
  label          TEXT,
  currency       TEXT,
  country        TEXT,
  balance_minor  TEXT,
  config_enc     TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  configured     INTEGER NOT NULL DEFAULT 0,
  operational    INTEGER NOT NULL DEFAULT 1,
  success_rate_bps INTEGER NOT NULL DEFAULT 10000,
  latency_p50_ms INTEGER NOT NULL DEFAULT 0,
  error_rate_bps INTEGER NOT NULL DEFAULT 0,
  health_note    TEXT,
  data_origin    TEXT NOT NULL DEFAULT 'sandbox',
  last_checked_at TEXT,
  updated_at     TEXT NOT NULL
);

-- ──────────────────────────────────────────────────────── links / qr ───────
CREATE TABLE IF NOT EXISTS payment_links (
  id                TEXT PRIMARY KEY,
  token             TEXT NOT NULL UNIQUE,
  user_id           TEXT REFERENCES users(id),
  business_id       TEXT REFERENCES businesses(id),
  title             TEXT NOT NULL,
  description       TEXT,
  amount_minor      TEXT,
  currency          TEXT NOT NULL DEFAULT 'KES',
  reference         TEXT,
  accepted_assets   TEXT NOT NULL,
  settlement_rail   TEXT NOT NULL,
  settlement_target TEXT,
  allow_payer_amount INTEGER NOT NULL DEFAULT 1,
  allow_repeat      INTEGER NOT NULL DEFAULT 0,
  max_uses          INTEGER,
  uses              INTEGER NOT NULL DEFAULT 0,
  collected_minor   TEXT NOT NULL DEFAULT '0',
  status            TEXT NOT NULL DEFAULT 'ACTIVE',
  success_url       TEXT,
  cancel_url        TEXT,
  public_note       TEXT,
  expires_at        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS qr_codes (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL,               -- MERCHANT_DYNAMIC | MERCHANT_STATIC | AMOUNT | REQUEST | LINK
  user_id       TEXT REFERENCES users(id),
  business_id   TEXT REFERENCES businesses(id),
  payment_link_id TEXT,
  label         TEXT,
  amount_minor  TEXT,
  currency      TEXT NOT NULL DEFAULT 'KES',
  payload       TEXT NOT NULL,
  accepted_assets TEXT NOT NULL,
  settlement_rail TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'ACTIVE',
  scans         INTEGER NOT NULL DEFAULT 0,
  pays          INTEGER NOT NULL DEFAULT 0,
  last_scanned_at TEXT,
  expires_at    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- ────────────────────────────────────────────────────── compliance ─────────
CREATE TABLE IF NOT EXISTS compliance_cases (
  id                TEXT PRIMARY KEY,
  reference         TEXT NOT NULL UNIQUE,
  kind              TEXT NOT NULL,
  status            TEXT NOT NULL,
  risk_level        TEXT NOT NULL,
  priority          INTEGER NOT NULL DEFAULT 2,
  subject           TEXT NOT NULL,
  user_id           TEXT,
  business_id       TEXT,
  payment_intent_id TEXT,
  assigned_to       TEXT,
  sla_hours         INTEGER NOT NULL DEFAULT 24,
  due_at            TEXT,
  opened_at         TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  closed_at         TEXT,
  outcome           TEXT,
  data_origin       TEXT NOT NULL DEFAULT 'sandbox'
);
CREATE INDEX IF NOT EXISTS cases_status_idx ON compliance_cases(status, priority, due_at);

CREATE TABLE IF NOT EXISTS compliance_case_notes (
  id         TEXT PRIMARY KEY,
  case_id    TEXT NOT NULL REFERENCES compliance_cases(id),
  author     TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS risk_events (
  id                TEXT PRIMARY KEY,
  user_id           TEXT,
  payment_intent_id TEXT,
  rule              TEXT NOT NULL,
  score_delta       INTEGER NOT NULL,
  level             TEXT NOT NULL,
  action            TEXT,
  detail            TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS risk_events_user_idx ON risk_events(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS watchlist_entries (
  id         TEXT PRIMARY KEY,
  pattern    TEXT NOT NULL,
  list_id    TEXT NOT NULL,
  note       TEXT,
  added_by   TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallet_screenings (
  id         TEXT PRIMARY KEY,
  address    TEXT NOT NULL,
  network    TEXT NOT NULL,
  provider   TEXT NOT NULL,
  result     TEXT NOT NULL,
  risk_score INTEGER NOT NULL,
  exposure   TEXT,
  checked_at TEXT NOT NULL,
  data_origin TEXT NOT NULL DEFAULT 'sandbox',
  UNIQUE (network, address)
);

-- ─────────────────────────────────────────────────── comms / platform ──────
CREATE TABLE IF NOT EXISTS notifications (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  channel           TEXT NOT NULL DEFAULT 'in_app',
  severity          TEXT NOT NULL DEFAULT 'info',
  link              TEXT,
  payment_intent_id TEXT,
  read_at           TEXT,
  delivered_at      TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS message_log (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  channel    TEXT NOT NULL,
  recipient  TEXT NOT NULL,
  template   TEXT NOT NULL,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL,
  provider   TEXT NOT NULL,
  error      TEXT,
  data_origin TEXT NOT NULL DEFAULT 'sandbox',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id            TEXT PRIMARY KEY,
  actor_user_id TEXT,
  actor_type    TEXT NOT NULL,               -- USER | ADMIN | SYSTEM | API_KEY | PARTNER
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  ip            TEXT,
  user_agent    TEXT,
  metadata      TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_target_idx ON audit_logs(target_type, target_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id               TEXT PRIMARY KEY,
  user_id          TEXT REFERENCES users(id),
  business_id      TEXT REFERENCES businesses(id),
  name             TEXT NOT NULL,
  environment      TEXT NOT NULL,            -- test | live
  publishable_key  TEXT NOT NULL UNIQUE,
  secret_hash      TEXT NOT NULL,
  secret_hint      TEXT NOT NULL,
  scopes           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'ACTIVE',
  last_used_at     TEXT,
  created_at       TEXT NOT NULL,
  revoked_at       TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  device_id   TEXT,
  token_hash  TEXT UNIQUE,
  csrf_token  TEXT NOT NULL,
  auth_method TEXT NOT NULL DEFAULT 'password',
  ip          TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id, expires_at);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  code_hash  TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  name         TEXT NOT NULL,
  platform     TEXT,
  fingerprint  TEXT NOT NULL,
  last_ip      TEXT,
  city         TEXT,
  trusted      INTEGER NOT NULL DEFAULT 0,
  anomaly      INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at   TEXT,
  UNIQUE (user_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id             TEXT PRIMARY KEY,
  key            TEXT NOT NULL,
  user_id        TEXT,
  scope          TEXT NOT NULL,
  request_hash   TEXT NOT NULL,
  response_code  INTEGER,
  response_body  TEXT,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  UNIQUE (key, scope)
);

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id                TEXT PRIMARY KEY,
  user_id           TEXT,
  business_id       TEXT,
  environment       TEXT NOT NULL DEFAULT 'test',
  url               TEXT NOT NULL,
  description       TEXT,
  secret_enc        TEXT NOT NULL,
  secret_hint       TEXT NOT NULL,
  events            TEXT NOT NULL,
  api_version       TEXT NOT NULL DEFAULT '2026-01',
  status            TEXT NOT NULL DEFAULT 'ACTIVE',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_delivery_at  TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhooks (
  id                TEXT PRIMARY KEY,
  event_id          TEXT NOT NULL UNIQUE,
  type              TEXT NOT NULL,
  api_version       TEXT NOT NULL DEFAULT '2026-01',
  live_mode         INTEGER NOT NULL DEFAULT 0,
  payment_intent_id TEXT,
  endpoint_scope    TEXT,
  payload           TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS webhooks_created_idx ON webhooks(created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id             TEXT PRIMARY KEY,
  endpoint_id    TEXT NOT NULL,
  webhook_id     TEXT NOT NULL,
  event_id       TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  attempt        INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL,
  http_status    INTEGER,
  duration_ms    INTEGER,
  response_snippet TEXT,
  error          TEXT,
  next_retry_at  TEXT,
  delivered_at   TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deliveries_idx ON webhook_deliveries(endpoint_id, created_at DESC);

-- ─────────────────────────────────────────────────────────── jobs / ops ────
CREATE TABLE IF NOT EXISTS job_queue (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  payload      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'READY',
  dedupe_key   TEXT UNIQUE,
  run_at       TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 6,
  last_error   TEXT,
  locked_by    TEXT,
  locked_at    TEXT,
  finished_at  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS job_queue_ready_idx ON job_queue(status, run_at);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'string',
  description TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics_snapshots (
  id         TEXT PRIMARY KEY,
  bucket     TEXT NOT NULL,
  name       TEXT NOT NULL,
  value      REAL NOT NULL,
  labels     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS metrics_bucket_idx ON metrics_snapshots(name, bucket DESC);

CREATE TABLE IF NOT EXISTS sandbox_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  corridor   TEXT,
  amount_usd REAL,
  rail       TEXT,
  asset      TEXT,
  outcome    TEXT NOT NULL DEFAULT 'settled',
  latency_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sandbox_events_idx ON sandbox_events(created_at DESC);

-- ─────────────────────────────────────────────────── append-only guards ────
-- Money history cannot be rewritten: corrections are compensating entries.
--
-- seed_lock exists for one narrow, auditable purpose: the sandbox demo corpus
-- backdates *timestamps* so the dashboard has a believable history. It never
-- relaxes the guards for amounts, states or directions, and withSeedBypass()
-- refuses to arm it outside sandbox mode. A production database can therefore
-- not reach this path at all — the armed lock is itself written to audit_logs.
CREATE TABLE IF NOT EXISTS seed_lock (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  reason   TEXT NOT NULL,
  armed_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS ledger_entries_no_update
BEFORE UPDATE ON ledger_entries
WHEN (SELECT COUNT(*) FROM seed_lock) = 0
BEGIN SELECT RAISE(ABORT, 'ledger_entries is append-only: use a compensating entry'); END;

CREATE TRIGGER IF NOT EXISTS ledger_entries_no_delete
BEFORE DELETE ON ledger_entries
WHEN (SELECT COUNT(*) FROM seed_lock) = 0
BEGIN SELECT RAISE(ABORT, 'ledger_entries is append-only: historical entries cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS payment_events_no_update
BEFORE UPDATE ON payment_events
WHEN (SELECT COUNT(*) FROM seed_lock) = 0
BEGIN SELECT RAISE(ABORT, 'payment_events is append-only'); END;

CREATE TRIGGER IF NOT EXISTS audit_logs_no_update
BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;

CREATE TRIGGER IF NOT EXISTS audit_logs_no_delete
BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`;

/**
 * Sanity invariants we rely on at runtime. Kept next to the DDL so a schema
 * change and its guard cannot drift apart.
 */
export const SCHEMA_VERSION = '0001_initial';
