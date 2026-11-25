import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { GoogleError } from '../src/google.mjs';
import { lineAction } from '../src/line.mjs';
import { installBookingMenu, isMenuImage, publishBookingMenu } from '../src/menu.mjs';
import { DAY, HOUR, localTime, MEETING_LENGTH, MINUTE } from '../src/time.mjs';
import { bookingCardActions, event, fixture, friday, ids, monday, tuesday } from './helper.mjs';

async function start(app, action, person) {
  const { bookingUser: { userId, key, timestamp } } = await app.onLine(action('book', person));
  return app.bookings.offer(userId, key, timestamp);
}

test('offers use tomorrow through the seventh Taipei date, even with a free same-day slot', async () => {
  const today = tuesday - 3 * HOUR;
  const firstMidnight = tuesday + 13 * HOUR;
  const lastTuesday = tuesday + 7 * DAY;
  const cutoff = firstMidnight + 7 * DAY;
  const { app, action, google, events, setNow, sqlite } = await fixture({
    events: [event('busy-before-last-day', firstMidnight, lastTuesday - HOUR)],
  });
  setNow(today);
  const list = google.list;
  google.list = (calendar, startTime, end) => {
    assert.deepEqual([startTime, end], [firstMidnight, cutoff]);
    return list(calendar, startTime, end);
  };
  await start(app, action, 'lin');
  const row = sqlite.prepare('SELECT options FROM bookings').get();
  const options = JSON.parse(row.options);
  assert.equal(options[0].start, lastTuesday);
  assert.ok(options.every(slot => slot.start >= firstMidnight && slot.end <= cutoff));
  events.push(event('last-day-busy', lastTuesday - HOUR, cutoff));
  const reply = await start(app, action, 'pan');
  assert.match(reply.template.text, /暫無可用時段/);
  assert.equal(reply.template.actions.length, 1);
});

test('an old choice cannot become a same-day confirmation when Taipei reaches midnight', async () => {
  const { app, action, sqlite, setNow } = await fixture({ enable: false });
  await start(app, action, 'teacher');
  const original = sqlite.prepare('SELECT id FROM bookings').get();
  const slot = { caseId: original.id, index: 0 };
  await app.onLine(action('book-choice', 'teacher', slot));
  setNow(tuesday - 11 * HOUR);
  assert.match((await app.onLine(action('book-choice', 'teacher', slot))).reply, /已失效/);
  assert.equal((await app.onLine(action('book-confirm', 'teacher', slot))).bookingId, undefined);
  await start(app, action, 'teacher');
  assert.equal(sqlite.prepare('SELECT state FROM bookings WHERE id=?').get(original.id).state, 'closed');
  const reopened = sqlite.prepare("SELECT id,options FROM bookings WHERE state='offered'").get();
  assert.notEqual(reopened.id, original.id);
  assert.ok(JSON.parse(reopened.options).every(option => option.start >= tuesday + 13 * HOUR));
});

test('a valid confirmation can finish after midnight using its original confirmation time', async () => {
  const { app, action, sqlite, setNow, creations } = await fixture({ enable: false });
  const midnight = tuesday - 11 * HOUR;
  setNow(midnight - MINUTE);
  await start(app, action, 'teacher');
  const row = sqlite.prepare('SELECT id FROM bookings').get();
  const selection = { caseId: row.id, index: 0 };
  await app.onLine(action('book-choice', 'teacher', selection));
  assert.equal((await app.onLine(action('book-confirm', 'teacher', selection))).bookingId, row.id);
  setNow(midnight + MINUTE);
  await app.bookings.applyOne(row.id);
  assert.equal(creations[0].slot.start, tuesday);
});

test('separate booking entry keeps the pilot independent and writes exactly one 30-minute event after confirmation', async () => {
  const { app, action, sqlite, creations, sent, updates } = await fixture({ bound: ['teacher'], enable: false });
  assert.match((await start(app, action, 'stranger')).text, /加入好友/);
  const entry = await app.onLine(action('status', 'teacher'));
  assert.deepEqual(entry.reply.template.actions[0], { type: 'postback', label: '預約晤談', data: 'rma:book' });
  const options = await start(app, action, 'teacher');
  assert.equal(bookingCardActions(options).filter(item => item.data.startsWith('rma:book-choice:')).length, 6);
  const row = sqlite.prepare('SELECT * FROM bookings').get();
  assert.ok(JSON.parse(row.options).every(slot => slot.end - slot.start === MEETING_LENGTH));
  const slot = { caseId: row.id, index: 0 };
  assert.equal((await app.onLine(action('book-confirm', 'teacher', slot))).bookingId, undefined);
  assert.match((await app.onLine(action('book-choice', 'teacher', slot))).reply.template.actions[0].label, /確認預約/);
  assert.equal(await app.bookings.applyOne(row.id), false);
  assert.equal(creations.length, 0);
  assert.equal((await app.onLine(action('book-confirm', 'stranger', slot))).bookingId, undefined);
  assert.equal((await app.onLine(action('book-confirm', 'teacher', slot))).bookingId, row.id);
  assert.equal((await app.onLine(action('book-confirm', 'teacher', slot))).bookingId, undefined);
  await Promise.all([app.bookings.applyOne(row.id), app.bookings.applyOne(row.id)]);
  await app.drain();
  assert.equal(creations.length, 1);
  assert.equal(creations[0].summary, '學生晤談－LINE 暱稱');
  assert.equal(creations[0].slot.start, tuesday);
  assert.equal(updates.length, 0);
  assert.deepEqual(sent.map(push => push.to), [ids.teacher]);
  assert.equal(sqlite.prepare('SELECT state FROM bookings').get().state, 'booked');
});

test('reopening an offer shows the newly added lunch slots in pages to its owner', async () => {
  const { app, action, sqlite } = await fixture({ events: [], enable: false });
  await start(app, action, 'lin');
  const original = sqlite.prepare('SELECT id,options FROM bookings').get();
  const all = JSON.parse(original.options);
  const previous = all.filter(slot => localTime(slot.start) !== '12:30');
  assert.equal(previous.length, 18);
  sqlite.prepare('UPDATE bookings SET options=? WHERE id=?').run(JSON.stringify(previous), original.id);

  let card = await start(app, action, 'lin');
  assert.match(card.altText, /第 1–6 個，共 21 個時段/);
  const grid = card.contents.body.contents.filter(component => component.layout === 'horizontal');
  assert.deepEqual(grid.map(row => row.contents.length), [2, 2, 2]);
  assert.equal(sqlite.prepare('SELECT state FROM bookings WHERE id=?').get(original.id).state, 'closed');
  const id = sqlite.prepare("SELECT id FROM bookings WHERE state='offered'").get().id;
  assert.deepEqual(await start(app, action, 'lin'), card);
  assert.match((await app.onLine(action('book-more', 'pan', { caseId: id, offset: 6 }))).reply, /已失效/);

  function tap(data) {
    const { id: receipt, timestamp, userId } = action('book-more', 'lin');
    return lineAction({
      type: 'postback', source: { type: 'user', userId }, timestamp,
      webhookEventId: 'more-' + receipt, postback: { data },
    });
  }
  const olderPage = tap('rma:book-page:' + id + ':1');
  assert.equal(olderPage.offset, 3);
  const legacyReply = (await app.onLine(olderPage)).reply;
  assert.match(legacyReply.altText, /第 4–9 個，共 21 個時段/);
  assert.equal(bookingCardActions(legacyReply)[0].data, 'rma:book-choice:' + id + ':3');

  const shown = [];
  for (let page = 0; page < 4; page++) {
    const actions = bookingCardActions(card);
    assert.equal(actions.at(-1).label, '以上時間都不行');
    const slots = actions.filter(option => option.data.startsWith('rma:book-choice:'));
    shown.push(...slots.map(option => Number(option.data.split(':').at(-1))));
    if (page === 3) {
      assert.equal(actions.length, 4);
    } else {
      assert.equal(actions[6].label, '查看更多時段');
      const next = tap(actions[6].data);
      assert.equal(next.offset, (page + 1) * 6);
      card = (await app.onLine(next)).reply;
      assert.deepEqual(await app.onLine(next), {});
    }
  }
  assert.deepEqual(shown, all.map((_, index) => index));
  assert.match((await app.onLine(action('book-more', 'lin', { caseId: id, offset: 21 }))).reply, /已失效/);
});

test('a LINE friend can book with a registered name, bind a fixed meeting later, and lose access on unfollow', async () => {
  const { app, action, sqlite, creations, sent, friends, setNow } = await fixture({ bound: ['teacher'], enable: false });
  friends.add(ids.stranger);
  assert.match((await start(app, action, 'stranger')).text, /先登記完整姓名/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM bookings').get().count, 0);
  const registered = await app.onLine(action('registration-submit', 'stranger', { name: '預約測試生' }));
  assert.match(registered.reply.template.text, /已登記姓名「預約測試生」/);
  await start(app, action, 'stranger');
  const booking = sqlite.prepare('SELECT id FROM bookings').get();
  const slot = { caseId: booking.id, index: 0 };
  const name = await app.onLine(action('book-choice', 'stranger', slot));
  assert.match(name.reply.template.text, /預約測試生/);
  const { code } = await app.issueInvite('lin');
  assert.match((await app.onLine(action('bind', 'stranger', { code }))).reply, /綁定完成/);
  await start(app, action, 'stranger');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM bookings').get().count, 1);
  assert.equal((await app.onLine(action('book-confirm', 'stranger', slot))).bookingId, booking.id);
  assert.equal(sqlite.prepare('SELECT display_name FROM bookings WHERE id=?').get(booking.id).display_name, '甲同學');
  setNow(monday + MINUTE);
  await app.onLine(action('unfollow', 'stranger'));
  friends.delete(ids.stranger);
  await app.bookings.applyOne(booking.id);
  await app.drain();
  assert.equal(creations.length, 0);
  assert.equal(sqlite.prepare('SELECT reason FROM bookings').get().reason, 'authorization_changed');
  assert.deepEqual(sent.map(message => message.to), [ids.teacher]);
});

test('an old offer cannot confirm with a nickname, and resumes after the owner registers', async () => {
  const { app, action, sqlite, friends, creations } = await fixture({ bound: ['teacher'], enable: false, events: [] });
  friends.add(ids.stranger);
  await start(app, action, 'stranger');
  const friend = sqlite.prepare('SELECT key FROM participants WHERE booking_user_id=?').get(ids.stranger).key;
  const id = crypto.randomUUID();
  const options = JSON.stringify([{ start: tuesday, end: tuesday + MEETING_LENGTH }]);
  sqlite.prepare(`INSERT INTO bookings(id,participant_key,user_id,calendar_id,options,deadline,state,
    choice_index,created_at,updated_at,line_display_name) VALUES (?,?,?,?,?,?,'offered',0,?,?,'舊暱稱')`)
    .run(id, friend, ids.stranger, app.config.calendarId, options, monday + DAY, monday, monday);
  const choice = { caseId: id, index: 0 };
  const blocked = await app.onLine(action('book-confirm', 'stranger', choice));
  assert.match(blocked.reply.text, /先登記完整姓名/);
  assert.equal(creations.length, 0);
  await app.onLine(action('registration-submit', 'stranger', { name: '登記本名' }));
  assert.equal((await app.onLine(action('book-confirm', 'stranger', choice))).bookingId, id);
  await app.bookings.applyOne(id);
  assert.equal(creations[0].summary, '學生晤談－登記本名');
});

test('both none-fit buttons notify only the teacher once and perform no Calendar mutations', async () => {
  const { app, action, sent, sqlite, creations, updates } = await fixture();
  await app.scan();
  const regular = sqlite.prepare('SELECT * FROM cases').get();
  await start(app, action, 'pan');
  const booking = sqlite.prepare('SELECT * FROM bookings').get();
  assert.equal((await app.onLine(action('decline', 'pan', { caseId: regular.id }))).drain, undefined);
  assert.equal((await app.onLine(action('book-decline', 'lin', { caseId: booking.id }))).drain, undefined);
  for (const [person, type, id] of [['lin', 'decline', regular.id], ['pan', 'book-decline', booking.id]]) {
    const decline = action(type, person, { caseId: id });
    assert.deepEqual(await app.onLine(decline), {
      reply: '已記錄你的需求，會通知老師協助安排。如果不急，也可以下週再預約。',
      drain: true,
    });
    assert.equal((await app.onLine(decline)).drain, undefined);
  }
  await app.drain();
  assert.deepEqual(sent.map(item => item.to), [ids.teacher, ids.teacher]);
  assert.equal(sqlite.prepare('SELECT reason FROM cases').get().reason, 'none_work');
  assert.equal(sqlite.prepare('SELECT reason FROM bookings').get().reason, 'none_work');
  assert.equal(creations.length + updates.length, 0);
});

test('a bound student can request an extra appointment while automatic conflict scans are paused', async () => {
  const { app, action } = await fixture({ bound: ['teacher', 'lin'], enable: false });
  const card = await start(app, action, 'lin');
  const actions = bookingCardActions(card);
  assert.equal(actions[0].type, 'postback');
  assert.equal(actions.at(-1).label, '以上時間都不行');
});

test('regular moves and extra bookings cannot simultaneously claim the same slot', async () => {
  const { app, action, sqlite, creations, updates } = await fixture();
  await app.scan();
  await start(app, action, 'pan');
  const regular = { caseId: sqlite.prepare('SELECT id FROM cases').get().id, index: 0 };
  const booking = { caseId: sqlite.prepare('SELECT id FROM bookings').get().id, index: 0 };
  await app.onLine(action('choice', 'lin', regular));
  await app.onLine(action('book-choice', 'pan', booking));
  const claims = await Promise.all([
    app.onLine(action('confirm', 'lin', regular)),
    app.onLine(action('book-confirm', 'pan', booking)),
  ]);
  assert.equal(claims.filter(item => item.caseId || item.bookingId).length, 1);
  await Promise.all([app.applyOne(), app.bookings.applyOne()]);
  assert.equal(creations.length + updates.length, 1);
});

test('a previously offered slot outside the new hours reaches review without a Calendar write', async () => {
  const { app, action, sqlite, creations, updates } = await fixture();
  await app.scan();
  await start(app, action, 'pan');
  const startTime = friday + 90 * MINUTE;
  const oldOptions = JSON.stringify([{ start: startTime, end: startTime + MEETING_LENGTH }]);
  sqlite.prepare('UPDATE bookings SET options=?').run(oldOptions);
  sqlite.prepare('UPDATE cases SET options=?').run(oldOptions);

  const booking = { caseId: sqlite.prepare('SELECT id FROM bookings').get().id, index: 0 };
  await app.onLine(action('book-choice', 'pan', booking));
  await app.onLine(action('book-confirm', 'pan', booking));
  await app.bookings.applyOne(booking.caseId);

  const regular = { caseId: sqlite.prepare('SELECT id FROM cases').get().id, index: 0 };
  await app.onLine(action('choice', 'lin', regular));
  await app.onLine(action('confirm', 'lin', regular));
  await app.applyOne(regular.caseId);

  assert.equal(creations.length + updates.length, 0);
  assert.equal(sqlite.prepare('SELECT reason FROM bookings').get().reason, 'backup_window_changed');
  assert.equal(sqlite.prepare('SELECT reason FROM cases').get().reason, 'backup_window_changed');
});

test('changed availability prevents extra booking and a lost response reconciles by stable event ID', async t => {
  for (const lateConflict of [true, false]) await t.test(lateConflict ? 'late conflict' : 'lost response', async () => {
    const { app, action, sqlite, google, events, creations, setNow } = await fixture();
    await start(app, action, 'lin');
    const row = sqlite.prepare('SELECT id, options FROM bookings').get();
    const slot = { caseId: row.id, index: 0 };
    await app.onLine(action('book-choice', 'lin', slot));
    await app.onLine(action('book-confirm', 'lin', slot));
    if (lateConflict) {
      const { start, end } = JSON.parse(row.options)[0];
      events.push(event('late-busy', start, end));
    } else {
      const insert = google.createBooking;
      google.createBooking = async (...args) => {
        await insert(...args);
        throw new GoogleError('insert');
      };
    }
    await app.bookings.applyOne(row.id);
    if (!lateConflict) {
      setNow(monday + 2 * MINUTE);
      await app.bookings.applyOne(row.id);
    }
    const result = sqlite.prepare('SELECT state,reason FROM bookings').get();
    assert.equal(result.state, lateConflict ? 'review' : 'booked');
    assert.equal(result.reason, lateConflict ? 'chosen_busy' : null);
    assert.equal(creations.length, lateConflict ? 0 : 1);
  });
});

test('rich menu installation attaches booking and registration buttons to active bindings', async () => {
  const { store } = await fixture({ bound: ['teacher'], enable: false });
  const id = 'richmenu-' + 'a'.repeat(32);
  const links = new Map();
  let defaultId = null;
  const image = readFileSync(new URL('../assets/booking-menu.png', import.meta.url));
  assert.equal(isMenuImage(image), true);
  assert.equal(isMenuImage(Buffer.from('invalid')), false);
  const line = {
    async listMenus() { return { richmenus: [] }; },
    async createMenu(menu) {
      assert.equal(menu.chatBarText, '學生晤談');
      assert.deepEqual(menu.areas[0].action, { type: 'postback', label: '預約晤談', data: 'rma:book' });
      assert.equal(menu.areas[1].action.data, 'rma:register');
      return { richMenuId: id };
    },
    async putMenuImage(menuId, png) { assert.equal(menuId, id); assert.equal(png, image); },
    async menuForUser(userId) { return links.get(userId); },
    async linkMenu(userId, menuId) { links.set(userId, menuId); },
    async defaultMenu() { return defaultId; },
    async setDefaultMenu(menuId) { defaultId = menuId; },
  };
  assert.deepEqual(await installBookingMenu(store, line, image), [{ key: 'teacher', state: 'linked' }]);
  assert.deepEqual(await installBookingMenu(store, line, image), [{ key: 'teacher', state: 'already_linked' }]);
  assert.deepEqual([...links.entries()], [[ids.teacher, id]]);
  assert.equal(await publishBookingMenu(store, line), 'published');
  assert.equal(await publishBookingMenu(store, line), 'already_default');
  defaultId = 'richmenu-' + 'b'.repeat(32);
  assert.equal(await publishBookingMenu(store, line), 'existing_default');
  assert.equal(defaultId, 'richmenu-' + 'b'.repeat(32));
});

test('menu upgrade replaces the previous application menu and preserves unrelated menus', async () => {
  const { store } = await fixture({ bound: ['teacher', 'lin'], enable: false });
  const prior = 'richmenu-' + '1'.repeat(32);
  const replacement = 'richmenu-' + '2'.repeat(32);
  const custom = 'richmenu-' + '3'.repeat(32);
  const images = new Set();
  const links = new Map([[ids.teacher, prior], [ids.lin, custom], [ids.stranger, prior]]);
  let defaultId = prior;
  await store.setting('booking_menu', prior).all();
  await store.activateBookingFriend('friend:guest', ids.stranger, monday);
  const line = {
    async listMenus() { return { richmenus: [] }; },
    async createMenu() { return { richMenuId: replacement }; },
    async putMenuImage(id) { images.add(id); },
    async menuForUser(id) { return links.get(id); },
    async linkMenu(user, id) { links.set(user, id); },
    async defaultMenu() { return defaultId; },
    async setDefaultMenu(id) { defaultId = id; },
  };
  const image = readFileSync(new URL('../assets/booking-menu.png', import.meta.url));
  const results = await installBookingMenu(store, line, image);
  assert.deepEqual(Object.fromEntries(results.map(({ key, state }) => [key, state])),
    { lin: 'existing_menu', teacher: 'upgraded', 'friend:guest': 'upgraded' });
  assert.equal(await publishBookingMenu(store, line), 'published');
  assert.equal(defaultId, replacement);
  assert.deepEqual([...images], [replacement]);
  assert.equal(links.get(ids.lin), custom);
});

test('Chinese binding commands tolerate spaces omitted by a phone keyboard', () => {
  const code = 'a'.repeat(22);
  const event = { type: 'message', source: { type: 'user', userId: ids.lin }, timestamp: monday, webhookEventId: 'test-123456' };
  for (const text of ['綁定' + code, '綁定 ' + code, 'bind ' + code]) {
    assert.equal(lineAction({ ...event, message: { type: 'text', text } }).code, code);
  }
});
