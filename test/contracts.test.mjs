import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';
import { bookingEventId, BOOKING_MARKER, GoogleCalendar, MOVE_MARKER } from '../src/google.mjs';
import { LineClient, lineAction } from '../src/line.mjs';
import worker from '../src/worker.mjs';
import { HOUR, iso, MEETING_LENGTH } from '../src/time.mjs';
import { bookingCardActions, database, ids, menuId, monday, profile, thursday, sampleEvents } from './helper.mjs';

test('Calendar adapter uses scoped service OAuth, expands pages and PATCHes only the chosen occurrence with If-Match', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const credential = JSON.stringify({
    type: 'service_account', client_email: 'fixture@local-test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });
  const calls = [];
  const expected = sampleEvents()[0];
  const bookingId = crypto.randomUUID();
  const original = { id: bookingEventId(bookingId), etag: expected.etag, status: 'confirmed',
    extendedProperties: { private: { [BOOKING_MARKER]: bookingId } } };
  const channel = {
    id: crypto.randomUUID(), token: 'fixture-token', address: 'https://worker.example.com/google/calendar/webhook',
    type: 'web_hook', params: { ttl: '604800' },
  };
  const google = new GoogleCalendar({ GOOGLE_SERVICE_ACCOUNT: credential }, async (url, init) => {
    assert.equal(init.redirect, 'manual');
    if (url === 'https://oauth2.googleapis.com/token') {
      const parts = init.body.get('assertion').split('.');
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
      assert.equal(claims.aud, url);
      assert.equal(claims.sub, undefined);
      assert.deepEqual(claims.scope.split(' ').map(value => value.split('/').at(-1)), ['calendar.events', 'calendar.events.freebusy']);
      assert.ok(verify('sha256', Buffer.from(parts.slice(0, 2).join('.')), publicKey, Buffer.from(parts[2], 'base64url')));
      return Response.json({ access_token: 'local-mock', expires_in: 3600 });
    }
    const address = new URL(url);
    calls.push({ address, init });
    assert.equal(init.headers.authorization, 'Bearer local-mock');
    if (init.method === 'PATCH') {
      const body = JSON.parse(init.body);
      const source = address.pathname.endsWith('/events/' + original.id) ? original : expected;
      const properties = source === original ? { [BOOKING_MARKER]: bookingId } : { preserved: 'yes' };
      assert.equal(init.headers['if-match'], expected.etag);
      assert.equal(address.pathname.endsWith('/events/' + source.id), true);
      assert.equal(address.searchParams.get('sendUpdates'), 'none');
      assert.equal(body.start.dateTime, iso(thursday));
      assert.equal(body.start.timeZone, 'Asia/Taipei');
      assert.deepEqual(body.extendedProperties.private, { ...properties, [MOVE_MARKER]: 'case-test' });
      assert.equal(body.recurrence, undefined);
      return Response.json({ ...source, ...body });
    }
    if (address.pathname.endsWith('/events/watch')) {
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), channel);
      return Response.json({ id: channel.id, resourceId: 'resource-fixture', expiration: '1800000000000' });
    }
    if (address.pathname.endsWith('/freeBusy')) return Response.json({ calendars: { 'extra@example.com': { errors: [{ reason: 'notFound' }] } } });
    assert.equal(address.searchParams.get('singleEvents'), 'true');
    if (!address.searchParams.has('pageToken')) return Response.json({ accessRole: 'writer', nextPageToken: 'p2', items: [expected] });
    return Response.json({ accessRole: 'writer', items: [] });
  });
  const listed = await google.list(profile.calendarId, thursday - 24 * HOUR, thursday + 24 * HOUR);
  assert.equal(listed.items.length, 1);
  await assert.rejects(google.extraBusy(['extra@example.com'], thursday, thursday + HOUR), /busy_calendar_unavailable/);
  await assert.rejects(google.move(profile.calendarId, { ...expected, recurrence: ['RRULE:FREQ=WEEKLY'] }, { start: thursday, end: thursday + HOUR }, 'case-test'),
    /refused_non_instance/);
  const moved = await google.move(profile.calendarId, { ...expected, extendedProperties: { private: { preserved: 'yes' } } },
    { start: thursday, end: thursday + HOUR }, 'case-test');
  assert.equal(moved.start.dateTime, iso(thursday));
  const extra = await google.moveBooking(profile.calendarId, original,
    { start: thursday, end: thursday + MEETING_LENGTH }, bookingId, 'case-test');
  assert.equal(extra.id, original.id);
  const watching = await google.watch(profile.calendarId, channel.id, channel.token, channel.address);
  assert.equal(watching.resourceId, 'resource-fixture');
  assert.equal(calls.length, 6);
});

test('LINE client recognizes accepted retry without sending a different request', async () => {
  const retryKey = crypto.randomUUID();
  const line = new LineClient({ LINE_CHANNEL_ACCESS_TOKEN: 'fixture-only' }, async (url, init) => {
    assert.equal(url, 'https://api.line.me/v2/bot/message/push');
    assert.equal(init.headers['x-line-retry-key'], retryKey);
    assert.equal(JSON.parse(init.body).to, ids.teacher);
    return new Response(null, { status: 409, headers: { 'x-line-accepted-request-id': 'fake-line-request' } });
  });
  await line.push(ids.teacher, { type: 'text', text: 'test' }, retryKey);
});

test('LINE calls the Worker fetch function without attaching the client or automatically following redirects', async () => {
  const line = new LineClient({ LINE_CHANNEL_ACCESS_TOKEN: 'fixture-only' }, async function (url, init) {
    assert.equal(this, undefined);
    assert.equal(url, 'https://api.line.me/v2/bot/info');
    assert.equal(init.redirect, 'manual');
    return Response.json({ basicId: '@rma-fixture' });
  });
  assert.equal((await line.info()).basicId, '@rma-fixture');
});

test('webhook HMAC uses the raw request and rejects tampering, missing signatures, and group actions', async () => {
  const { db } = database();
  const env = { DB: db, LINE_CHANNEL_SECRET: 'local-fixture-line-secret', MEETING_PROFILE: JSON.stringify(profile) };
  const url = 'https://worker.example.com/line/webhook';
  const original = '{ "events" : [] }';
  const signer = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.LINE_CHANNEL_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = Buffer.from(await crypto.subtle.sign('HMAC', signer, new TextEncoder().encode(original))).toString('base64');
  const ctx = { waitUntil() {} };
  const send = (body, signed) => worker.fetch(new Request(url, {
    method: 'POST', body, headers: signed ? { 'X-LINE-Signature': signature } : {},
  }), env, ctx);
  assert.equal((await send(original, true)).status, 200);
  assert.equal((await send(JSON.stringify({ events: [] }), true)).status, 401);
  assert.equal((await send(original, false)).status, 401);
  assert.equal(lineAction({ type: 'postback', source: { type: 'group', userId: ids.lin } }), null);
});

test('teacher pilot works through the signed Worker route, D1 and LINE push without a Calendar request', async t => {
  const outbound = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.match(url, /^https:\/\/api\.line\.me\/v2\/bot\/message\/(?:reply|push)$/);
    outbound.push({ url, body: JSON.parse(init.body) });
    return Response.json({});
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const { db, sqlite } = database();
  const env = {
    DB: db, ADMIN_TOKEN: 'fixture-management-token-32chars', MEETING_PROFILE: JSON.stringify(profile),
    LINE_CHANNEL_SECRET: 'fixture-signing-secret', LINE_CHANNEL_ACCESS_TOKEN: 'fixture-channel-token',
  };
  const pending = [];
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  async function admin(path, data, authorized = true) {
    const headers = authorized ? { authorization: 'Bearer ' + env.ADMIN_TOKEN } : {};
    return worker.fetch(new Request('https://worker.example.com/admin/' + path, {
      headers, method: data ? 'POST' : 'GET', body: data ? JSON.stringify(data) : undefined,
    }), env, ctx);
  }
  const signer = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.LINE_CHANNEL_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  async function webhook(event) {
    const body = JSON.stringify({ destination: 'fixture', events: [{
      mode: 'active', timestamp: Date.now(), source: { type: 'user', userId: ids.teacher }, replyToken: 'mock-reply', ...event,
    }] });
    const signature = Buffer.from(await crypto.subtle.sign('HMAC', signer, new TextEncoder().encode(body))).toString('base64');
    return worker.fetch(new Request('https://worker.example.com/line/webhook', {
      method: 'POST', headers: { 'x-line-signature': signature }, body,
    }), env, ctx);
  }
  assert.equal((await admin('status', undefined, false)).status, 401);
  const invitation = await (await admin('invites', { key: 'teacher' })).json();
  assert.match(invitation.code, /^[-_\w]{22}$/);
  assert.equal(sqlite.prepare("SELECT invite_hash FROM participants WHERE key='teacher'").get().invite_hash === invitation.code, false);
  const bind = { type: 'message', webhookEventId: 'mock-bind-001', message: { type: 'text', text: '綁定 ' + invitation.code } };
  assert.equal((await webhook(bind)).status, 200);
  assert.equal((await webhook(bind)).status, 200);
  await Promise.all(pending.splice(0));
  assert.equal(outbound.length, 1);
  assert.match(outbound[0].body.messages[0].text, /綁定完成/);
  const testInvite = await (await admin('line-test', {})).json();
  await Promise.all(pending.splice(0));
  const push = outbound.at(-1).body;
  assert.equal(push.to, ids.teacher);
  assert.equal(push.messages[0].template.actions[0].data, 'rma:test:' + testInvite.id);
  await webhook({
    type: 'postback', webhookEventId: 'mock-postback-001', postback: { data: push.messages[0].template.actions[0].data },
  });
  await Promise.all(pending.splice(0));
  const status = await (await admin('status')).json();
  assert.equal(status.enabled, false);
  assert.ok(status.tests[0].confirmed_at > 0);
  assert.equal(status.cases.length, 0);
  assert.equal(status.bindings.filter(binding => binding.active).length, 1);
  assert.equal(JSON.stringify(status).includes(ids.teacher), false);
});

test('signed bookings verify friendship and require the registered name before Calendar writes', async t => {
  t.mock.method(Date, 'now', () => monday);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const { db, sqlite } = database();
  sqlite.prepare('INSERT INTO participants(key,line_user_id,active) VALUES (?,?,1)').run('teacher', ids.teacher);
  sqlite.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('booking_menu', menuId);
  const guest = ids.stranger;
  const outsider = 'U' + 'e'.repeat(32);
  let guestMenuLinked = false;
  const env = {
    DB: db, MEETING_PROFILE: JSON.stringify(profile), LINE_CHANNEL_SECRET: 'fixture-booking-signature',
    LINE_CHANNEL_ACCESS_TOKEN: 'fixture-booking-channel',
    GOOGLE_SERVICE_ACCOUNT: JSON.stringify({
      type: 'service_account', client_email: 'booking@local-test.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }),
  };
  const messages = [];
  const inserted = [];
  t.mock.method(globalThis, 'fetch', async (input, request) => {
    const url = new URL(input);
    if (url.hostname === 'api.line.me') {
      if (url.pathname.includes('/profile/')) {
        return Response.json({ userId: url.pathname.split('/').at(-1), displayName: '相同暱稱' });
      }
      if (url.pathname === '/v2/bot/user/' + guest + '/richmenu/' + menuId) {
        assert.equal(request.method, 'POST');
        guestMenuLinked = true;
        return Response.json({});
      }
      if (url.pathname === '/v2/bot/user/' + outsider + '/richmenu/' + menuId) {
        return Response.json({});
      }
      if (url.pathname.endsWith('/richmenu')) {
        return url.pathname === '/v2/bot/user/' + guest + '/richmenu' && guestMenuLinked
          ? Response.json({ richMenuId: menuId }) : new Response(null, { status: 404 });
      }
      const payload = JSON.parse(request.body);
      messages.push(payload);
      return Response.json({});
    }
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'mock-oauth', expires_in: 3600 });
    assert.equal(url.hostname, 'www.googleapis.com');
    if (request.method === 'POST') {
      const data = JSON.parse(request.body);
      assert.match(url.pathname, /\/events$/);
      assert.match(data.id, /^rma[a-f0-9]{32}$/);
      assert.equal(Date.parse(data.end.dateTime) - Date.parse(data.start.dateTime), MEETING_LENGTH);
      assert.ok(data.extendedProperties.private[BOOKING_MARKER]);
      inserted.push(data);
      return Response.json({ ...data, status: 'confirmed' });
    }
    return url.pathname.endsWith('/events') ?
      Response.json({ accessRole: 'writerWithoutPrivateAccess', items: [] }) :
      new Response(null, { status: 404 });
  });
  const signer = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.LINE_CHANNEL_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  async function send(event, id, userId = guest) {
    const body = JSON.stringify({ events: [{
      mode: 'active', timestamp: monday, source: { type: 'user', userId },
      webhookEventId: id, replyToken: id, ...event,
    }] });
    const signature = Buffer.from(await crypto.subtle.sign('HMAC', signer, new TextEncoder().encode(body))).toString('base64');
    const tasks = [];
    const response = await worker.fetch(new Request('https://worker.example.com/line/webhook', {
      method: 'POST', headers: { 'x-line-signature': signature }, body,
    }), env, { waitUntil(promise) { tasks.push(promise); } });
    assert.equal(response.status, 200);
    await Promise.all(tasks);
  }

  const tap = (data, id, userId) => send({ type: 'postback', postback: { data } }, id, userId);
  const say = (text, id, userId) => send({ type: 'message', message: { type: 'text', text } }, id, userId);
  const lastMessage = () => messages.at(-1).messages[0];

  await tap('rma:book', 'booking-outsider', outsider);
  assert.match(lastMessage().text, /加入好友/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM bookings').get().count, 0);
  await say('學生姓名 外部學生', 'register-name-outsider', outsider);
  assert.match(lastMessage().text, /加入好友/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM booking_names').get().count, 0);
  await tap('rma:book', 'booking-start');
  assert.match(lastMessage().text, /先登記完整姓名/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM bookings').get().count, 0);
  await say('學生姓名 正式名稱', 'register-name');
  assert.match(lastMessage().template.text, /已登記姓名「正式名稱」/);
  assert.equal(sqlite.prepare('SELECT name FROM booking_names').get().name, '正式名稱');
  await tap(lastMessage().template.actions[0].data, 'booking-after-registration');
  const more = bookingCardActions(lastMessage()).find(action => action.label === '查看更多時段');
  assert.equal(more.label, '查看更多時段');
  await tap(more.data, 'booking-page-outsider', outsider);
  assert.match(lastMessage().text, /已失效/);
  await tap(more.data, 'booking-page');
  const selection = bookingCardActions(lastMessage()).find(action => action.label === '11/26（四）12:30').data;
  assert.match(selection, /:9$/);
  await tap(selection, 'booking-select');
  assert.match(lastMessage().template.text, /正式名稱/);
  assert.deepEqual(lastMessage().template.actions.map(action => action.label), ['確認預約', '以上時間都不行']);
  const confirm = lastMessage().template.actions[0].data;
  assert.match(confirm, /^rma:book-confirm:/);
  await say('預約名稱 其他暱稱', 'booking-alias');
  assert.match(lastMessage().text, /已登記的姓名「正式名稱」/);
  await tap(confirm, 'booking-confirm-outsider', outsider);
  assert.equal(inserted.length, 0);
  await tap(confirm, 'booking-confirm');
  await tap(confirm, 'booking-confirm-redelivery');
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].summary, '學生晤談－正式名稱');
  assert.equal(Date.parse(inserted[0].start.dateTime), Date.parse('2026-11-26T12:30:00+08:00'));
  assert.equal(messages.filter(message => message.to === ids.teacher).length, 1);
  assert.equal(messages.filter(message => message.to === guest).length, 1);
  assert.equal(sqlite.prepare('SELECT state FROM bookings').get().state, 'booked');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM participants WHERE line_user_id IS NOT NULL').get().count, 1);
});
