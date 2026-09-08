import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { id, nowIso } from '../lib/ids.js';
import { publish } from './realtime.js';
import { createLogger } from '../logger.js';
import { emailFor } from './identity.js';
import { stringify } from '../lib/json.js';

const log = createLogger('notifications');

/**
 * Notification service.
 *
 * In-app delivery is always on and is the only channel that is *assumed* to
 * work. Email/SMS/WhatsApp go through `message_log` rows and a provider
 * abstraction; with no provider configured the transport is `console`, which is
 * honest in sandbox and loud in production (`PROVIDER_KEY_MISSING` is recorded
 * against the message rather than pretending it was sent).
 *
 * Message templates never invent payment state: they are emitted by the payment
 * pipeline at a real transition.
 */

export type Severity = 'info' | 'success' | 'warning' | 'critical';
export type Channel = 'in_app' | 'email' | 'sms' | 'whatsapp';

export interface PushInput {
  title: string;
  body: string;
  severity?: Severity;
  link?: string | null;
  paymentIntentId?: string | null;
  /** Additional channels beyond in-app. Defaults to in-app + email for critical. */
  channels?: Channel[];
}

export function push(userId: string, input: PushInput): void {
  if (!userId) return;
  const db = getDb();
  const notificationId = id('ntf');
  const severity = input.severity ?? 'info';
  const channels = input.channels ?? (severity === 'critical' ? (['in_app', 'email'] as Channel[]) : (['in_app'] as Channel[]));
  db.tx(() => {
    if (channels.includes('in_app')) {
      db.run(
        `INSERT INTO notifications (id, user_id, title, body, channel, severity, link, payment_intent_id, created_at)
         VALUES (?,?,?,?, 'in_app', ?,?,?,?)`,
        [notificationId, userId, input.title, input.body, severity, input.link ?? null, input.paymentIntentId ?? null, nowIso()],
      );
    }
    for (const channel of channels.filter((c) => c !== 'in_app')) {
      queueMessage(userId, channel, input, severity);
    }
  });

  if (channels.includes('in_app')) {
    publish(`user:${userId}`, 'notifications', 'notification.new', {
      id: notificationId,
      title: input.title,
      body: input.body,
      severity,
      link: input.link ?? null,
      createdAt: nowIso(),
      readAt: null,
      channel: 'in_app',
      paymentIntentId: input.paymentIntentId ?? null,
    });
  }
}

function queueMessage(userId: string, channel: Channel, input: PushInput, severity: Severity): void {
  const db = getDb();
  const user = db.maybeOne<{ phone: string | null; email: string }>('SELECT phone, email FROM users WHERE id = ?', [userId]);
  const to = channel === 'email' ? (user?.email ?? emailFor(userId)) : (user?.phone ?? null);
  if (!to) {
    db.run(
      `INSERT INTO message_log (id, user_id, channel, recipient, template, body, status, provider, error, data_origin, created_at)
       VALUES (?,?,?,?,?,?, 'SKIPPED',?,?,?,?)`,
      [id('msg'), userId, channel, '(none on file)', input.title, input.body, 'none', `no ${channel} contact on file`, config.isSandbox ? 'sandbox' : 'live', nowIso()],
    );
    return;
  }
  const transport = transportFor(channel);
  db.run(
    `INSERT INTO message_log (id, user_id, channel, recipient, template, body, status, provider, data_origin, created_at)
     VALUES (?,?,?,?,?,?, 'QUEUED',?,?,?)`,
    [id('msg'), userId, channel, maskTarget(channel, to), input.title, input.body, transport.name, config.isSandbox ? 'sandbox' : 'live', nowIso()],
  );
  db.run(
    `INSERT INTO job_queue (id, type, payload, status, run_at, attempts, max_attempts, created_at, updated_at)
     VALUES (?,?,?, 'READY',?, 0, 4, ?, ?)`,
    [id('job'), 'message.send', stringify({ userId, channel, severity, title: input.title, body: input.body }), nowIso(), nowIso(), nowIso()],
  );
}

interface Transport {
  readonly name: string;
  readonly simulated: boolean;
  send(to: string, subject: string, body: string): Promise<{ ok: boolean; providerId?: string; error?: string }>;
}

const consoleTransport: Transport = {
  name: 'console',
  simulated: true,
  async send(to, subject, body) {
    log.info('console transport (nothing was delivered externally)', { to, subject, body: body.slice(0, 120) });
    return { ok: true, providerId: `console-${Date.now().toString(36)}` };
  },
};

/**
 * HTTP transports are configured by env vars; with no key they report
 * `simulated: true` and the message log records that, so nobody can read a
 * "sent" status as a delivery receipt.
 */
function transportFor(channel: Channel): Transport {
  if (channel === 'email' && config.notifications.emailProvider !== 'console' && config.notifications.emailApiKey) {
    return {
      name: `http:${config.notifications.emailProvider}`,
      simulated: false,
      async send(to, subject, body) {
        try {
          const res = await fetch('https://api.postmarkapp.com/emails', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-postmark-serverkey': config.notifications.emailApiKey },
            body: stringify({ From: config.notifications.emailFrom, To: to, Subject: subject, TextBody: body }),
          });
          return res.ok ? { ok: true } : { ok: false, error: `email provider replied ${res.status}` };
        } catch (error) {
          return { ok: false, error: (error as Error).message };
        }
      },
    };
  }
  if (channel === 'sms' && config.notifications.smsProvider !== 'console' && config.notifications.smsApiKey) {
    return {
      name: 'http:africastalking',
      simulated: false,
      async send(to, _subject, body) {
        try {
          const res = await fetch('https://api.africastalking.com/version1/messaging', {
            method: 'POST',
            headers: { apiKey: config.notifications.smsApiKey, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
            body: new URLSearchParams({ username: 'aurapay', to, message: body }).toString(),
          });
          return res.ok ? { ok: true } : { ok: false, error: `sms provider replied ${res.status}` };
        } catch (error) {
          return { ok: false, error: (error as Error).message };
        }
      },
    };
  }
  return consoleTransport;
}

export async function processMessage(messageId: string): Promise<'SENT' | 'RETRY' | 'FAILED'> {
  const db = getDb();
  const row = db.maybeOne<{ id: string; channel: Channel; user_id: string; template: string; body: string }>(
    'SELECT id, channel, user_id, template, body FROM message_log WHERE id = ?',
    [messageId],
  );
  if (!row) return 'FAILED';
  const user = db.maybeOne<{ phone: string | null; email: string }>('SELECT phone, email FROM users WHERE id = ?', [row.user_id]);
  const target = row.channel === 'email' ? (user?.email ?? '') : (user?.phone ?? '');
  const transport = transportFor(row.channel);
  const result = await transport.send(target, row.template, row.body);
  db.run('UPDATE message_log SET status = ?, provider = ?, error = ? WHERE id = ?', [
    result.ok ? (transport.simulated ? 'SIMULATED' : 'SENT') : 'RETRY',
    transport.name,
    result.error ?? (transport.simulated ? 'no external transport configured' : null),
    messageId,
  ]);
  return result.ok ? 'SENT' : 'RETRY';
}

export function list(userId: string, opts: { unreadOnly?: boolean; limit?: number } = {}) {
  const db = getDb();
  const limit = opts.limit ?? 40;
  const rows = db.all<{
    id: string;
    title: string;
    body: string;
    channel: Channel;
    severity: Severity;
    read_at: string | null;
    created_at: string;
    link: string | null;
    payment_intent_id: string | null;
  }>(
    `SELECT * FROM notifications WHERE user_id = ? ${opts.unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT ?`,
    [userId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    channel: r.channel,
    severity: r.severity,
    readAt: r.read_at,
    createdAt: r.created_at,
    link: r.link,
    paymentIntentId: r.payment_intent_id,
  }));
}

export function unreadCount(userId: string): number {
  return (
    getDb().maybeOne<{ c: number }>('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL', [userId])?.c ?? 0
  );
}

export function markRead(userId: string, notificationId: string | null): void {
  const db = getDb();
  if (notificationId) {
    db.run('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL', [nowIso(), notificationId, userId]);
    return;
  }
  db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', [nowIso(), userId]);
}

export function channelStatus(): Array<{ channel: Channel; enabled: boolean; transport: string; simulated: boolean; note: string }> {
  return [
    {
      channel: 'in_app',
      enabled: true,
      transport: 'database+sse',
      simulated: false,
      note: 'Always available. Delivered in-app and over the realtime stream.',
    },
    {
      channel: 'email',
      enabled: config.notifications.emailProvider !== 'console',
      transport: transportFor('email').name,
      simulated: transportFor('email').simulated,
      note: config.notifications.emailProvider === 'console' ? 'No email provider key set — messages are logged only, not sent.' : 'Sending via the configured provider.',
    },
    {
      channel: 'sms',
      enabled: config.notifications.smsProvider !== 'console',
      transport: transportFor('sms').name,
      simulated: transportFor('sms').simulated,
      note:
        config.notifications.smsProvider === 'console'
          ? 'No SMS provider key set — messages are logged only, not sent. Sender ID registration is required before transactional SMS.'
          : 'Sending via the configured provider.',
    },
    {
      channel: 'whatsapp',
      enabled: config.notifications.whatsappEnabled,
      transport: config.notifications.whatsappEnabled ? 'http:whatsapp-cloud-api' : 'none',
      simulated: !config.notifications.whatsappEnabled,
      note: config.notifications.whatsappEnabled
        ? 'Template-based messaging only; free-form marketing messages are not permitted on this channel.'
        : 'Disabled. Requires an approved business messaging template set per destination country.',
    },
  ];
}

function maskTarget(channel: Channel, target: string): string {
  if (channel === 'email') {
    const [name, domain] = target.split('@');
    return `${(name ?? '').slice(0, 2)}${'•'.repeat(Math.max(2, (name ?? '').length - 2))}@${domain ?? ''}`;
  }
  return `${target.slice(0, 3)}•••${target.slice(-2)}`;
}
