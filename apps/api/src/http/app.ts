import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { declareAuth, registerErrorHandling, registerSerializers } from './util.js';
import { registerAuthRoutes } from './auth.js';
import { registerPaymentRoutes } from './payments.js';
import { registerAccountRoutes } from './account.js';
import { registerMerchantRoutes } from './merchant.js';
import { registerAdminRoutes } from './admin.js';
import { registerRealtimeRoutes } from './realtime.js';
import { registerPublicRoutes } from './public.js';

const log = createLogger('http');

export interface BuildOptions {
  /** The web app origin is the only browser origin allowed in sandbox. */
  origins?: string[];
  logger?: boolean;
}

export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: config.observability.logLevel,
            // Money payloads can carry a full recipient record; redact anything
            // that could be replayed or sold.
            redact: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.body.password',
              'req.body.currentPassword',
              'req.body.newPassword',
              'req.body.secret',
              'req.body.totp',
              'req.body.code',
              '*.cardNumber',
              '*.bankAccount',
              '*.privateKey',
            ],
            transport:
              config.env === 'development' && process.env.PINO_PRETTY === '1'
                ? { target: 'pino/file', options: { destination: 1 } }
                : undefined,
          },
    trustProxy: config.security.trustProxy,
    bodyLimit: 512 * 1024,
    disableRequestLogging: false,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false, // the API serves JSON; the web app sets its own CSP
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
  });

  await app.register(cors, {
    origin: config.security.csrfAllowOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'authorization', 'x-csrf-token', 'idempotency-key', 'x-aurapay-request'],
    exposedHeaders: ['x-aurapay-request'],
  });

  await app.register(cookie, { secret: config.security.sessionSecret });

  // Order matters: the session is resolved first so the limiter can budget per
  // account, and the error handler is installed first so a rejection *during*
  // auth still answers with a readable JSON error instead of a stack trace.
  registerErrorHandling(app);
  declareAuth(app);

  await app.register(rateLimit, {
    global: true,
    max: config.security.rateLimitMax,
    timeWindow: config.security.rateLimitWindowMs,
    // Signed-in traffic is limited per account, anonymous per address: one busy
    // office NAT must not lock every customer out of paying.
    keyGenerator: (request) => {
      const userId = request.auth?.userId;
      return userId ? `u:${userId}` : `ip:${request.ip}`;
    },
    errorResponseBuilder: () => ({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests in a short time. Wait a moment and try again — nothing was charged.',
        recovery: 'retry_later',
      },
    }),
  });

  registerSerializers(app);

  registerPublicRoutes(app);
  registerAuthRoutes(app);
  registerPaymentRoutes(app);
  registerAccountRoutes(app);
  registerMerchantRoutes(app);
  registerAdminRoutes(app);
  registerRealtimeRoutes(app);

  app.addHook('onClose', async () => {
    log.info('http server closing');
  });

  return app;
}
