/**
 * Every error surfaced to a user or an API client comes from this catalogue.
 * `message` is a human sentence, not an enum; the UI renders `message` plus a
 * recovery action. "Something went wrong" is not an acceptable string.
 */
export const ERROR_CODES = {
  VALIDATION_FAILED: {
    status: 400,
    message: 'Check the highlighted fields — the value entered is not valid.',
    recovery: 'fix_input',
  },
  UNAUTHENTICATED: {
    status: 401,
    message: 'Your session expired. Sign in again to continue.',
    recovery: 'sign_in',
  },
  FORBIDDEN: {
    status: 403,
    message: 'This account is not permitted to perform that action.',
    recovery: 'contact_support',
  },
  KYC_REQUIRED: {
    status: 403,
    message: 'Identity verification is required before this payment can be sent.',
    recovery: 'open_kyc',
  },
  LIMIT_EXCEEDED: {
    status: 403,
    message: 'This payment is above the limit for your account tier.',
    recovery: 'raise_limit',
  },
  RATE_LIMITED: {
    status: 429,
    message: 'Too many requests. Wait a moment before trying again.',
    recovery: 'retry_after',
  },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    message: 'That request was already submitted. Reusing the same key returns the original result.',
    recovery: 'view_transaction',
  },
  QUOTE_NOT_FOUND: {
    status: 404,
    message: 'That quote no longer exists. Request a new quote.',
    recovery: 'new_quote',
  },
  QUOTE_EXPIRED: {
    status: 409,
    message: 'Your quote expired. Get a new quote — the rate may have moved.',
    recovery: 'new_quote',
  },
  QUOTE_STALE_RATE: {
    status: 503,
    message: 'Exchange rates are not fresh right now. AuraPay never quotes from a stale rate.',
    recovery: 'retry_after',
  },
  QUOTE_ASSET_CHANGED: {
    status: 409,
    message: 'Network fee changed. Please review your new quote.',
    recovery: 'new_quote',
  },
  INSUFFICIENT_FUNDS: {
    status: 402,
    message: 'Not enough balance in that wallet to cover the payment plus fees.',
    recovery: 'choose_asset',
  },
  INSUFFICIENT_LIQUIDITY: {
    status: 503,
    message: 'Insufficient KES liquidity for this route right now. We can hold your payment as pending instead.',
    recovery: 'queue_pending',
  },
  RAIL_UNAVAILABLE: {
    status: 503,
    message: 'The M-Pesa payout provider is temporarily unavailable.',
    recovery: 'retry_later',
  },
  NETWORK_CONGESTED: {
    status: 503,
    message: 'The selected blockchain is congested. A different network will settle faster.',
    recovery: 'change_network',
  },
  DEPOSIT_NOT_DETECTED: {
    status: 409,
    message: 'Blockchain payment has not arrived yet. We are still watching the address for 30 minutes.',
    recovery: 'wait',
  },
  PAYMENT_UNDER_REVIEW: {
    status: 423,
    message: 'Your payment is under review by our compliance team. We will notify you when it clears.',
    recovery: 'view_review',
  },
  PAYMENT_NOT_REFUNDABLE: {
    status: 409,
    message: 'This payment cannot be refunded through the original rail. Contact support for a manual reversal.',
    recovery: 'contact_support',
  },
  RECIPIENT_UNVERIFIED: {
    status: 400,
    message: 'We could not match that phone number to a registered name. Double-check it before sending.',
    recovery: 'verify_recipient',
  },
  SANCTIONS_HIT: {
    status: 403,
    message: 'This payment was blocked by screening and requires compliance review.',
    recovery: 'contact_support',
  },
  WALLET_SCREENING_HIT: {
    status: 403,
    message: 'The deposit address used is associated with a restricted counterparty and cannot be accepted.',
    recovery: 'contact_support',
  },
  CSRF_FAILED: {
    status: 403,
    message: 'Request origin check failed. Reload the page and try again.',
    recovery: 'reload',
  },
  WEBHOOK_SECRET_MISSING: {
    status: 400,
    message: 'Add a signing secret for this endpoint before sending test events.',
    recovery: 'open_webhooks',
  },
  PROVIDER_KEY_MISSING: {
    status: 501,
    message: 'No live provider is configured for this operation. Sandbox mode is active — nothing was sent.',
    recovery: 'open_settings',
  },
  NOT_FOUND: {
    status: 404,
    message: 'We could not find that record.',
    recovery: 'go_back',
  },
  CONFLICT: {
    status: 409,
    message: 'That action conflicts with the current state of the payment.',
    recovery: 'refresh',
  },
  INTERNAL: {
    status: 500,
    message: 'Our service hit an internal error. The reference below was logged for the support team.',
    recovery: 'contact_support',
  },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export function statusFor(code: ErrorCode): number {
  return ERROR_CODES[code]?.status ?? 500;
}

export function messageFor(code: ErrorCode): string {
  return ERROR_CODES[code]?.message ?? 'The request could not be completed.';
}

export function recoveryFor(code: ErrorCode): string {
  return ERROR_CODES[code]?.recovery ?? 'contact_support';
}

/** Error thrown by domain services; the HTTP layer maps it to a response body. */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    override readonly message: string = messageFor(code),
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DomainError';
  }

  get status(): number {
    return statusFor(this.code);
  }

  get recovery(): string {
    return recoveryFor(this.code);
  }

  toBody() {
    return {
      error: {
        code: this.code,
        message: this.message,
        recovery: this.recovery,
        details: this.details,
      },
    };
  }
}
