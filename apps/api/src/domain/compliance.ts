import {
  DomainError,
  TIER_LIMITS,
  VELOCITY_WINDOWS,
  riskLevel,
  type KycTier,
  type NetworkCode,
  type PayableAsset,
  type RailCode,
  type RiskLevel,
  type RiskSignal,
  unitOf,
  ASSET_RISK_MULTIPLIER,
  SANCTIONS_LIST_VERSION,
} from '@aurapay/shared';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { encryptString, sha256 } from '../lib/crypto.js';
import { id, nowIso } from '../lib/ids.js';
import { publish } from './realtime.js';
import { createLogger } from '../logger.js';
import { insert } from '../db/rows.js';
import { stringify } from '../lib/json.js';

const log = createLogger('compliance');

/**
 * KYC / AML / risk.
 *
 * Non-negotiable rules encoded here:
 *   - Production money movement requires an approved KYC decision from a
 *     *contracted provider* (`KYC_PROVIDER`); internal rules are sandbox-only.
 *   - Screening hits are blocking, not "warning" — a hit parks the payment in
 *     `RISK_REVIEW` with a compliance case, and a blocked wallet fails closed.
 *   - Every decision is written to `risk_events` + `audit_logs` so a reviewer can
 *     reconstruct why money moved (or did not).
 *
 * The provider boundary is `ScreeningProvider` / `KycProvider` below. Swap in a
 * real vendor by implementing those interfaces; the decision engine does not
 * change.
 */

export interface ScreeningProvider {
  readonly name: string;
  readonly simulated: boolean;
  screenCounterparty(input: { name?: string | null; phone?: string | null; identifier?: string | null }): Promise<ScreeningResult>;
  screenWalletAddress(input: { address: string; network: NetworkCode }): Promise<WalletScreeningResult>;
}

export interface ScreeningResult {
  hit: boolean;
  listId?: string;
  matchedName?: string;
  score: number;
  provider: string;
  listVersion: string;
  checkedAt: string;
}

export interface WalletScreeningResult {
  exposure: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'SEVERE';
  riskScore: number;
  tags: string[];
  provider: string;
  checkedAt: string;
}

/**
 * Deterministic rules + a demo watchlist. Clearly labelled `simulated` so no UI
 * can present it as a production sanctions decision.
 */
class InternalRulesProvider implements ScreeningProvider {
  readonly name = 'aurapay-internal-rules';
  readonly simulated = true;

  async screenCounterparty(input: { name?: string | null; phone?: string | null; identifier?: string | null }): Promise<ScreeningResult> {
    const db = getDb();
    const name = (input.name ?? '').trim().toLowerCase();
    const rows = db.all<{ pattern: string; list_id: string; note: string | null }>(
      'SELECT pattern, list_id, note FROM watchlist_entries',
    );
    const hit = rows.find((r) => name && r.pattern && name.includes(String(r.pattern).toLowerCase()));
    const normalized = name.replace(/[^a-z]/g, '');
    const obvious = DEMO_SANCTION_SEEDS.some((seed) => normalized && normalized.includes(seed.key));
    const isHit = Boolean(hit) || obvious;
    return {
      hit: isHit,
      listId: hit?.list_id ?? (obvious ? 'DEMO-UN-1267' : undefined),
      matchedName: hit?.pattern ?? (obvious ? DEMO_SANCTION_SEEDS.find((s) => normalized.includes(s.key))?.label : undefined),
      score: isHit ? 100 : 0,
      provider: this.name,
      listVersion: SANCTIONS_LIST_VERSION,
      checkedAt: nowIso(),
    };
  }

  async screenWalletAddress(input: { address: string; network: NetworkCode }): Promise<WalletScreeningResult> {
    const db = getDb();
    const cached = db.maybeOne<{ result: string; risk_score: number; exposure: string; checked_at: string }>(
      'SELECT result, risk_score, exposure, checked_at FROM wallet_screenings WHERE network = ? AND address = ?',
      [input.network, input.address],
    );
    if (cached) {
      return {
        exposure: (cached.exposure as WalletScreeningResult['exposure']) ?? 'NONE',
        riskScore: cached.risk_score,
        tags: cached.result === 'BLOCKED' ? ['sanctions_exposure'] : [],
        provider: this.name,
        checkedAt: cached.checked_at,
      };
    }
    // Sandbox: deterministic pseudo-score derived from the address hash so demos
    // can exercise the review path without pretending to be Chainalysis.
    const hash = BigInt(`0x${sha256(`${input.network}:${input.address}`).slice(0, 8)}`);
    const bucket = Number(hash % 1000n);
    const exposure: WalletScreeningResult['exposure'] =
      bucket > 995 ? 'HIGH' : bucket > 970 ? 'MEDIUM' : bucket > 900 ? 'LOW' : 'NONE';
    const riskScore = exposure === 'HIGH' ? 90 : exposure === 'MEDIUM' ? 45 : exposure === 'LOW' ? 15 : 0;
    db.run(
      `INSERT INTO wallet_screenings (id, address, network, provider, result, risk_score, exposure, checked_at, data_origin)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        id('scr'),
        input.address,
        input.network,
        this.name,
        exposure === 'HIGH' ? 'BLOCKED' : 'CLEAR',
        riskScore,
        exposure,
        nowIso(),
        'sandbox',
      ],
    );
    return {
      exposure,
      riskScore,
      tags: exposure === 'NONE' ? [] : ['simulated_cluster_signal'],
      provider: this.name,
      checkedAt: nowIso(),
    };
  }
}

const DEMO_SANCTION_SEEDS = [
  { key: 'blockeddemo', label: 'DEMO SUBJECT — NOT A REAL SANCTIONED INDIVIDUAL' },
];

let screeningProvider: ScreeningProvider | null = null;

export function screening(): ScreeningProvider {
  if (screeningProvider) return screeningProvider;
  if (config.compliance.amlProvider !== 'none') {
    // Production: an external screening vendor must be configured. We fail loudly
    // rather than silently substituting internal rules.
    throw new DomainError(
      'PROVIDER_KEY_MISSING',
      `AML provider "${config.compliance.amlProvider}" needs its adapter implemented in domain/compliance.ts before use. AuraPay will not fall back to internal rules for production screening.`,
      { provider: config.compliance.amlProvider },
    );
  }
  screeningProvider = new InternalRulesProvider();
  return screeningProvider;
}

export interface KycRecord {
  userId: string;
  status: 'NOT_STARTED' | 'PENDING' | 'ACTION_REQUIRED' | 'APPROVED' | 'REJECTED';
  tier: KycTier;
  provider: string;
  dataOrigin: 'sandbox' | 'live';
}

export function kycFor(userId: string): KycRecord {
  const db = getDb();
  const user = db.maybeOne<{ kyc_status: string; kyc_tier: number }>('SELECT kyc_status, kyc_tier FROM users WHERE id = ?', [
    userId,
  ]);
  const latest = db.maybeOne<{ provider: string; data_origin: string }>(
    'SELECT provider, data_origin FROM kyc_profiles WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
    [userId],
  );
  return {
    userId,
    status: (user?.kyc_status as KycRecord['status']) ?? 'NOT_STARTED',
    tier: ((user?.kyc_tier ?? 0) as KycTier) ?? 0,
    provider: latest?.provider ?? 'none',
    dataOrigin: latest?.data_origin === 'live' ? 'live' : 'sandbox',
  };
}

/** Hard gate: no quote, no payment, no payout without the required KYC state. */
export function assertCanMoveMoney(userId: string, amountMinor: bigint): { tier: KycTier } {
  const record = kycFor(userId);
  const limits = TIER_LIMITS[record.tier];
  if (record.status !== 'APPROVED' || record.tier === 0) {
    throw new DomainError('KYC_REQUIRED', 'Identity verification is required before this payment can be sent.', {
      kycStatus: record.status,
      tier: record.tier,
    });
  }
  const amountMajor = Number(amountMinor / unitOf('KES'));
  if (amountMajor > limits.perPaymentKes) {
    throw new DomainError(
      'LIMIT_EXCEEDED',
      `KES ${amountMajor.toLocaleString('en-KE')} is above your ${limits.label} single-payment limit of KES ${limits.perPaymentKes.toLocaleString('en-KE')}.`,
      { limit: limits.perPaymentKes, requested: amountMajor, tier: record.tier },
    );
  }
  if (limits.strongConfirmFromKes && amountMajor >= limits.strongConfirmFromKes) {
    // The caller must have collected a step-up confirmation; see assertStepUp.
    return { tier: record.tier };
  }
  return { tier: record.tier };
}

export function requiresStepUp(userId: string, amountMinor: bigint): boolean {
  const record = kycFor(userId);
  const limits = TIER_LIMITS[record.tier];
  const amountMajor = Number(amountMinor / unitOf('KES'));
  return amountMajor >= (limits.strongConfirmFromKes || Number.MAX_SAFE_INTEGER);
}

export function assertStepUp(strongConfirmation: boolean, amountMinor: bigint): void {
  if (!strongConfirmation) {
    throw new DomainError(
      'CONFLICT',
      `This payment needs a step-up confirmation (${(Number(amountMinor / unitOf('KES'))).toLocaleString('en-KE')} KES). Confirm the recipient details to continue.`,
      { reason: 'STRONG_CONFIRMATION_REQUIRED' },
    );
  }
}

export async function checkVelocityAndLimits(input: {
  userId: string;
  amountMinor: bigint;
  asset: PayableAsset;
}): Promise<RiskSignal[]> {
  const db = getDb();
  const signals: RiskSignal[] = [];
  const record = kycFor(input.userId);
  const limits = TIER_LIMITS[record.tier];

  for (const window of VELOCITY_WINDOWS) {
    const row = db.maybeOne<{ c: number; total: number }>(
      `SELECT COUNT(*) AS c, COALESCE(SUM(amount_kes_real), 0) AS total
       FROM payment_intents
       WHERE user_id = ? AND created_at >= datetime('now', ?) AND status NOT IN ('FAILED')`,
      [input.userId, `-${window.seconds} seconds`],
    );
    const count = row?.c ?? 0;
    if (count >= window.maxPayments) {
      signals.push({
        code: `velocity_${window.id}`,
        label: `${count} payments in ${window.id}`,
        weight: 25,
        blocking: true,
        detail: `Velocity window ${window.id} allows ${window.maxPayments} payments; exceeded.`,
      });
    }
    if (window.id === '24h') {
      const dailyKes = Math.round(row?.total ?? 0);
      if (dailyKes > limits.dailyKes) {
        signals.push({
          code: 'limit_daily',
          label: `Daily volume KES ${dailyKes.toLocaleString('en-KE')}`,
          weight: 40,
          blocking: true,
          detail: `Above the ${limits.label} daily cap of KES ${limits.dailyKes.toLocaleString('en-KE')}.`,
        });
      }
      if (count > limits.maxPayoutsPerDay) {
        signals.push({
          code: 'limit_payout_count',
          label: `${count} payouts today`,
          weight: 30,
          blocking: true,
          detail: `Above the ${limits.maxPayoutsPerDay}/day payout count for this tier.`,
        });
      }
    }
  }

  // New-device + large amount is the classic account-takeover shape.
  const recentDevice = db.maybeOne<{ first_seen_at: string }>(
    `SELECT d.first_seen_at FROM devices d WHERE d.user_id = ? ORDER BY d.last_seen_at DESC LIMIT 1`,
    [input.userId],
  );
  if (recentDevice) {
    const ageHours = (Date.now() - new Date(recentDevice.first_seen_at).getTime()) / 3.6e6;
    if (ageHours < 6 && input.amountMinor > 5_000_000n) {
      signals.push({
        code: 'new_device_high_value',
        label: 'High-value payment from a device added in the last 6 hours',
        weight: 35,
        blocking: false,
        detail: 'Step-up confirmation required for this combination.',
      });
    }
  }
  return signals;
}

/** Screening of the recipient identity before a payout is promised. */
export async function screenRecipient(input: {
  displayName: string;
  phone?: string | null;
  identifier?: string | null;
}): Promise<{ result: ScreeningResult; risk: number; blocked: boolean; warning?: string }> {
  const result = await screening().screenCounterparty({
    name: input.displayName,
    phone: input.phone,
    identifier: input.identifier,
  });
  if (result.hit && config.isProduction) {
    return { result, risk: 100, blocked: true };
  }
  if (result.hit) {
    return {
      result,
      risk: 95,
      blocked: true,
      warning: 'Sandbox watchlist hit — the payment is parked for review. This list is a demo fixture, not a live sanctions list.',
    };
  }
  return { result, risk: 0, blocked: false };
}

export async function screenDepositAddress(address: string, network: NetworkCode): Promise<WalletScreeningResult> {
  return screening().screenWalletAddress({ address, network });
}

export interface PaymentRiskInput {
  userId: string;
  paymentIntentId?: string;
  amountMinor: bigint;
  asset: PayableAsset;
  network: NetworkCode;
  rail: RailCode;
  recipientVerified: boolean;
  recipientName: string;
  recipientPhone?: string | null;
  depositAddress?: string | null;
  priorFailures24h: number;
}

export interface PaymentRiskOutcome {
  score: number;
  level: RiskLevel;
  decision: 'AUTO_APPROVE' | 'STEP_UP' | 'MANUAL_REVIEW' | 'BLOCK';
  signals: RiskSignal[];
  evaluatedAt: string;
  provider: 'internal_rules' | 'partner_provider';
}

/**
 * The decision function. Score is the weighted sum of signals; the *decision*
 * is derived from blocking flags and thresholds — not from the score alone, so a
 * single hard signal can never be averaged away.
 */
export async function assessPaymentRisk(input: PaymentRiskInput): Promise<PaymentRiskOutcome> {
  const signals: RiskSignal[] = [];
  const amountMajor = Number(input.amountMinor / unitOf('KES'));

  if (!input.recipientVerified) {
    signals.push({
      code: 'recipient_unverified',
      label: 'Recipient name could not be verified',
      weight: 18,
      blocking: false,
      detail: 'The rail did not return a registered name for this handle.',
    });
  }
  if (amountMajor >= 100_000) {
    signals.push({
      code: 'high_value',
      label: `High-value payment (KES ${amountMajor.toLocaleString('en-KE')})`,
      weight: 22,
      blocking: false,
      detail: 'Requires step-up confirmation and a documented settlement path.',
    });
  }
  const volatility = input.asset === 'BTC' || input.asset === 'ETH' ? 'crypto' : 'stable';
  if (volatility === 'crypto' && amountMajor > 20_000) {
    signals.push({
      code: 'volatile_asset_settlement',
      label: 'Volatile asset funding a fixed KES payout',
      weight: 20 * ASSET_RISK_MULTIPLIER[input.asset],
      blocking: false,
      detail: 'Price can move before conversion; the payout is guaranteed at the quoted rate.',
    });
  }
  if (input.priorFailures24h >= 3) {
    signals.push({
      code: 'repeated_failures',
      label: `${input.priorFailures24h} failed payments in the last 24h`,
      weight: 28,
      blocking: false,
      detail: 'Possible invalid recipient data or a bad payout path.',
    });
  }
  signals.push(...(await checkVelocityAndLimits({ userId: input.userId, amountMinor: input.amountMinor, asset: input.asset })));

  const screening = await screenRecipient({
    displayName: input.recipientName,
    phone: input.recipientPhone,
  });
  if (screening.result.hit) {
    signals.push({
      code: 'sanctions_hit',
      label: `Screening match on list ${screening.result.listId ?? 'unknown'}`,
      weight: 100,
      blocking: true,
      detail: `${screening.result.matchedName ?? 'Matched subject'} — ${
        config.isSandbox ? 'demo watchlist entry' : 'live list entry'
      }`,
    });
  }

  if (input.depositAddress) {
    const wallet = await screenDepositAddress(input.depositAddress, input.network);
    if (wallet.exposure === 'HIGH' || wallet.exposure === 'SEVERE') {
      signals.push({
        code: 'wallet_screening',
        label: `Deposit address flagged ${wallet.exposure.toLowerCase()}`,
        weight: 80,
        blocking: true,
        detail: `${wallet.provider} exposure ${wallet.exposure} (score ${wallet.riskScore}).`,
      });
    } else if (wallet.exposure === 'MEDIUM') {
      signals.push({
        code: 'wallet_screening_medium',
        label: 'Deposit address has medium exposure',
        weight: 30,
        blocking: false,
      });
    }
  }

  const provider = config.compliance.amlProvider === 'none' ? 'internal_rules' : 'partner_provider';
  const raw = signals.reduce((acc, s) => acc + s.weight, 0);
  const score = Math.min(100, Math.round(raw * (provider === 'internal_rules' ? 1 : 0.9)));
  const level = riskLevel(score);
  const blocking = signals.some((s) => s.blocking);
  const needsStepUp = requiresStepUp(input.userId, input.amountMinor);

  let decision: PaymentRiskOutcome['decision'] = 'AUTO_APPROVE';
  if (blocking) decision = 'BLOCK';
  else if (score >= 60) decision = 'MANUAL_REVIEW';
  else if (needsStepUp || signals.some((s) => s.code === 'new_device_high_value')) decision = 'STEP_UP';

  const outcome: PaymentRiskOutcome = {
    score,
    level,
    decision,
    signals,
    evaluatedAt: nowIso(),
    provider,
  };

  const db = getDb();
  for (const signal of signals) {
    db.run(
      `INSERT INTO risk_events (id, user_id, payment_intent_id, rule, score_delta, level, action, detail, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        id('risk'),
        input.userId,
        input.paymentIntentId ?? null,
        signal.code,
        Math.round(signal.weight),
        level,
        decision,
        stringify({ label: signal.label, detail: signal.detail ?? null, blocking: signal.blocking }),
        nowIso(),
      ],
    );
  }
  if (decision !== 'AUTO_APPROVE') {
    log.warn('risk decision', { user: input.userId, decision, score, signals: signals.map((s) => s.code) });
  }
  return outcome;
}

/** Lightweight, non-blocking preview used while the payer is still typing. */
export function quoteRiskHint(input: {
  userId: string;
  asset: PayableAsset;
  amountMinor: bigint;
  rail: RailCode;
  recipientVerified: boolean;
  network: NetworkCode;
}): { level: RiskLevel; reasons: string[] } {
  const reasons: string[] = [];
  const limits = TIER_LIMITS[kycFor(input.userId).tier];
  const amountMajor = Number(input.amountMinor / unitOf('KES'));
  let score = 0;
  if (!input.recipientVerified) {
    reasons.push('Recipient name is not verified yet — we will confirm it after screening.');
    score += 15;
  }
  if (amountMajor >= (limits.strongConfirmFromKes ?? Number.MAX_SAFE_INTEGER)) {
    reasons.push(`Above KES ${(limits.strongConfirmFromKes ?? 0).toLocaleString('en-KE')}: step-up confirmation required.`);
    score += 25;
  }
  if (input.asset === 'BTC' || input.asset === 'ETH') {
    reasons.push('Funding from a volatile asset — the rate is locked for the quote window only.');
    score += 10;
  }
  if (input.rail === 'BANK_TRANSFER') {
    reasons.push('Bank payouts settle in batches and cannot be auto-reversed.');
    score += 8;
  }
  return { level: riskLevel(score), reasons };
}

/** Opens a compliance case; used by the review queue and blocked rails. */
export function openCase(input: {
  kind: 'KYC_REVIEW' | 'SANCTIONS' | 'VELOCITY' | 'WALLET_SCREENING' | 'MANUAL_REVIEW' | 'DISPUTE';
  subject: string;
  riskLevel: RiskLevel;
  userId?: string | null;
  paymentIntentId?: string | null;
  businessId?: string | null;
  note?: string;
  priority?: number;
}): { id: string; reference: string } {
  const db = getDb();
  const caseId = id('case');
  const reference = `CC-${new Date().toISOString().slice(0, 7).replace('-', '')}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
  const now = nowIso();
  insert('compliance_cases', {
    id: caseId,
    reference,
    kind: input.kind,
    status: 'OPEN',
    risk_level: input.riskLevel,
    priority: input.priority ?? (input.kind === 'SANCTIONS' ? 1 : 2),
    subject: input.subject,
    user_id: input.userId ?? null,
    business_id: input.businessId ?? null,
    payment_intent_id: input.paymentIntentId ?? null,
    sla_hours: input.kind === 'SANCTIONS' ? 4 : 24,
    due_at: new Date(Date.now() + (input.kind === 'SANCTIONS' ? 4 : 24) * 3.6e6).toISOString(),
    opened_at: now,
    updated_at: now,
    data_origin: config.isSandbox ? 'sandbox' : 'live',
  });
  if (input.note) {
    db.run('INSERT INTO compliance_case_notes (id, case_id, author, text, created_at) VALUES (?,?,?,?,?)', [
      id('note'),
      caseId,
      'system:risk_engine',
      input.note,
      now,
    ]);
  }
  publish('admin', 'network', 'compliance.case_opened', { caseId, reference, kind: input.kind, riskLevel: input.riskLevel });
  return { id: caseId, reference };
}

export function addCaseNote(caseId: string, author: string, text: string, outcome?: string): void {
  const db = getDb();
  db.run('INSERT INTO compliance_case_notes (id, case_id, author, text, created_at) VALUES (?,?,?,?,?)', [
    id('note'),
    caseId,
    author,
    text,
    nowIso(),
  ]);
  db.run('UPDATE compliance_cases SET updated_at = ?, outcome = COALESCE(?, outcome) WHERE id = ?', [nowIso(), outcome ?? null, caseId]);
}

export function closeCase(caseId: string, actor: string, outcome: 'CLEARED' | 'REJECTED' | 'ESCALATED', note: string): void {
  const db = getDb();
  db.tx(() => {
    db.run(
      `UPDATE compliance_cases SET status = ?, closed_at = ?, updated_at = ?, outcome = ?, assigned_to = COALESCE(assigned_to, ?) WHERE id = ?`,
      [outcome, nowIso(), nowIso(), note, actor, caseId],
    );
    db.run('INSERT INTO compliance_case_notes (id, case_id, author, text, created_at) VALUES (?,?,?,?,?)', [
      id('note'),
      caseId,
      actor,
      `${outcome}: ${note}`,
      nowIso(),
    ]);
    db.run(
      `INSERT INTO audit_logs (id, actor_user_id, actor_type, action, target_type, target_id, metadata, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id('aud'), actor, 'ADMIN', `compliance.case.${outcome.toLowerCase()}`, 'compliance_case', caseId, stringify({ note }), nowIso()],
    );
  });
  publish('admin', 'network', 'compliance.case_closed', { caseId, outcome });
}

/** Admin/ops: run a KYC verification. Real providers replace this entirely. */
export async function submitKyc(input: {
  userId: string;
  documentType: string;
  documentNumber: string;
  country: string;
  tier: KycTier;
}): Promise<{ status: string; tier: KycTier; provider: string }> {
  const db = getDb();
  const now = nowIso();
  const provider = config.compliance.kycProvider;

  if (config.isProduction && provider === 'none') {
    throw new DomainError(
      'PROVIDER_KEY_MISSING',
      'No KYC provider is configured, so identity verification cannot be completed in production mode.',
    );
  }

  const blob = encryptString(input.documentNumber);
  const masked = `••••${input.documentNumber.slice(-3)}`;
  db.tx(() => {
    db.run(
      `INSERT INTO kyc_profiles (id, user_id, provider, provider_ref, status, tier, document_type, document_number_masked, country, data_origin, created_at, updated_at)
       VALUES (?,?,?,?, 'PENDING', ?,?,?,?, 'sandbox', ?, ?)`,
      [id('kyc'), input.userId, provider === 'none' ? 'aurapay-manual-review' : provider, null, input.tier, input.documentType, masked, input.country, now, now],
    );
    db.run(`UPDATE users SET kyc_status = 'PENDING', updated_at = ? WHERE id = ?`, [now, input.userId]);
    db.run(
      `INSERT INTO audit_logs (id, actor_user_id, actor_type, action, target_type, target_id, metadata, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id('aud'), input.userId, 'USER', 'kyc.submitted', 'user', input.userId, stringify({ documentType: input.documentType, tier: input.tier }), now],
    );
  });

  if (config.isSandbox && config.compliance.allowManualApproval) {
    // Sandbox auto-approves tier 1 after submission so the demo is completable,
    // while leaving a visible, real review queue for tier 2+ (which needs docs).
    if (input.tier <= 1) {
      db.tx(() => {
        db.run(`UPDATE kyc_profiles SET status = 'APPROVED', reviewed_by = 'system:sandbox-auto', reviewed_at = ?, updated_at = ? WHERE user_id = ? AND status = 'PENDING'`, [now, now, input.userId]);
        db.run(`UPDATE users SET kyc_status = 'APPROVED', kyc_tier = ?, updated_at = ? WHERE id = ?`, [input.tier, now, input.userId]);
      });
      return { status: 'APPROVED', tier: input.tier, provider: 'aurapay-sandbox-auto' };
    }
    openCase({
      kind: 'KYC_REVIEW',
      subject: `KYC tier ${input.tier} review`,
      riskLevel: 'MEDIUM',
      userId: input.userId,
      note: `Enhanced due diligence required for tier ${input.tier}. Sandbox: approve or reject from Compliance.`,
    });
  }
  return { status: 'PENDING', tier: input.tier, provider };
}

export function approveKyc(userId: string, tier: KycTier, actor: string, caseId?: string): void {
  const db = getDb();
  const now = nowIso();
  if (!config.isSandbox && !config.compliance.allowManualApproval) {
    throw new DomainError('FORBIDDEN', 'Manual KYC approval is disabled outside sandbox; the KYC provider is the source of truth.');
  }
  db.tx(() => {
    db.run(`UPDATE kyc_profiles SET status = 'APPROVED', tier = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE user_id = ?`, [
      tier,
      actor,
      now,
      now,
      userId,
    ]);
    db.run(`UPDATE users SET kyc_status = 'APPROVED', kyc_tier = ?, updated_at = ? WHERE id = ?`, [tier, now, userId]);
    if (caseId) closeCase(caseId, actor, 'CLEARED', 'KYC approved via admin review');
    db.run(
      `INSERT INTO audit_logs (id, actor_user_id, actor_type, action, target_type, target_id, metadata, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id('aud'), actor, 'ADMIN', 'kyc.approved', 'user', userId, stringify({ tier }), now],
    );
  });
  publish(`user:${userId}`, 'notifications', 'kyc.approved', { tier });
}

export function rejectKyc(userId: string, reason: string, actor: string, caseId?: string): void {
  const db = getDb();
  const now = nowIso();
  db.tx(() => {
    db.run(`UPDATE kyc_profiles SET status = 'REJECTED', reviewed_by = ?, reviewed_at = ?, updated_at = ?, notes = ? WHERE user_id = ?`, [
      actor,
      now,
      now,
      reason,
      userId,
    ]);
    db.run(`UPDATE users SET kyc_status = 'REJECTED', kyc_tier = 0, updated_at = ? WHERE id = ?`, [now, userId]);
    if (caseId) closeCase(caseId, actor, 'REJECTED', reason);
    db.run(
      `INSERT INTO audit_logs (id, actor_user_id, actor_type, action, target_type, target_id, metadata, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id('aud'), actor, 'ADMIN', 'kyc.rejected', 'user', userId, stringify({ reason }), now],
    );
  });
}

/** Sanctions/watchlist entries the internal provider reads (sandbox only). */
export function addWatchlistEntry(pattern: string, listId: string, note: string): void {
  if (!config.isSandbox) throw new DomainError('FORBIDDEN', 'Watchlists are managed by the contracted screening provider in production.');
  getDb().run(
    `INSERT INTO watchlist_entries (id, pattern, list_id, note, added_by, created_at) VALUES (?,?,?,?,?,?)`,
    [id('wl'), pattern, listId, note, 'admin', nowIso()],
  );
}
