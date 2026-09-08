/**
 * The payment state machine. `PAYMENT_STATES` is ordered: index position is the
 * happy-path progress used by the UI to render the processing timeline.
 *
 * Transitions are validated by the backend (`assertTransition`) and every edge
 * is written to `payment_events`. The frontend may *animate ahead* of state,
 * but never marks a step completed before the server says so.
 */

export const PAYMENT_STATES = [
  'CREATED',
  'QUOTED',
  'AWAITING_PAYMENT',
  'PAYMENT_DETECTED',
  'BLOCKCHAIN_CONFIRMING',
  'RISK_REVIEW',
  'CONVERSION_PENDING',
  'LIQUIDITY_RESERVED',
  'FIAT_SETTLEMENT_PENDING',
  'PAYOUT_SUBMITTED',
  'PAYOUT_CONFIRMED',
  'COMPLETED',
  'FAILED',
  'REFUND_PENDING',
  'REFUNDED',
] as const;

export type PaymentState = (typeof PAYMENT_STATES)[number];

/** States shown in the 6-step processing UI, in order. */
export const PAYMENT_STEPS = [
  { state: 'CREATED', step: 1, label: 'Payment initiated' },
  { state: 'PAYMENT_DETECTED', step: 2, label: 'Blockchain confirmation' },
  { state: 'RISK_REVIEW', step: 3, label: 'Risk verification' },
  { state: 'CONVERSION_PENDING', step: 4, label: 'Currency conversion' },
  { state: 'LIQUIDITY_RESERVED', step: 5, label: 'KES settlement' },
  { state: 'PAYOUT_CONFIRMED', step: 6, label: 'M-Pesa delivery' },
] as const;

const FORWARD: Record<PaymentState, PaymentState[]> = {
  CREATED: ['QUOTED', 'AWAITING_PAYMENT', 'FAILED'],
  QUOTED: ['AWAITING_PAYMENT', 'FAILED', 'CREATED'],
  AWAITING_PAYMENT: ['PAYMENT_DETECTED', 'FAILED', 'RISK_REVIEW'],
  PAYMENT_DETECTED: ['BLOCKCHAIN_CONFIRMING', 'RISK_REVIEW', 'FAILED'],
  BLOCKCHAIN_CONFIRMING: ['RISK_REVIEW', 'PAYMENT_DETECTED', 'FAILED'],
  RISK_REVIEW: ['CONVERSION_PENDING', 'FAILED', 'REFUND_PENDING'],
  CONVERSION_PENDING: ['LIQUIDITY_RESERVED', 'RISK_REVIEW', 'FAILED'],
  LIQUIDITY_RESERVED: ['FIAT_SETTLEMENT_PENDING', 'CONVERSION_PENDING', 'FAILED', 'REFUND_PENDING'],
  FIAT_SETTLEMENT_PENDING: ['PAYOUT_SUBMITTED', 'LIQUIDITY_RESERVED', 'FAILED', 'REFUND_PENDING'],
  PAYOUT_SUBMITTED: ['PAYOUT_CONFIRMED', 'FIAT_SETTLEMENT_PENDING', 'FAILED', 'REFUND_PENDING'],
  PAYOUT_CONFIRMED: ['COMPLETED', 'REFUND_PENDING', 'FAILED'],
  COMPLETED: ['REFUND_PENDING', 'REFUNDED'],
  FAILED: ['REFUND_PENDING'],
  REFUND_PENDING: ['REFUNDED', 'FAILED'],
  REFUNDED: [],
};

export const TERMINAL_STATES: readonly PaymentState[] = ['COMPLETED', 'FAILED', 'REFUNDED'];
export const OPEN_STATES: readonly PaymentState[] = PAYMENT_STATES.filter(
  (s) => !TERMINAL_STATES.includes(s),
) as PaymentState[];

export function allowedTransitions(from: PaymentState): PaymentState[] {
  return FORWARD[from] ?? [];
}

export function canTransition(from: PaymentState, to: PaymentState): boolean {
  return allowedTransitions(from).includes(to);
}

export function assertTransition(from: PaymentState, to: PaymentState, ref: string): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal payment transition for ${ref}: ${from} → ${to}`);
  }
}

export function isTerminal(state: PaymentState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** True while money is expected to move on-chain or through a partner. */
export function isLive(state: PaymentState): boolean {
  return !isTerminal(state) && state !== 'CREATED' && state !== 'QUOTED';
}

/** Progress 0..1 for progress bars (never derived from wall-clock time). */
export function stateProgress(state: PaymentState): number {
  switch (state) {
    case 'CREATED':
      return 0.05;
    case 'QUOTED':
      return 0.1;
    case 'AWAITING_PAYMENT':
      return 0.2;
    case 'PAYMENT_DETECTED':
      return 0.35;
    case 'BLOCKCHAIN_CONFIRMING':
      return 0.45;
    case 'RISK_REVIEW':
      return 0.6;
    case 'CONVERSION_PENDING':
      return 0.7;
    case 'LIQUIDITY_RESERVED':
      return 0.8;
    case 'FIAT_SETTLEMENT_PENDING':
      return 0.88;
    case 'PAYOUT_SUBMITTED':
      return 0.94;
    case 'PAYOUT_CONFIRMED':
      return 0.98;
    case 'COMPLETED':
      return 1;
    case 'REFUND_PENDING':
      return 0.9;
    case 'REFUNDED':
      return 1;
    case 'FAILED':
      return 1;
  }
}

/** Ledger / history display status — a coarser projection of the state machine. */
export const DISPLAY_STATUSES = [
  'PENDING',
  'PROCESSING',
  'CONFIRMED',
  'SETTLING',
  'COMPLETED',
  'FAILED',
  'REFUNDED',
  'REVIEW',
] as const;
export type DisplayStatus = (typeof DISPLAY_STATUSES)[number];

export function displayStatus(state: PaymentState): DisplayStatus {
  switch (state) {
    case 'CREATED':
    case 'QUOTED':
    case 'AWAITING_PAYMENT':
      return 'PENDING';
    case 'PAYMENT_DETECTED':
    case 'BLOCKCHAIN_CONFIRMING':
    case 'CONVERSION_PENDING':
      return 'CONFIRMED';
    case 'RISK_REVIEW':
      return 'REVIEW';
    case 'LIQUIDITY_RESERVED':
    case 'FIAT_SETTLEMENT_PENDING':
    case 'PAYOUT_SUBMITTED':
      return 'SETTLING';
    case 'PAYOUT_CONFIRMED':
      return 'PROCESSING';
    case 'COMPLETED':
      return 'COMPLETED';
    case 'FAILED':
      return 'FAILED';
    case 'REFUND_PENDING':
      return 'PROCESSING';
    case 'REFUNDED':
      return 'REFUNDED';
  }
}

export const PAYOUT_STATES = [
  'CREATED',
  'SUBMITTED',
  'ACCEPTED',
  'CONFIRMED',
  'FAILED',
  'REVERSED',
] as const;
export type PayoutState = (typeof PAYOUT_STATES)[number];

export const REFUND_STATES = ['PENDING', 'SUBMITTED', 'COMPLETED', 'REJECTED', 'FAILED'] as const;
export type RefundState = (typeof REFUND_STATES)[number];

export const KYC_STATES = ['NOT_STARTED', 'PENDING', 'ACTION_REQUIRED', 'APPROVED', 'REJECTED'] as const;
export type KycState = (typeof KYC_STATES)[number];

export const KYC_TIERS = [0, 1, 2, 3] as const;
export type KycTier = (typeof KYC_TIERS)[number];
