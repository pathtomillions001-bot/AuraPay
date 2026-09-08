import { hasRole } from '@aurapay/shared';
import type { FastifyInstance } from 'fastify';
import { DomainError } from '@aurapay/shared';
import * as realtime from '../domain/realtime.js';
import type { BusEvent } from '../domain/realtime.js';
import * as merchants from '../domain/merchants.js';
import { createLogger } from '../logger.js';
import { requireAuth } from './util.js';

const log = createLogger('realtime');

/**
 * Server-sent events, one connection per signed-in subject.
 *
 * Why SSE rather than WebSockets: the only thing we push is state the server
 * already decided, the browser's EventSource reconnects on its own, and the
 * reconnect path can be told to refetch. A payment must never depend on a
 * socket staying open — which is exactly why every screen here can also be
 * polled, and why no route treats a lost event as a lost payment.
 *
 * Events are advisory: the payload says "this changed", never "you may release
 * the goods". Clients that care re-read /v1/payments/:id.
 */
export function registerRealtimeRoutes(app: FastifyInstance): void {
  app.get('/v1/realtime/stream', async (request, reply) => {
    const auth = requireAuth(request);
    const scopes = new Set<string>([`user:${auth.userId}`, 'public']);
    const requested = (request.query as { scope?: string }).scope;
    if (requested) {
      // A merchant may subscribe to their own business scope, and nothing else:
      // scopes are resolved from ownership, never trusted from the query string.
      const owned = new Set(merchants.businessesForUser(auth.userId).map((b) => `merchant:${b.id}`));
      if (!owned.has(requested)) {
        throw new DomainError('FORBIDDEN', 'You can only subscribe to a business you belong to.');
      }
      scopes.add(requested);
    }
    if (hasRole(auth.user.roles, 'ADMIN')) scopes.add('admin');

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Without this a buffering proxy turns a live feed into a page that hangs.
      'X-Accel-Buffering': 'no',
    });

    // `seq` is attached by the bus at emit time; it is not part of BusEvent.
    type Wire = BusEvent & { seq?: number };
    const send = (evt: Wire) => {
      // Data is merged into the payload so the client can read `data.paymentId`
      // directly instead of unwrapping a second envelope for every event type.
      const data = typeof evt.data === 'object' && evt.data !== null ? (evt.data as Record<string, unknown>) : { value: evt.data };
      const frame = JSON.stringify({ channel: evt.channel, type: evt.type, at: evt.at, ...data });
      raw.write(`id: ${evt.seq ?? 0}\nevent: ${evt.type}\ndata: ${frame}\n\n`);
    };

    // The bus is in-process and not a queue, so a gap cannot be replayed. Saying
    // so is the correct behaviour: the client refetches instead of guessing.
    const sinceHeader = Number(request.headers['last-event-id'] ?? 0);
    const queue: Wire[] = [];
    let flushing = false;
    const flush = () => {
      if (flushing) return;
      flushing = true;
      while (queue.length) {
        const next = queue.shift();
        if (next) send(next);
      }
      flushing = false;
    };

    // Subscribe before announcing: events published during the handshake must not
    // be dropped between the write and the subscription.
    const unsubs = [...scopes].map((scope) =>
      realtime.subscribe(scope, (event: Wire) => {
        queue.push(event);
        flush();
      }),
    );

    raw.write('retry: 1500\n\n');
    if (Number.isFinite(sinceHeader) && sinceHeader > 0) {
      send({
        scope: `user:${auth.userId}`,
        channel: 'notifications',
        type: 'resync',
        at: new Date().toISOString(),
        seq: realtime.currentSeq(),
        data: {
          reason: 'stream_restarted',
          // A reconnect must leave the customer with the truth, so we tell them
          // exactly what to refetch rather than trying to replay a gap we cannot see.
          refetch: ['/v1/account/overview', '/v1/payments?limit=10'],
        },
      });
    }
    send({
      scope: `user:${auth.userId}`,
      channel: 'notifications',
      type: 'connected',
      at: new Date().toISOString(),
      seq: realtime.currentSeq(),
      data: { scopes: [...scopes], subscribers: realtime.subscriberCount(`user:${auth.userId}`) },
    });
    flush();

    const heartbeat = setInterval(() => {
      if (raw.writableEnded) return;
      raw.write(`: ping ${new Date().toISOString()}\n\n`);
    }, 15_000);

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      for (const off of unsubs) off();
      log.debug('realtime stream closed', { userId: auth.userId });
      if (!raw.writableEnded) raw.end();
    };
    request.raw.on('close', close);
    request.raw.on('error', close);
  });
}
