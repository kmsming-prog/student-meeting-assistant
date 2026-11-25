import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleError, busyIntervals } from '../src/google.mjs';
import { LineError } from '../src/line.mjs';
import { bookingOptions, candidateOptions, DAY, HOUR, label, MEETING_LENGTH, MINUTE } from '../src/time.mjs';
import { event, fixture, friday, ids, monday, sampleEvents, thursday, tuesday, wednesday } from './helper.mjs';

test('same-week windows take priority, options are 30 minutes, and adjacency is free', () => {
  const slots = candidateOptions(wednesday, monday, []);
  assert.deepEqual(slots.map(slot => slot.start), [tuesday, tuesday + 1.5 * HOUR, tuesday + 2.5 * HOUR]);
  assert.ok(slots.every(slot => slot.end - slot.start === MEETING_LENGTH));
  const partial = [{ start: tuesday + 2.5 * HOUR, end: tuesday + 3 * HOUR }];
  assert.equal(candidateOptions(wednesday, monday, partial)[2].start, tuesday + 3 * HOUR);
  const weekBusy = [{ start: monday, end: monday + 7 * DAY }];
  assert.equal(candidateOptions(wednesday, monday, weekBusy)[0].start, tuesday + 7 * DAY);
  assert.deepEqual(candidateOptions(wednesday, monday, [{ start: monday, end: monday + 14 * DAY }]), []);
});

test('booking offers include the three new lunch windows and exclude a busy lunch', () => {
  const expected = [
    '11/24（二）11:00', '11/24（二）12:30', '11/24（二）13:30', '11/24（二）14:00', '11/24（二）14:30', '11/24（二）15:00',
    '11/25（三）14:00', '11/25（三）14:30', '11/25（三）15:00',
    '11/26（四）12:30', '11/26（四）13:30', '11/26（四）14:00', '11/26（四）14:30', '11/26（四）15:00',
    '11/27（五）10:30', '11/27（五）11:00', '11/27（五）12:30', '11/27（五）13:30', '11/27（五）14:00',
    '11/27（五）14:30', '11/27（五）15:00',
  ];
  const horizon = monday + 6 * DAY;
  const offers = bookingOptions(monday, horizon, []);
  assert.ok(offers.every(slot => slot.end - slot.start === MEETING_LENGTH));
  assert.deepEqual(offers.map(slot => label(slot.start)), expected);
  const busyLunch = [{ start: thursday - 50 * MINUTE, end: thursday - 40 * MINUTE }];
  assert.deepEqual(bookingOptions(monday, horizon, busyLunch).map(slot => label(slot.start)),
    expected.filter(slot => slot !== '11/26（四）12:30'));
  assert.deepEqual(bookingOptions(monday, horizon, offers), []);
  assert.deepEqual(bookingOptions(monday, horizon, [], true).map(slot => label(slot.start)),
    expected.slice(0, 3));
});

test('ignore transparent, cancelled, declined and working-location events while blocking all-day busy', () => {
  const items = [
    event('transparent', thursday, undefined, { transparency: 'transparent' }),
    event('cancelled', thursday, undefined, { status: 'cancelled' }),
    event('declined', thursday, undefined, { attendees: [{ self: true, responseStatus: 'declined' }] }),
    event('desk', thursday, undefined, { eventType: 'workingLocation' }),
    event('all-day', thursday, undefined, { start: { date: '2026-11-26' }, end: { date: '2026-11-27' } }),
  ];
  const busy = busyIntervals(items);
  assert.equal(busy.length, 1);
  assert.equal(busy[0].start, Date.parse('2026-11-26T00:00:00+08:00'));
  assert.equal(busy[0].end - busy[0].start, DAY);
});

test('duplicate scans and postbacks cause one instance PATCH and one confirmation per intended recipient', async () => {
  const { app, action, sent, updates, events, sqlite } = await fixture();
  assert.equal(await app.scan(), 1);
  assert.equal(await app.scan(), 0);
  await app.drain();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, ids.lin);
  const row = sqlite.prepare('SELECT * FROM cases').get();
  const choices = sent[0].message.template.actions;
  assert.equal(choices.length, 4);
  assert.equal(choices[3].label, '以上時間都不行');
  assert.ok(choices.every(item => item.type === 'postback' && item.label.length <= 20));
  assert.equal(updates.length, 0);

  assert.equal((await app.onLine(action('choice', 'pan', { caseId: row.id, index: 0 }))).caseId, undefined);
  assert.equal((await app.onLine(action('choice', 'stranger', { caseId: row.id, index: 0 }))).caseId, undefined);
  const choose = action('choice', 'lin', { caseId: row.id, index: 0 });
  assert.match((await app.onLine(choose)).reply.template.actions[0].label, /確認改期/);
  assert.equal(await app.applyOne(row.id), false);
  assert.deepEqual(await app.onLine(choose), {});
  const confirm = action('confirm', 'lin', { caseId: row.id, index: 0 });
  assert.equal((await app.onLine(confirm)).caseId, row.id);
  assert.deepEqual(await app.onLine(confirm), {});
  const changed = await Promise.all([app.applyOne(row.id), app.applyOne(row.id)]);
  assert.equal(changed.filter(Boolean).length, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].eventId, 'lin-this-week');
  assert.equal(updates[0].slot.start, tuesday);
  assert.equal(updates[0].slot.end - updates[0].slot.start, MEETING_LENGTH);
  assert.equal(events.find(item => item.id === 'pan-this-week').start.dateTime, new Date(friday).toISOString());
  await app.drain();
  await app.drain();
  assert.deepEqual(sent.slice(1).map(push => push.to).sort(), [ids.lin, ids.teacher].sort());
  assert.equal(sqlite.prepare('SELECT state FROM cases').get().state, 'moved');
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM audit WHERE action='choice_accepted'").get().total, 1);
});

test('a shortened fixed meeting uses its actual thirty-minute window throughout rescheduling', async () => {
  const events = sampleEvents();
  events[0].end.dateTime = new Date(wednesday + MEETING_LENGTH).toISOString();
  const { app, action, sqlite, updates } = await fixture({ events });
  assert.deepEqual((await app.preflight()).google.series.map(series => series.matchingInstances), [1, 1]);
  assert.equal(await app.scan(), 1);
  const row = sqlite.prepare('SELECT * FROM cases').get();
  assert.equal(row.original_end - row.original_start, MEETING_LENGTH);
  const selection = { caseId: row.id, index: 0 };
  await app.onLine(action('choice', 'lin', selection));
  await app.onLine(action('confirm', 'lin', selection));
  await app.applyOne(row.id);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].eventId, 'lin-this-week');
  assert.equal(updates[0].slot.end - updates[0].slot.start, MEETING_LENGTH);
});

test('scan opens cases for the next 45 days and uses later Calendar data only for finding available slots', async () => {
  const future = wednesday + 49 * DAY;
  const events = [...sampleEvents(), event('lin-outside-window', future, undefined, {
    recurringEventId: 'series-lin', originalStartTime: { dateTime: new Date(future).toISOString() },
  }), event('future-conflict', future)];
  const { app, sqlite } = await fixture({ events });
  assert.equal(await app.scan(), 1);
  assert.equal(sqlite.prepare('SELECT event_id FROM cases').get().event_id, 'lin-this-week');
});

test('claiming overlapping slots from different meetings is atomic', async () => {
  const events = [...sampleEvents(), event('pan-conflict', friday)];
  const { app, action, updates, sqlite } = await fixture({ events });
  assert.equal(await app.scan(), 2);
  const [lin, pan] = sqlite.prepare('SELECT * FROM cases ORDER BY student_key').all();
  await app.onLine(action('choice', 'lin', { caseId: lin.id, index: 0 }));
  await app.onLine(action('choice', 'pan', { caseId: pan.id, index: 0 }));
  const selections = await Promise.all([
    app.onLine(action('confirm', 'lin', { caseId: lin.id, index: 0 })),
    app.onLine(action('confirm', 'pan', { caseId: pan.id, index: 0 })),
  ]);
  assert.equal(selections.filter(result => result.caseId).length, 1);
  const states = sqlite.prepare('SELECT state,reason FROM cases ORDER BY state').all();
  assert.deepEqual(states.map(row => row.state), ['applying', 'review']);
  assert.equal(states[1].reason, 'selection_overlap');
  await app.applyOne();
  assert.equal(updates.length, 1);
});

test('recent availability changes and a changed ETag are escalated before any edit', async t => {
  for (const scenario of ['chosen_busy', 'calendar_changed', 'source_conflict_gone']) {
    await t.test(scenario, async () => {
      const { app, action, updates, events, sqlite } = await fixture();
      await app.scan();
      const row = sqlite.prepare('SELECT * FROM cases').get();
      await app.onLine(action('choice', 'lin', { caseId: row.id, index: 0 }));
      await app.onLine(action('confirm', 'lin', { caseId: row.id, index: 0 }));
      if (scenario === 'chosen_busy') {
        const { start, end } = JSON.parse(row.options)[0];
        events.push(event('new-busy', start, end));
      }
      if (scenario === 'source_conflict_gone') events.splice(events.findIndex(item => item.id === 'external-busy'), 1);
      if (scenario === 'calendar_changed') events.find(item => item.id === row.event_id).etag = '"changed"';
      await app.applyOne();
      assert.equal(updates.length, 0);
      const result = sqlite.prepare('SELECT state,reason FROM cases').get();
      assert.equal(result.state, 'review');
      assert.equal(result.reason, scenario);
      assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM outbox WHERE kind='review'").get().count, 1);
      assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM outbox WHERE kind='student_review'").get().count, 1);
    });
  }
});

test('lost Calendar response is recovered using the private marker without a second edit', async () => {
  const { app, action, updates, google, setNow, sqlite } = await fixture();
  const originalMove = google.move;
  google.move = async (...args) => {
    await originalMove(...args);
    throw new GoogleError('patch');
  };
  await app.scan();
  const row = sqlite.prepare('SELECT * FROM cases').get();
  await app.onLine(action('choice', 'lin', { caseId: row.id, index: 1 }));
  await app.onLine(action('confirm', 'lin', { caseId: row.id, index: 1 }));
  await app.applyOne();
  assert.equal(sqlite.prepare('SELECT state FROM cases').get().state, 'applying');
  setNow(monday + 2 * MINUTE);
  await app.applyOne();
  assert.equal(sqlite.prepare('SELECT state FROM cases').get().state, 'moved');
  assert.equal(updates.length, 1);
});

test('unanswered proposals and a full pair of weeks reach the teacher without edits', async () => {
  const first = await fixture();
  await first.app.scan();
  first.setNow(first.sqlite.prepare('SELECT deadline FROM cases').get().deadline + MINUTE);
  await first.app.scheduled(monday + 10 * MINUTE);
  assert.equal(first.sqlite.prepare('SELECT reason FROM cases').get().reason, 'no_reply');
  assert.equal(first.sent[0].to, ids.teacher);
  assert.equal(first.updates.length, 0);

  const events = [...sampleEvents(), event('unavailable-fortnight', tuesday, friday + 8 * DAY)];
  const second = await fixture({ events });
  await second.app.scan();
  assert.equal(second.sqlite.prepare("SELECT reason FROM cases WHERE student_key='lin'").get().reason, 'no_slot');
  assert.equal(second.updates.length, 0);
});

test('pilot accepts only the teacher for test buttons and declines production activation with unbound students', async () => {
  const { app, store, action, sent, updates, sqlite } = await fixture({ bound: ['teacher'], enable: false });
  assert.equal(await store.setAutomation(true, ['teacher', 'lin', 'pan'], monday), false);
  const { id } = await app.testLine();
  await app.drain();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, ids.teacher);
  assert.ok(sent[0].message.template.actions[0].data.endsWith(id));
  await app.onLine(action('test', 'stranger', { testId: id }));
  assert.equal(sqlite.prepare('SELECT confirmed_at FROM line_tests').get().confirmed_at, null);
  const click = action('test', 'teacher', { testId: id });
  assert.match((await app.onLine(click)).reply, /連線測試完成/);
  assert.deepEqual(await app.onLine(click), {});
  assert.equal(updates.length, 0);
});

test('one-time invitations preserve unique identity and ignore old unfollow deliveries', async () => {
  const { app, store, action } = await fixture({ bound: [], enable: false });
  const teacherInvite = await app.issueInvite('teacher');
  const teacherBind = action('bind', 'teacher', { code: teacherInvite.code });
  assert.match((await app.onLine(teacherBind)).reply, /完成/);
  assert.deepEqual(await app.onLine(teacherBind), {});
  assert.match((await app.onLine(action('bind', 'stranger', { code: teacherInvite.code }))).reply, /過期/);
  const studentInvite = await app.issueInvite('lin');
  assert.match((await app.onLine(action('bind', 'teacher', { code: studentInvite.code }))).reply, /已有綁定/);
  await app.onLine(action('unfollow', 'teacher', { timestamp: monday - MINUTE }));
  assert.equal((await store.participantByLine(ids.teacher)).active, 1);
  await app.onLine(action('unfollow', 'teacher'));
  assert.equal((await store.participantByLine(ids.teacher)).active, 0);
  await app.onLine(action('follow', 'teacher', { timestamp: monday + 1 }));
  assert.equal((await store.participantByLine(ids.teacher)).active, 1);
});

test('LINE delivery retries keep the same key and do not run outside its deduplication window', async () => {
  const { app, line, sent, setNow, sqlite } = await fixture();
  const push = line.push;
  line.push = async (...args) => { await push(...args); throw new LineError('push'); };
  await app.scan();
  await app.drain();
  await app.drain();
  assert.equal(sent.length, 1);
  setNow(monday + 10 * MINUTE);
  line.push = push;
  await app.drain();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].retryKey, sent[0].retryKey);
  assert.equal(sqlite.prepare("SELECT state FROM outbox WHERE kind='offer'").get().state, 'sent');
});
