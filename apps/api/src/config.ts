import 'dotenv/config';

/**
 * Central configuration.
 *
 * Two rules govern this file:
 *   1. Nothing that moves real money is enabled by env-var absence/guess.
 *      Every live integration requires explicit credentials AND an explicit
 *      `*_LIVE_ENABLED=true`.
 *   2. `MODE` decides whether the process may touch real rails at all.
 *      `sandbox` = simulated settlement, deterministic, no external calls.
 *      `production` = live partners; missing config fails closed at boot.
 */

export type RuntimeMode = 'sandbox' | 'production';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback === undefined) throw new Error(`missing required env var ${name}`);
    return fallback;
  }
  return v;
}

function bool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const parsed = Number(v);
  if (!Number.isFinite(parsed)) throw new Error(`env var ${name} must be numeric`);
  return parsed;
}

function secret(name: string, fallback: string, mode: RuntimeMode): string {
  const v = process.env[name];
  if (v && v.length >= 16) return v;
  if (mode === 'production') {
    throw new Error(
      `${name} must be set to a high-entropy value (>=16 chars) in production. ` +
        `Generate one with: openssl rand -hex 32`,
    );
  }
  if (!v) {
    // Sandbox: keep boot frictionless but make the substitution visible in logs.
    return `${fallback}:sandbox-dev-only`;
  }
  return v;
}

const mode = (process.env.AURAPAY_MODE === 'production' ? 'production' : 'sandbox') as RuntimeMode;

export const config = {
  mode,
  isSandbox: mode === 'sandbox',
  isProduction: mode === 'production',
  env: str('NODE_ENV', 'development'),
  port: num('PORT', 4000),
  host: str('HOST', '0.0.0.0'),
  publicUrl: str('PUBLIC_URL', 'http://localhost:3000'),
  apiPublicPath: str('API_PUBLIC_PATH', '/v1'),
  checkoutHost: str('CHECKOUT_HOST', 'checkout.aurapay.local'),

  database: {
    // `sqlite` is the embedded engine used for sandbox/demo and tests.
    // `postgres` is the production engine (managed Postgres); the SQL in
    // db/postgres/0001_init.sql is the schema of record for both.
    driver: (process.env.DATABASE_DRIVER === 'postgres' ? 'postgres' : 'sqlite') as 'sqlite' | 'postgres',
    url: str('DATABASE_URL', ''),
    sqlitePath: str('SQLITE_PATH', '.data/aurapay.sqlite'),
    poolMax: num('DATABASE_POOL_MAX', 10),
  },

  redis: {
    url: str('REDIS_URL', ''),
    enabled: bool('REDIS_ENABLED', false),
  },

  security: {
    sessionSecret: secret('SESSION_SECRET', 'aurapay-sandbox-session-secret-do-not-use-in-prod', mode),
    encryptionKey: secret('ENCRYPTION_KEY', '0000000000000000000000000000000000000000000000000000000000000000', mode),
    webhookSecret: secret('WEBHOOK_SECRET', 'aurapay-sandbox-webhook-secret', mode),
    sessionTtlSeconds: num('SESSION_TTL_SECONDS', 8 * 3600),
    idleTimeoutSeconds: num('SESSION_IDLE_TIMEOUT_SECONDS', 2 * 3600),
    passwordLockoutThreshold: num('PASSWORD_LOCKOUT_THRESHOLD', 6),
    passwordLockoutSeconds: num('PASSWORD_LOCKOUT_SECONDS', 900),
    csrfAllowOrigins: str('CSRF_ALLOWED_ORIGINS', 'http://localhost:3000,http://127.0.0.1:3000')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    trustProxy: bool('TRUST_PROXY', true),
    rateLimitWindowMs: num('RATE_LIMIT_WINDOW_MS', 60_000),
    rateLimitMax: num('RATE_LIMIT_MAX', 300),
  },

  crypto: {
    /** AES-256-GCM key material for encrypting provider secrets at rest. */
    encryptionKey: secret('ENCRYPTION_KEY', '0000000000000000000000000000000000000000000000000000000000000000', mode),
  },

  quotes: {
    ttlSeconds: num('QUOTE_TTL_SECONDS', 90),
    highValueTtlSeconds: num('QUOTE_TTL_HIGH_VALUE_SECONDS', 45),
    maxRateAgeMs: num('QUOTE_MAX_RATE_AGE_MS', 30_000),
    /** Live mode refuses quotes below this; sandbox uses simulated rates. */
    requireLiveRates: bool('QUOTE_REQUIRE_LIVE_RATES', mode === 'production'),
  },

  payments: {
    /** Seconds the deposit watcher waits before expiring an unpaid intent. */
    depositWindowSeconds: num('DEPOSIT_WINDOW_SECONDS', 1800),
    /** Sandbox only: seconds each simulated pipeline step takes. */
    sandboxStepSeconds: num('SANDBOX_STEP_SECONDS', 3),
    sandboxConfirmationsPerSecond: num('SANDBOX_CONFIRMATIONS_PER_SECOND', 6),
    payoutRetryMax: num('PAYOUT_RETRY_MAX', 4),
    /** Above this KES amount the payer must type the recipient's last digits. */
    strongConfirmThresholdKes: num('STRONG_CONFIRM_THRESHOLD_KES', 100_000),
    /** Days after completion during which a refund request is accepted. */
    refundWindowDays: num('REFUND_WINDOW_DAYS', 30),
    /** Refunds below this KES amount are not worth the on-chain fee to return. */
    minRefundKes: num('MIN_REFUND_KES', 50),
  },

  fx: {
    provider: str('FX_PROVIDER', 'aurapay-sandbox-feed') as 'aurapay-sandbox-feed' | 'coinbase' | 'partner',
    apiKey: str('FX_PROVIDER_KEY', ''),
    apiSecret: str('FX_PROVIDER_SECRET', ''),
    refreshSeconds: num('FX_REFRESH_SECONDS', 12),
  },

  liquidity: {
    /** Alert when available KES for a rail drops below this (KES major units). */
    lowThresholdKes: num('LIQUIDITY_LOW_THRESHOLD_KES', 250_000),
    criticalThresholdKes: num('LIQUIDITY_CRITICAL_THRESHOLD_KES', 60_000),
    /** When false, an under-funded route is queued (pending) rather than auto-approved. */
    allowQueueOnInsufficient: bool('LIQUIDITY_ALLOW_QUEUE', true),
  },

  providers: {
    mpesa: {
      liveEnabled: bool('MPESA_LIVE_ENABLED', false),
      consumerKey: str('MPESA_CONSUMER_KEY', ''),
      consumerSecret: str('MPESA_CONSUMER_SECRET', ''),
      shortcode: str('MPESA_SHORTCODE', ''),
      passkey: str('MPESA_PASSKEY', ''),
      callbackUrl: str('MPESA_CALLBACK_URL', ''),
      sandboxBaseUrl: str('MPESA_SANDBOX_BASE_URL', 'https://sandbox.safaricom.co.ke'),
      liveBaseUrl: str('MPESA_LIVE_BASE_URL', 'https://api.safaricom.co.ke'),
    },
    airtel: {
      liveEnabled: bool('AIRTEL_LIVE_ENABLED', false),
      clientId: str('AIRTEL_CLIENT_ID', ''),
      clientSecret: str('AIRTEL_CLIENT_SECRET', ''),
      baseUrl: str('AIRTEL_BASE_URL', ''),
    },
    pesalink: { liveEnabled: bool('PESALINK_LIVE_ENABLED', false), partnerId: str('PESALINK_PARTNER_ID', '') },
    bank: { liveEnabled: bool('BANK_LIVE_ENABLED', false), host: str('BANK_API_HOST', '') },
  },

  blockchain: {
    tron: { liveEnabled: bool('CHAIN_TRON_LIVE_ENABLED', false), apiKey: str('TRON_API_KEY', ''), nodeUrl: str('TRON_NODE_URL', '') },
    ethereum: { liveEnabled: bool('CHAIN_ETHEREUM_LIVE_ENABLED', false), rpcUrl: str('ETHEREUM_RPC_URL', ''), apiKey: str('ETHERSCAN_API_KEY', '') },
    solana: { liveEnabled: bool('CHAIN_SOLANA_LIVE_ENABLED', false), rpcUrl: str('SOLANA_RPC_URL', ''), apiKey: str('SOLANA_API_KEY', '') },
    bnb: { liveEnabled: bool('CHAIN_BNB_LIVE_ENABLED', false), rpcUrl: str('BNB_RPC_URL', ''), apiKey: str('BSCSCAN_API_KEY', '') },
    /** Custody / wallet infrastructure partner (never holds raw keys in this app). */
    custody: { liveEnabled: bool('CUSTODY_LIVE_ENABLED', false), baseUrl: str('CUSTODY_BASE_URL', ''), apiKey: str('CUSTODY_API_KEY', '') },
    /** Deposit address derivation root for HD custody; keys live in the HSM/partner. */
    masterPublicKey: str('WALLET_MASTER_PUBLIC_KEY', ''),
  },

  compliance: {
    kycProvider: str('KYC_PROVIDER', 'none') as string,
    kycApiKey: str('KYC_PROVIDER_KEY', ''),
    amlProvider: str('AML_PROVIDER', 'none') as string,
    amlApiKey: str('AML_PROVIDER_KEY', ''),
    /** Fail-closed: production refuses money movement when a provider is unset. */
    requireProviders: bool('COMPLIANCE_REQUIRE_PROVIDERS', mode === 'production'),
    watchlistPath: str('SANCTIONS_WATCHLIST_PATH', ''),
    /** Sandbox allows demo identities to be "approved" through the admin queue. */
    allowManualApproval: bool('COMPLIANCE_ALLOW_MANUAL_APPROVAL', mode === 'sandbox'),
  },

  notifications: {
    emailProvider: str('EMAIL_PROVIDER', 'console') as 'console' | 'postmark' | 'ses',
    emailApiKey: str('EMAIL_API_KEY', ''),
    emailFrom: str('EMAIL_FROM', 'AuraPay <no-reply@aurapay.local>'),
    smsProvider: str('SMS_PROVIDER', 'console') as 'console' | 'africastalking',
    smsApiKey: str('SMS_API_KEY', ''),
    whatsappEnabled: bool('WHATSAPP_ENABLED', false),
    whatsappApiKey: str('WHATSAPP_API_KEY', ''),
  },

  observability: {
    sentryDsn: str('SENTRY_DSN', ''),
    otelEnabled: bool('OTEL_ENABLED', false),
    logLevel: str('LOG_LEVEL', mode === 'sandbox' ? 'info' : 'info') as LogLevel,
    prettyLogs: bool('PRETTY_LOGS', mode === 'sandbox'),
  },

  demo: {
    /** Exposes the "simulate deposit" control so the sandbox flow is completable. */
    sandboxActions: bool('SANDBOX_ACTIONS', mode === 'sandbox'),
    /** Public demo network visualization: synthetic, clearly-labelled data only. */
    demoNetworkEnabled: bool('DEMO_NETWORK_ENABLED', true),
    seedDemoData: bool('SEED_DEMO_DATA', true),
  },
} as const;

export type Config = typeof config;

/** Guards that make "no fake production claims" structural, not aspirational. */
export function assertProductionReady(): string[] {
  const problems: string[] = [];
  if (config.isProduction) {
    if (!config.database.url) problems.push('DATABASE_URL is required (managed Postgres).');
    if (config.database.driver !== 'postgres') problems.push('DATABASE_DRIVER must be "postgres".');
    if (!config.redis.enabled) problems.push('Redis is required for queues, rate limiting and SSE fan-out.');
    if (!config.providers.mpesa.liveEnabled) problems.push('No live mobile-money payout provider is enabled.');
    if (!config.fx.apiKey) problems.push('FX_PROVIDER_KEY is required — production must not use the sandbox feed.');
    if (config.quotes.requireLiveRates && config.fx.provider === 'aurapay-sandbox-feed')
      problems.push('Quotes are configured to require live rates but the sandbox feed is selected.');
    if (config.compliance.requireProviders && config.compliance.kycProvider === 'none')
      problems.push('A KYC provider must be configured before production money movement.');
    if (config.compliance.requireProviders && config.compliance.amlProvider === 'none')
      problems.push('An AML/sanctions screening provider must be configured before production money movement.');
    if (!config.observability.sentryDsn) problems.push('SENTRY_DSN is recommended (not blocking).');
  }
  return problems.filter((p) => !p.includes('recommended'));
}

export const LEGAL_DISCLAIMER =
  'AuraPay is not a licensed payment service provider or virtual asset service provider on its own. ' +
  'Any live value transfer in this build is simulated. Production money movement operates exclusively ' +
  'through licensed/regulated payment, custody, FX, KYC/AML and mobile-money partners that must be ' +
  'configured per jurisdiction.';
