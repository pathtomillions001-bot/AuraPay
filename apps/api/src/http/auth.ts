import type { FastifyInstance, FastifyReply } from 'fastify';
import { loginRequest, registerRequest } from '@aurapay/shared';
import { hasRole } from '@aurapay/shared';
import { config, LEGAL_DISCLAIMER } from '../config.js';
import * as identity from '../domain/identity.js';
import { DomainError } from '@aurapay/shared';
import { SESSION_COOKIE, clientMeta, requireAuth } from './util.js';

const cookieOptions = {
  path: '/',
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: config.isProduction,
  // Deliberately not signed: the value is a 256-bit random token whose *hash* is
  // what we store, so there is nothing to forge and no state in the cookie to
  // tamper with. `unsignCookie` would have to be called on every read, and a
  // forgotten call is a silent auth hole — so we do not put it in the path.
  signed: false,
};

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post('/v1/auth/register', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
    const body = registerRequest.parse(request.body ?? {});
    const created = identity.register({
      email: body.email,
      password: body.password,
      fullName: body.fullName,
      phone: body.phone ?? null,
      country: body.country,
    });
    // Self-registration starts at the lowest KYC tier with no saved recipients:
    // the account exists, and limits/verification are what the UI has to show.
    const session = identity.login({
      email: created.email,
      password: body.password,
      ...clientMeta(request),
    });
    setSession(reply, session.token);
    const user = identity.userById(session.userId);
    return { user: user ? identity.toPublicUser(user) : null, csrfToken: session.csrfToken, expiresAt: session.expiresAt };
  });

  app.post('/v1/auth/login', { config: { rateLimit: { max: 12, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const body = loginRequest.parse(request.body ?? {});
    let session;
    try {
      session = identity.login({
        email: body.email,
        password: body.password,
        totp: body.totp ?? null,
        ...clientMeta(request),
      });
    } catch (error) {
      // A missing code is not an auth failure: the client must know to ask for it
      // without locking the account down another notch.
      if (error instanceof identity.TotpRequiredError) {
        throw new DomainError('UNAUTHENTICATED', 'Enter the 6-digit code from your authenticator app.', {
          field: 'totp',
          requiresTotp: true,
        });
      }
      throw error;
    }
    setSession(reply, session.token);
    const user = identity.userById(session.userId);
    if (!user) throw new DomainError('UNAUTHENTICATED', 'That account could not be loaded.');
    return {
      user: identity.toPublicUser(user),
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
      // The client needs to know whether a code is required *before* it asks,
      // and an error message is not a place to negotiate protocol.
      requiresTotp: identity.hasTwoFactor(session.userId),
    };
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    identity.logout(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/v1/auth/session', async (request) => {
    const auth = requireAuth(request);
    const business = hasRole(auth.user.roles, 'MERCHANT')
      ? await import('../domain/merchants.js').then((m) => m.businessesForUser(auth.userId))
      : [];
    return {
      user: auth.user,
      csrfToken: auth.csrfToken,
      // The whole UI branches on this: sandbox data is labelled everywhere, and
      // the banner is not a marketing flourish, it is a disclosure.
      environment: {
        mode: config.mode,
        simulated: config.isSandbox,
        legalNote: LEGAL_DISCLAIMER,
      },
      merchant: { businesses: business },
      sessions: identity.listSessions(auth.userId, auth.sessionId),
    };
  });

  app.get('/v1/auth/sessions', async (request) => {
    const auth = requireAuth(request);
    return { sessions: identity.listSessions(auth.userId, auth.sessionId), devices: identity.listDevices(auth.userId) };
  });

  app.delete('/v1/auth/sessions/:sessionId', async (request) => {
    const auth = requireAuth(request);
    const { sessionId } = request.params as { sessionId: string };
    identity.revokeSession(auth.userId, sessionId);
    return { ok: true };
  });

  app.post('/v1/auth/sessions/revoke-others', async (request) => {
    const auth = requireAuth(request);
    return { revoked: identity.revokeOtherSessions(auth.userId, auth.sessionId) };
  });

  app.post('/v1/auth/totp/enrol', async (request) => {
    const auth = requireAuth(request);
    return identity.beginTwoFactorEnrolment(auth.userId);
  });

  app.post('/v1/auth/totp/confirm', async (request) => {
    const auth = requireAuth(request);
    const { code } = (request.body ?? {}) as { code?: string };
    if (!code) throw new DomainError('VALIDATION_FAILED', 'Enter the 6-digit code from your authenticator app.');
    return identity.confirmTwoFactorEnrolment(auth.userId, code);
  });

  app.post('/v1/auth/totp/disable', async (request) => {
    const auth = requireAuth(request);
    const { code } = (request.body ?? {}) as { code?: string };
    if (!code) throw new DomainError('VALIDATION_FAILED', 'Confirm your current code to turn two-step verification off.');
    identity.disableTwoFactor(auth.userId, code);
    return { ok: true };
  });

  app.post('/v1/auth/password', async (request) => {
    const auth = requireAuth(request);
    const { currentPassword, newPassword, code } = (request.body ?? {}) as {
      currentPassword?: string;
      newPassword?: string;
      code?: string;
    };
    if (!currentPassword || !newPassword) {
      throw new DomainError('VALIDATION_FAILED', 'Enter your current password and the new one.');
    }
    if (newPassword.length < 10) {
      throw new DomainError('VALIDATION_FAILED', 'Use at least 10 characters for your new password.');
    }
    identity.changePassword(auth.userId, currentPassword, newPassword, code ?? null, auth.sessionId);
    return { ok: true, note: 'Password changed. Other sessions were signed out.' };
  });

  app.patch('/v1/auth/profile', async (request) => {
    const auth = requireAuth(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    identity.updateProfile(auth.userId, {
      fullName: typeof body.fullName === 'string' ? body.fullName : undefined,
      phone: typeof body.phone === 'string' ? body.phone : null,
      city: typeof body.city === 'string' ? body.city : null,
      occupation: typeof body.occupation === 'string' ? body.occupation : null,
      sourceOfFunds: typeof body.sourceOfFunds === 'string' ? body.sourceOfFunds : null,
      defaultSettlementRail: typeof body.defaultSettlementRail === 'string' ? body.defaultSettlementRail : undefined,
      homeAsset: typeof body.homeAsset === 'string' ? body.homeAsset : undefined,
    });
    const user = identity.userById(auth.userId);
    return { user: user ? identity.toPublicUser(user) : auth.user };
  });

  app.get('/v1/auth/limits', async (request) => {
    const auth = requireAuth(request);
    return identity.limitsFor(auth.userId);
  });
}

function setSession(reply: FastifyReply, token: string): void {
  reply.cookie(SESSION_COOKIE, token, cookieOptions);
}
