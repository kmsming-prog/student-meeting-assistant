import { configuration } from './config.mjs';
import { calendarWebhookPath } from './calendar-watch.mjs';
import { GoogleCalendar } from './google.mjs';
import { LineClient, lineAction } from './line.mjs';
import { installBookingMenu, isMenuImage, linkBookingMenu, publishBookingMenu } from './menu.mjs';
import { readLimited, tokenMatches, verifyLine } from './security.mjs';
import { MeetingAssistant, safeError } from './service.mjs';
import { Store } from './store.mjs';

const decoder = new TextDecoder('utf-8', { fatal: true });
const casePattern = /^\/admin\/cases\/([a-z0-9-]{36})\/close$/;
const bookingPattern = /^\/admin\/bookings\/([a-z0-9-]{36})\/close$/;
const revokePattern = /^\/admin\/bindings\/([a-z][a-z0-9_-]{0,23})\/revoke$/;

function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

function assistant(env) {
  return new MeetingAssistant({
    config: configuration(env),
    store: new Store(env.DB),
    google: new GoogleCalendar(env),
    line: new LineClient(env),
    calendarCallback: env.CALENDAR_WEBHOOK_URL,
  });
}

async function body(request, limit) {
  try {
    const result = JSON.parse(decoder.decode(await readLimited(request, limit)));
    return result && typeof result === 'object' && !Array.isArray(result) ? result : null;
  } catch {
    return null;
  }
}

async function lineWebhook(request, env, ctx) {
  const signature = request.headers.get('x-line-signature');
  if (!env.LINE_CHANNEL_SECRET) return json({ error: 'webhook_unconfigured' }, 503);
  if (!/^[A-Za-z0-9+/]{43}=$/.test(signature ?? '')) return json({ error: 'signature' }, 401);
  let raw;
  try {
    raw = await readLimited(request, 256 * 1024);
  } catch {
    return json({ error: 'invalid_body' }, 400);
  }
  if (!await verifyLine(raw, signature, env.LINE_CHANNEL_SECRET)) return json({ error: 'signature' }, 401);

  let payload;
  try {
    payload = JSON.parse(decoder.decode(raw));
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  if (!Array.isArray(payload?.events)) return json({ error: 'invalid_events' }, 400);
  if (!payload.events.length) return json({ ok: true });
  const actions = payload.events.filter(event => event && typeof event === 'object').map(lineAction).filter(Boolean);
  if (!actions.length) return json({ ok: true });

  const app = assistant(env);
  const tasks = [];
  const work = [];
  let drain = false;
  const defer = (task, operation) => tasks.push(task.catch(error => console.warn(operation, safeError(error))));
  for (const action of actions) {
    const result = await app.onLine(action);
    if (typeof action.replyToken === 'string' && action.replyToken) {
      if (result.bookingUser) {
        const { userId, key, timestamp, conflictId } = result.bookingUser;
        defer(app.bookings.offer(userId, key, timestamp, conflictId)
          .then(message => app.line.reply(action.replyToken, message)), 'line_booking_offer');
      } else if (result.reply) {
        defer(app.line.reply(action.replyToken, result.reply), 'line_reply');
      }
    }
    if (result.menuUser) defer(linkBookingMenu(app.store, app.line, result.menuUser), 'line_booking_menu');
    if (result.caseId || result.bookingId) work.push(result);
    if (result.drain) drain = true;
  }
  if (tasks.length || work.length || drain) ctx.waitUntil((async () => {
    await Promise.all(tasks);
    const first = work[0];
    if (first?.caseId) await app.applyOne(first.caseId);
    if (first?.bookingId) await app.bookings.applyOne(first.bookingId);
    if (first || drain) await app.drain(2);
  })().catch(error => console.error('webhook_background', safeError(error))));
  return json({ ok: true });
}

function processCalendarChanges(app, ctx, renew = false) {
  ctx.waitUntil((async () => {
    await Promise.all([app.conflicts.run(), renew ? app.calendarWatch.renew() : null]);
    await app.drain();
  })().catch(error => console.warn('calendar_monitor_background', safeError(error))));
}

async function admin(request, path, env, ctx) {
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Bearer ') || !await tokenMatches(header.slice(7), env.ADMIN_TOKEN)) {
    return json({ error: 'unauthorized' }, 401);
  }
  const app = assistant(env);
  const { store, config } = app;
  const now = Date.now();
  const get = request.method === 'GET';
  const post = request.method === 'POST';
  if (get && path === '/admin/status') {
    await store.setup(config.keys);
    return json({ ...await store.runtime(), ...await store.status(now) });
  }
  if (get && path === '/admin/preflight') return json(await app.preflight());
  if (get && path === '/admin/conflicts') return json(await app.conflicts.status());
  if (post && path === '/admin/conflicts') {
    const input = await body(request, 1024);
    if (typeof input?.enabled !== 'boolean') return json({ error: 'invalid_switch' }, 400);
    if (input.enabled) {
      const check = await app.preflight();
      if (check.google.error || check.line.error || !env.LINE_CHANNEL_SECRET) {
        return json({ error: 'preflight_failed', check }, 409);
      }
      await store.setup(config.keys);
    }
    await app.conflicts.setEnabled(input.enabled);
    if (input.enabled) processCalendarChanges(app, ctx, true);
    return json({ enabled: input.enabled });
  }
  if (get && path === '/admin/preview') return json({ conflicts: await app.preview() });
  if (post && path === '/admin/booking-menu') {
    let png;
    try {
      png = await readLimited(request, 512 * 1024);
    } catch {
      return json({ error: 'invalid_menu_image' }, 400);
    }
    if (!isMenuImage(png)) return json({ error: 'invalid_menu_image' }, 400);
    const bindings = await installBookingMenu(store, app.line, png);
    const requested = new URL(request.url).searchParams.get('default') === '1';
    return json(requested ? { bindings, defaultMenu: await publishBookingMenu(store, app.line) } : { bindings });
  }
  if (post && path === '/admin/invites') {
    const input = await body(request, 1024);
    if (!config.keys.includes(input?.key)) return json({ error: 'unknown_participant' }, 400);
    await store.setup(config.keys);
    const invite = await app.issueInvite(input.key);
    return invite ? json(invite, 201) : json({ error: 'already_bound' }, 409);
  }
  if (post && path === '/admin/line-test') {
    const result = await app.testLine();
    if (!result) return json({ error: 'teacher_not_bound' }, 409);
    ctx.waitUntil(app.drain(2).catch(error => console.error('line_test_background', safeError(error))));
    return json(result, 202);
  }
  if (post && path === '/admin/automation') {
    const input = await body(request, 1024);
    if (typeof input?.enabled !== 'boolean') return json({ error: 'invalid_switch' }, 400);
    if (input.enabled) {
      const check = await app.preflight();
      if (check.google.error || check.line.error || check.google.series.some(series => series.matchingInstances === 0) ||
          !env.LINE_CHANNEL_SECRET) return json({ error: 'preflight_failed', check }, 409);
    }
    if (!await store.setAutomation(input.enabled, config.keys, now)) return json({ error: 'binding_required' }, 409);
    return json({ enabled: input.enabled });
  }
  const close = casePattern.exec(path);
  if (post && close) {
    const row = await store.case(close[1]);
    if (!row) return json({ error: 'case_not_found' }, 404);
    if (!['review', 'offered'].includes(row.state) || !await store.transition(row, 'closed', 'manual', [], now)) {
      return json({ error: 'case_cannot_close' }, 409);
    }
    return json({ id: row.id, state: 'closed' });
  }
  const closeBooking = bookingPattern.exec(path);
  if (post && closeBooking) {
    const id = closeBooking[1];
    return await app.bookings.close(id) ? json({ id, state: 'closed' }) : json({ error: 'booking_cannot_close' }, 409);
  }
  const revoke = revokePattern.exec(path);
  if (post && revoke && config.keys.includes(revoke[1])) {
    return json({ revoked: await store.revoke(revoke[1], now) });
  }
  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === '/healthz' && request.method === 'GET') return json({ ok: true, version: '0.4.8' });
    try {
      if (path === '/line/webhook' && request.method === 'POST') return await lineWebhook(request, env, ctx);
      if (path === calendarWebhookPath && request.method === 'POST') {
        const app = assistant(env);
        const signal = await app.calendarWatch.receive(request.headers);
        if (!signal) return json({ error: 'unauthorized' }, 401);
        if (signal.scan) processCalendarChanges(app, ctx);
        return new Response(null, { status: 204 });
      }
      if (path.startsWith('/admin/')) return await admin(request, path, env, ctx);
      return json({ error: 'not_found' }, 404);
    } catch (error) {
      const code = safeError(error);
      console.error('request_failed', code);
      return json({ error: path.startsWith('/admin/') ? code : 'internal_error' }, 503);
    }
  },
  async scheduled(controller, env) {
    try {
      if (env.MEETING_PROFILE) await assistant(env).scheduled(controller.scheduledTime);
    } catch (error) {
      console.error('cron_failed', safeError(error));
      throw new Error('cron_failed');
    }
  },
};
