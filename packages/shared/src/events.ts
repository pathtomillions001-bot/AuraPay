/**
 * Event catalogue. These strings are part of the public webhook + SSE
 * contract; adding one is fine, renaming one is a breaking change.
 */
export const WEBHOOK_EVENTS = [
  'payment.created',
  'payment.detected',
  'payment.confirmed',
  'payment.processing',
  'payment.settling',
  'payment.completed',
  'payment.failed',
  'payment.refund_requested',
  'payment.refunded',
  'payout.created',
  'payout.completed',
  'payout.failed',
  'merchant.updated',
  'quote.expired',
  'liquidity.low',
  'compliance.review.opened',
  'compliance.review.closed',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Payment states mapped to the outbound webhook event they emit. */
export const STATE_TO_WEBHOOK_EVENT: Partial<Record<string, WebhookEvent>> = {
  CREATED: 'payment.created',
  PAYMENT_DETECTED: 'payment.detected',
  BLOCKCHAIN_CONFIRMING: 'payment.confirmed',
  CONVERSION_PENDING: 'payment.processing',
  FIAT_SETTLEMENT_PENDING: 'payment.settling',
  PAYOUT_CONFIRMED: 'payment.completed',
  COMPLETED: 'payment.completed',
  FAILED: 'payment.failed',
  REFUND_PENDING: 'payment.refund_requested',
  REFUNDED: 'payment.refunded',
};

/** SSE channel names used by the realtime stream. */
export const REALTIME_CHANNELS = [
  'payment',
  'quote',
  'balances',
  'notifications',
  'prices',
  'network',
  'merchant',
] as const;
export type RealtimeChannel = (typeof REALTIME_CHANNELS)[number];

export interface RealtimeMessage<T = unknown> {
  channel: RealtimeChannel;
  type: string;
  /** Monotonic per-connection id, used by clients to detect gaps. */
  seq?: number;
  at: string;
  data: T;
}

export interface PriceTick {
  asset: string;
  currency: string;
  /** Decimal string, e.g. "129.05". */
  price: string;
  change24hPct: number;
  /** Where the number came from — the UI must label simulated data. */
  source: 'simulated' | 'live';
  at: string;
}
