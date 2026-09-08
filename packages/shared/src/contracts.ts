import { z } from 'zod';
import { PAYABLE_ASSETS } from './assets.js';
import { ASSET_SCALES, type AssetCode } from './money.js';
import { NETWORKS } from './networks.js';
import type { NetworkCode } from './assets.js';
import { PAYMENT_STATES, DISPLAY_STATUSES, PAYOUT_STATES, REFUND_STATES, KYC_STATES } from './status.js';
import { WEBHOOK_EVENTS } from './events.js';
import { normalizeMsisdn } from './format.js';

export const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, 'must be a decimal string')
  .max(40);

export const assetCode = z.enum(Object.keys(ASSET_SCALES) as [AssetCode, ...AssetCode[]]);
export const payableAsset = z.enum(PAYABLE_ASSETS);
export const networkCode = z.enum(Object.keys(NETWORKS) as [NetworkCode, ...NetworkCode[]]);
export const paymentState = z.enum(PAYMENT_STATES);
export const displayStatusEnum = z.enum(DISPLAY_STATUSES);
export type DisplayStatusSchema = z.infer<typeof displayStatusEnum>;
export const payoutState = z.enum(PAYOUT_STATES);
export const refundState = z.enum(REFUND_STATES);
export const kycState = z.enum(KYC_STATES);
export const webhookEvent = z.enum(WEBHOOK_EVENTS);
export const isoDateTime = z.string();

export const recipientKind = z.enum(['PHONE', 'TILL', 'PAYBILL', 'QR', 'LINK', 'BANK', 'WALLET']);
export type RecipientKindInput = z.infer<typeof recipientKind>;

export const msisdn = z
  .string()
  .min(9)
  .transform((v, ctx) => {
    const normalized = normalizeMsisdn(v);
    if (!normalized) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Not a valid Kenyan Safaricom/Airtel number' });
      return z.NEVER;
    }
    return normalized;
  });

export const tillNumber = z
  .string()
  .transform((v) => v.replace(/\D/g, ''))
  .pipe(z.string().regex(/^\d{5,6}$/, 'Till numbers are 5 or 6 digits'));

export const paybillNumber = z
  .string()
  .transform((v) => v.replace(/\D/g, ''))
  .pipe(z.string().regex(/^\d{4,6}$/, 'PayBill is 4–6 digits'));

export const accountReference = z.string().min(1).max(24);

// ────────────────────────────────────────────────────────────────────────────
// Auth
// ────────────────────────────────────────────────────────────────────────────

export const loginRequest = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1).max(200),
  totp: z.string().regex(/^\d{6}$/).optional(),
});

export const registerRequest = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(10, 'Use at least 10 characters').max(200),
  fullName: z.string().min(2).max(120),
  phone: msisdn.optional(),
  country: z.string().length(2).default('KE'),
});

export const publicUser = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string(),
  phone: z.string().nullable(),
  country: z.string(),
  locale: z.string(),
  roles: z.array(z.string()),
  kycStatus: kycState,
  kycTier: z.number().int().min(0).max(3),
  twoFactorEnabled: z.boolean(),
  passkeyEnabled: z.boolean(),
  defaultSettlementRail: z.string(),
  createdAt: isoDateTime,
});
export type PublicUser = z.infer<typeof publicUser>;

export const sessionResponse = z.object({
  user: publicUser,
  mode: z.enum(['sandbox', 'production']),
  csrfToken: z.string(),
  expiresAt: isoDateTime,
});
export type SessionResponse = z.infer<typeof sessionResponse>;

// ────────────────────────────────────────────────────────────────────────────
// Balances / assets
// ────────────────────────────────────────────────────────────────────────────

export const walletBalance = z.object({
  asset: assetCode,
  network: networkCode,
  availableMinor: decimalString,
  reservedMinor: decimalString,
  totalMinor: decimalString,
  usdValueMinor: decimalString,
  kesValueMinor: decimalString,
  change24hPct: z.number(),
  unitPriceKes: decimalString,
  custodial: z.boolean(),
  label: z.string().nullable(),
  address: z.string().nullable(),
});
export type WalletBalance = z.infer<typeof walletBalance>;

export const balanceSummary = z.object({
  totalUsdMinor: decimalString,
  totalKesMinor: decimalString,
  referenceRateKesPerUsd: decimalString,
  wallets: z.array(walletBalance),
  computedAt: isoDateTime,
  dataOrigin: z.enum(['sandbox', 'live']),
});
export type BalanceSummary = z.infer<typeof balanceSummary>;

// ────────────────────────────────────────────────────────────────────────────
// Recipients
// ────────────────────────────────────────────────────────────────────────────

export const recipientInput = z.object({
  kind: recipientKind,
  displayName: z.string().min(1).max(60),
  phone: msisdn.optional(),
  till: tillNumber.optional(),
  paybill: paybillNumber.optional(),
  accountReference: accountReference.optional(),
  bankCode: z.string().max(10).optional(),
  bankAccount: z.string().max(34).optional(),
  walletAddress: z.string().max(120).optional(),
  network: networkCode.optional(),
  country: z.string().length(2).default('KE'),
  preferredRail: z.string().optional(),
  note: z.string().max(200).optional(),
  favourite: z.boolean().default(false),
  defaultAmountKesMajor: z.number().int().nonnegative().optional(),
});
export type RecipientInput = z.infer<typeof recipientInput>;

export const recipientView = recipientInput.extend({
  id: z.string(),
  verifiedName: z.string().nullable(),
  verificationStatus: z.enum(['VERIFIED', 'UNVERIFIED', 'STALE', 'BLOCKED']),
  lastUsedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
}).passthrough();
export type RecipientView = z.infer<typeof recipientView>;

// ────────────────────────────────────────────────────────────────────────────
// Quote
// ────────────────────────────────────────────────────────────────────────────

export const quoteRequest = z
  .object({
    asset: payableAsset,
    network: networkCode.optional(),
    /** Provide either the KES the recipient should get, or the crypto to spend. */
    recipientAmountKesMajor: z.number().positive().optional(),
    payAmountMinor: decimalString.optional(),
    rail: z.string().optional(),
    recipientCountry: z.string().length(2).default('KE'),
    recipientId: z.string().optional(),
  })
  .refine((v) => v.recipientAmountKesMajor !== undefined || v.payAmountMinor !== undefined, {
    message: 'recipientAmountKesMajor or payAmountMinor is required',
  });
export type QuoteRequest = z.infer<typeof quoteRequest>;

export const feeBreakdown = z.object({
  networkFeeMinor: decimalString,
  networkFeeUsdMinor: decimalString,
  networkFeeLabel: z.string(),
  serviceFeeMinor: decimalString,
  serviceFeeKesMinor: decimalString,
  providerSurchargeKesMinor: decimalString,
  totalFeeKesMinor: decimalString,
  feeBps: z.number(),
  spreadBps: z.number(),
  hiddenSpread: z.literal(false),
});
export type FeeBreakdown = z.infer<typeof feeBreakdown>;

export const quoteView = z.object({
  quoteId: z.string(),
  status: z.enum(['ACTIVE', 'CONSUMED', 'EXPIRED', 'INVALIDATED']),
  asset: assetCode,
  network: networkCode,
  recipientCurrency: z.string(),
  recipientCountry: z.string(),
  rail: z.string(),
  recipientAmountKesMinor: decimalString,
  cryptoAmountMinor: decimalString,
  networkFeeMinor: decimalString,
  serviceFeeMinor: decimalString,
  totalDebitMinor: decimalString,
  fxRate: decimalString,
  midMarketRate: decimalString,
  fees: feeBreakdown,
  route: z.object({
    routeId: z.string(),
    rail: z.string(),
    provider: z.string(),
    providerDisplayName: z.string(),
    rank: z.number().int(),
    considered: z.array(z.object({ provider: z.string(), score: z.number(), reason: z.string() })),
  }),
  liquidityCheck: z.object({
    sufficient: z.boolean(),
    availableKesMinor: decimalString,
    requiredKesMinor: decimalString,
    queuedIfInsufficient: z.boolean(),
  }),
  riskHint: z.object({ level: z.enum(['LOW', 'MEDIUM', 'HIGH', 'SEVERE']), reasons: z.array(z.string()) }),
  estimatedSettlementSeconds: z.number().int().nonnegative(),
  createdAt: isoDateTime,
  expiresAt: isoDateTime,
  ttlSeconds: z.number().int(),
  dataOrigin: z.enum(['sandbox', 'live']),
  disclaimer: z.string(),
});
export type QuoteView = z.infer<typeof quoteView>;

export const quoteRefreshResponse = z.object({
  quote: quoteView,
  repriced: z.boolean(),
  previousRate: decimalString.nullable(),
  reason: z.string().nullable(),
});

// ────────────────────────────────────────────────────────────────────────────
// Payment intent
// ────────────────────────────────────────────────────────────────────────────

export const createPaymentIntentRequest = z.object({
  quoteId: z.string(),
  recipient: recipientInput,
  /** Client-generated key so a double-tap cannot create two payments. */
  idempotencyKey: z.string().min(8).max(80),
  /** True when the payer explicitly accepted a step-up confirmation prompt. */
  strongConfirmation: z.boolean().default(false),
  device: z
    .object({ userAgent: z.string().max(400).optional(), locale: z.string().max(20).optional() })
    .optional(),
});
export type CreatePaymentIntentRequest = z.infer<typeof createPaymentIntentRequest>;

export const depositInstruction = z.object({
  address: z.string(),
  network: networkCode,
  asset: assetCode,
  amountMinor: decimalString,
  memo: z.string().nullable(),
  confirmationsRequired: z.number().int(),
  expiresAt: isoDateTime,
  qrPayload: z.string(),
  warning: z.string(),
  dataOrigin: z.enum(['sandbox', 'live']),
});
export type DepositInstruction = z.infer<typeof depositInstruction>;

export const paymentStep = z.object({
  id: z.string(),
  label: z.string(),
  state: paymentState,
  status: z.enum(['waiting', 'active', 'completed', 'failed', 'skipped']),
  detail: z.string().nullable(),
  startedAt: isoDateTime.nullable(),
  completedAt: isoDateTime.nullable(),
});
export type PaymentStep = z.infer<typeof paymentStep>;

export const paymentIntentView = z.object({
  id: z.string(),
  reference: z.string(),
  status: paymentState,
  displayStatus: displayStatusEnum,
  progress: z.number(),
  mode: z.enum(['sandbox', 'production']),
  asset: assetCode,
  network: networkCode,
  recipientCurrency: z.string(),
  recipientAmountKesMinor: decimalString,
  cryptoDebitMinor: decimalString,
  fxRate: decimalString,
  fees: feeBreakdown,
  recipient: recipientView,
  quote: z.object({
    quoteId: z.string(),
    lockedAt: isoDateTime,
    expiresAt: isoDateTime,
    dataOrigin: z.enum(['sandbox', 'live']),
  }),
  route: z.object({
    rail: z.string(),
    provider: z.string(),
    providerDisplayName: z.string(),
    liquidityReserved: z.boolean(),
  }),
  deposit: depositInstruction.nullable(),
  blockchain: z
    .object({
      txHash: z.string(),
      confirmations: z.number().int(),
      confirmationsRequired: z.number().int(),
      blockHeight: z.string().nullable(),
      detectedAt: isoDateTime,
      finalizedAt: isoDateTime.nullable(),
      dataOrigin: z.enum(['sandbox', 'live']),
    })
    .nullable(),
  payout: z
    .object({
      id: z.string(),
      state: payoutState,
      rail: z.string(),
      provider: z.string(),
      providerReference: z.string().nullable(),
      recipientPhone: z.string().nullable(),
      amountKesMinor: decimalString,
      submittedAt: isoDateTime.nullable(),
      confirmedAt: isoDateTime.nullable(),
      failureReason: z.string().nullable(),
    })
    .nullable(),
  risk: z.object({ level: z.enum(['LOW', 'MEDIUM', 'HIGH', 'SEVERE']), score: z.number(), decision: z.string() }),
  steps: z.array(paymentStep),
  timeline: z.array(
    z.object({
      state: paymentState,
      at: isoDateTime,
      actor: z.string(),
      note: z.string().nullable(),
    }),
  ),
  failure: z
    .object({
      code: z.string(),
      message: z.string(),
      recovery: z.string(),
      at: isoDateTime,
      refundId: z.string().nullable(),
    })
    .nullable(),
  receiptId: z.string().nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  completedAt: isoDateTime.nullable(),
  webhookEvents: z.array(z.object({ event: z.string(), at: isoDateTime, deliveryId: z.string().nullable() })),
  ledgerEntries: z.array(
    z.object({
      accountCode: z.string(),
      direction: z.enum(['DEBIT', 'CREDIT']),
      asset: assetCode,
      amountMinor: decimalString,
      memo: z.string(),
    }),
  ),
});
export type PaymentIntentView = z.infer<typeof paymentIntentView>;

// ────────────────────────────────────────────────────────────────────────────
// Transactions / receipts
// ────────────────────────────────────────────────────────────────────────────

export const transactionListItem = z.object({
  id: z.string(),
  reference: z.string(),
  kind: z.enum(['SEND', 'REQUEST', 'RECEIVE', 'BILL', 'REFUND', 'LINK']),
  status: displayStatusEnum,
  state: paymentState,
  direction: z.enum(['OUT', 'IN']),
  asset: assetCode,
  network: networkCode.nullable(),
  amountMinor: decimalString,
  cryptoAmountMinor: decimalString,
  fxRate: decimalString.nullable(),
  recipientLabel: z.string(),
  recipientHandle: z.string().nullable(),
  merchantName: z.string().nullable(),
  createdAt: isoDateTime,
  completedAt: isoDateTime.nullable(),
  mode: z.enum(['sandbox', 'production']),
  receiptAvailable: z.boolean(),
});
export type TransactionListItem = z.infer<typeof transactionListItem>;

export const transactionPage = z.object({
  items: z.array(transactionListItem),
  nextCursor: z.string().nullable(),
  totalEstimate: z.number().int().nonnegative(),
});

export const receiptView = z.object({
  id: z.string(),
  reference: z.string(),
  issuedAt: isoDateTime,
  mode: z.enum(['sandbox', 'production']),
  payer: z.object({ name: z.string(), handle: z.string().nullable(), id: z.string() }),
  recipient: z.object({ name: z.string(), handle: z.string(), rail: z.string(), verified: z.boolean() }),
  deliveredAmountKesMinor: decimalString,
  asset: assetCode,
  network: networkCode,
  cryptoAmountMinor: decimalString,
  midMarketRate: decimalString,
  fxRate: decimalString,
  networkFeeMinor: decimalString,
  serviceFeeMinor: decimalString,
  providerSurchargeKesMinor: decimalString,
  totalDebitMinor: decimalString,
  blockchain: z.object({ txHash: z.string().nullable(), confirmations: z.number(), network: networkCode }).nullable(),
  localReference: z.string().nullable(),
  status: displayStatusEnum,
  timeline: z.array(z.object({ label: z.string(), at: isoDateTime })),
  complianceNote: z.string(),
  legalNote: z.string(),
});
export type ReceiptView = z.infer<typeof receiptView>;

// ────────────────────────────────────────────────────────────────────────────
// Links / QR / requests
// ────────────────────────────────────────────────────────────────────────────

export const paymentLinkRequest = z.object({
  title: z.string().min(2).max(80),
  description: z.string().max(240).optional(),
  amountKesMajor: z.number().positive().optional(),
  reference: z.string().max(40).optional(),
  expiresAt: isoDateTime.optional(),
  acceptedAssets: z.array(payableAsset).min(1).default(['USDT', 'USDC']),
  settlementRail: z.string().default('MPESA'),
  allowPayerAmount: z.boolean().default(true),
  allowRepeat: z.boolean().default(false),
  maxUses: z.number().int().positive().optional(),
});
export type PaymentLinkRequest = z.infer<typeof paymentLinkRequest>;

export const paymentLinkView = z.object({
  id: z.string(),
  token: z.string(),
  url: z.string(),
  qrDataUrl: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  amountKesMinor: decimalString.nullable(),
  reference: z.string().nullable(),
  status: z.enum(['ACTIVE', 'PAUSED', 'EXPIRED', 'EXHAUSTED', 'ARCHIVED']),
  acceptedAssets: z.array(payableAsset),
  settlementRail: z.string(),
  allowPayerAmount: z.boolean(),
  maxUses: z.number().int().nullable(),
  uses: z.number().int(),
  collectedKesMinor: decimalString,
  createdAt: isoDateTime,
  expiresAt: isoDateTime.nullable(),
  merchantName: z.string().nullable(),
});
export type PaymentLinkView = z.infer<typeof paymentLinkView>;

export const paymentLinkPublicView = z.object({
  merchantName: z.string(),
  merchantId: z.string(),
  logoMark: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  amountKesMinor: decimalString.nullable(),
  allowPayerAmount: z.boolean(),
  reference: z.string().nullable(),
  acceptedAssets: z.array(
    z.object({ code: payableAsset, networks: z.array(networkCode), indicativeRate: decimalString }),
  ),
  settlementRailLabel: z.string(),
  expiresAt: isoDateTime.nullable(),
  status: z.enum(['ACTIVE', 'PAUSED', 'EXPIRED', 'EXHAUSTED']),
  createdAt: isoDateTime,
});
export type PaymentLinkPublicView = z.infer<typeof paymentLinkPublicView>;

// ────────────────────────────────────────────────────────────────────────────
// Merchant
// ────────────────────────────────────────────────────────────────────────────

export const merchantMetrics = z.object({
  todayKesMinor: decimalString,
  todayTransactions: z.number().int(),
  cryptoSharePct: z.number(),
  mpesaSharePct: z.number(),
  averagePaymentKesMinor: decimalString,
  settledKesMinor: decimalString,
  pendingSettlementKesMinor: decimalString,
  refundsTodayKesMinor: decimalString,
  refundRatePct: z.number(),
  successRatePct: z.number(),
  settlementLatencyP50Seconds: z.number(),
  series: z.array(z.object({ bucket: isoDateTime, volumeKesMinor: decimalString, count: z.number().int() })),
});
export type MerchantMetrics = z.infer<typeof merchantMetrics>;

// ────────────────────────────────────────────────────────────────────────────
// Compliance / admin
// ────────────────────────────────────────────────────────────────────────────

export const complianceCase = z.object({
  id: z.string(),
  reference: z.string(),
  kind: z.enum(['KYC_REVIEW', 'SANCTIONS', 'VELOCITY', 'WALLET_SCREENING', 'MANUAL_REVIEW', 'DISPUTE']),
  status: z.enum(['OPEN', 'PENDING_INFO', 'IN_REVIEW', 'CLEARED', 'REJECTED', 'ESCALATED']),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'SEVERE']),
  subject: z.string(),
  paymentId: z.string().nullable(),
  userId: z.string().nullable(),
  assignedTo: z.string().nullable(),
  openedAt: isoDateTime,
  updatedAt: isoDateTime,
  notes: z.array(z.object({ at: isoDateTime, author: z.string(), text: z.string() })),
});
export type ComplianceCase = z.infer<typeof complianceCase>;

export const liquidityAccount = z.object({
  id: z.string(),
  provider: z.string(),
  currency: z.string(),
  country: z.string(),
  availableMinor: decimalString,
  reservedMinor: decimalString,
  pendingPayoutsMinor: decimalString,
  floatTargetMinor: decimalString,
  utilisationPct: z.number(),
  health: z.enum(['HEALTHY', 'WATCH', 'LOW', 'CRITICAL']),
  updatedAt: isoDateTime,
  dataOrigin: z.enum(['sandbox', 'live']),
});
export type LiquidityAccount = z.infer<typeof liquidityAccount>;

export const providerStatus = z.object({
  code: z.string(),
  displayName: z.string(),
  kind: z.enum(['MOBILE_MONEY', 'BANK', 'FX', 'CUSTODY', 'KYC', 'SCREENING', 'BLOCKCHAIN']),
  enabled: z.boolean(),
  configured: z.boolean(),
  operational: z.boolean(),
  successRatePct: z.number(),
  latencyP50Ms: z.number(),
  errorRatePct: z.number(),
  lastCheckedAt: isoDateTime,
  note: z.string().nullable(),
  dataOrigin: z.enum(['sandbox', 'live']),
});
export type ProviderStatus = z.infer<typeof providerStatus>;

// ────────────────────────────────────────────────────────────────────────────
// Developer platform
// ────────────────────────────────────────────────────────────────────────────

export const apiKeyView = z.object({
  id: z.string(),
  name: z.string(),
  publishableKey: z.string(),
  secretKeyHint: z.string().nullable(),
  environment: z.enum(['test', 'live']),
  scopes: z.array(z.string()),
  lastUsedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  revokedAt: isoDateTime.nullable(),
  status: z.enum(['ACTIVE', 'REVOKED']),
});
export type ApiKeyView = z.infer<typeof apiKeyView>;

export const webhookEndpointView = z.object({
  id: z.string(),
  url: z.string(),
  description: z.string().nullable(),
  events: z.array(webhookEvent),
  status: z.enum(['ACTIVE', 'PAUSED']),
  secretHint: z.string(),
  consecutiveFailures: z.number().int(),
  lastDeliveryAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});
export type WebhookEndpointView = z.infer<typeof webhookEndpointView>;

export const webhookDelivery = z.object({
  id: z.string(),
  endpointId: z.string(),
  event: z.string(),
  eventId: z.string(),
  attempt: z.number().int(),
  status: z.enum(['SCHEDULED', 'SUCCEEDED', 'FAILED', 'THROTTLED']),
  httpStatus: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  nextRetryAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});
export type WebhookDelivery = z.infer<typeof webhookDelivery>;

// ────────────────────────────────────────────────────────────────────────────
// Notifications
// ────────────────────────────────────────────────────────────────────────────

export const notification = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  channel: z.enum(['in_app', 'email', 'sms', 'whatsapp']),
  severity: z.enum(['info', 'success', 'warning', 'critical']),
  readAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  link: z.string().nullable(),
  paymentId: z.string().nullable(),
});
export type Notification = z.infer<typeof notification>;

export const networkHealth = z.object({
  overall: z.enum(['OPERATIONAL', 'DEGRADED', 'OUTAGE']),
  checkedAt: isoDateTime,
  rails: z.array(
    z.object({
      rail: z.string(),
      provider: z.string(),
      status: z.enum(['OPERATIONAL', 'DEGRADED', 'OUTAGE', 'MAINTENANCE']),
      latencyP50Ms: z.number(),
      successRatePct: z.number(),
      queueDepth: z.number().int(),
      note: z.string().nullable(),
      dataOrigin: z.enum(['sandbox', 'live']),
    }),
  ),
  networks: z.array(
    z.object({
      network: networkCode,
      status: z.enum(['OPERATIONAL', 'CONGESTED', 'DEGRADED']),
      confirmationsBacklog: z.number().int(),
      feeIndex: z.number(),
      etaSeconds: z.number().int(),
      dataOrigin: z.enum(['sandbox', 'live']),
    }),
  ),
});
export type NetworkHealth = z.infer<typeof networkHealth>;
