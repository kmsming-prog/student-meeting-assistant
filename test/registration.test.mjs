import assert from 'node:assert/strict';
import test from 'node:test';
import { lineAction } from '../src/line.mjs';
import { iso, MEETING_LENGTH } from '../src/time.mjs';
import { fixture, ids, menuId, monday, sampleEvents, wednesday } from './helper.mjs';

test('a unique roster nickname registers a LINE friend on tap once and keeps their existing booking', async () => {
  const { app, line, store, action, friends, sqlite, updates, creations } = await fixture({ bound: ['teacher'] });
  friends.add(ids.lin);
  assert.match((await app.bookings.offer(ids.lin, null)).text, /先登記完整姓名/);
  const friend = sqlite.prepare('SELECT key FROM participants WHERE booking_user_id=?').get(ids.lin).key;
  sqlite.prepare(`INSERT INTO bookings(id,participant_key,user_id,calendar_id,options,deadline,state,created_at,updated_at)
    VALUES (?,?,?,?,'[]',?,'offered',?,?)`).run(crypto.randomUUID(), friend, ids.lin, app.config.calendarId,
    monday + 3_600_000, monday, monday);
  line.profile = async () => ({ displayName: '甲同學' });
  const invite = await app.issueInvite('lin');
  const tap = action('register', 'lin');
  assert.match((await app.onLine(tap)).reply, /甲同學，學生身分登記完成/);
  assert.deepEqual(await app.onLine(tap), {});
  assert.deepEqual({ ...await store.participantByLine(ids.lin) }, { key: 'lin', active: 1 });
  assert.match((await app.onLine(action('bind', 'stranger', { code: invite.code }))).reply, /已使用/);
  const audit = sqlite.prepare("SELECT detail FROM audit WHERE action='student_registered'").all();
  assert.deepEqual(audit.map(row => row.detail), ['lin:nickname']);
  assert.ok(await app.bookings.open(ids.lin, monday));
  assert.deepEqual(updates, []);
  assert.deepEqual(creations, []);
});

test('a friend with another nickname gets a keyboard button and can register their roster name', async () => {
  const { app, store, action, friends, sqlite } = await fixture({ bound: ['teacher'] });
  friends.add(ids.pan);
  const prompt = (await app.onLine(action('register', 'pan'))).reply;
  assert.deepEqual(prompt.quickReply.items[0].action, {
    type: 'postback', label: '填寫姓名', data: 'rma:registration-name',
    inputOption: 'openKeyboard', fillInText: '學生姓名 ',
  });
  assert.equal(await store.participantByLine(ids.pan), null);
  assert.match((await app.onLine(action('registration-submit', 'pan', { name: '名'.repeat(31) }))).reply.text, /30 字以內/);
  const message = lineAction({
    type: 'message', source: { type: 'user', userId: ids.pan }, timestamp: monday,
    webhookEventId: 'student-name-01', message: { type: 'text', text: '學生姓名乙同學' },
  });
  assert.match((await app.onLine(message)).reply, /乙同學，學生身分登記完成/);
  assert.equal(sqlite.prepare("SELECT detail FROM audit WHERE action='student_registered'").get().detail, 'pan:name');
  assert.equal((await app.onLine(action('registration-submit', 'pan', { name: '甲同學' }))).reply, '你已經用「乙同學」身分登記。');
  assert.deepEqual({ ...await store.participantByLine(ids.pan) }, { key: 'pan', active: 1 });
});

test('registration and status display the identity already assigned to this LINE account', async () => {
  const { app, action } = await fixture();
  for (const [person, name] of [['teacher', '老師'], ['lin', '甲同學'], ['pan', '乙同學']]) {
    const expected = '你已經用「' + name + '」身分登記。';
    assert.equal((await app.onLine(action('register', person))).reply, expected);
    assert.equal((await app.onLine(action('status', person))).reply.template.text, expected);
  }
});

test('registration excludes non-friends and parallel claims preserve the first binding', async () => {
  const { app, store, line, action, friends, sqlite } = await fixture({ bound: ['teacher'] });
  await store.setting('booking_menu', menuId).all();
  line.profile = async () => ({ displayName: '甲同學' });
  line.linkMenu = async () => {};
  assert.match((await app.onLine(action('register', 'stranger'))).reply, /加入好友/);
  assert.equal(await store.participantByLine(ids.stranger), null);
  friends.add(ids.lin);
  friends.add(ids.stranger);
  const results = await Promise.all(['lin', 'stranger'].map(person => app.onLine(action('register', person))));
  assert.equal(results.filter(({ reply }) => /甲同學，學生身分登記完成/.test(reply)).length, 1);
  assert.equal(results.filter(({ reply }) => /已有身分登記/.test(reply)).length, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit WHERE action='student_registered'").get().count, 1);
});

test('an existing conflict is sent once to the newly registered student on the next check', async () => {
  const events = sampleEvents();
  events[0].end.dateTime = iso(wednesday + MEETING_LENGTH);
  const { app, action, line, friends, sent } = await fixture({ bound: ['teacher'], events });
  await app.conflicts.setEnabled(true);
  await app.conflicts.run();
  await app.drain();
  assert.deepEqual(sent, []);
  friends.add(ids.lin);
  line.profile = async () => ({ displayName: '甲同學' });
  await app.onLine(action('register', 'lin'));
  await app.scheduled(monday);
  await app.scheduled(monday);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, ids.lin);
  assert.equal(sent[0].message.template.actions[0].label, '重新預約');
});
