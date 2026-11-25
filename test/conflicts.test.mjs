import assert from 'node:assert/strict';
import test from 'node:test';
import { bookingEventId, BOOKING_MARKER, GoogleError } from '../src/google.mjs';
import { lineAction } from '../src/line.mjs';
import { DAY, HOUR, iso, MEETING_LENGTH, MINUTE } from '../src/time.mjs';
import { event, fixture, friday, ids, monday, sampleEvents, wednesday } from './helper.mjs';

function regularMeetings() {
  const meetings = sampleEvents().slice(0, 2);
  for (const meeting of meetings) meeting.end.dateTime = iso(Date.parse(meeting.start.dateTime) + MEETING_LENGTH);
  return meetings;
}

async function scan(app) {
  await app.conflicts.requestScan();
  await app.conflicts.run();
}

async function openBooking(context, person, conflictId) {
  const { app, action } = context;
  const { bookingUser: request } = await app.onLine(action(conflictId ? 'rebook' : 'book', person, { conflictId }));
  return app.bookings.offer(request.userId, request.key, request.timestamp, request.conflictId);
}

async function confirmBooking(context, person) {
  const { app, action, sqlite } = context;
  const booking = sqlite.prepare("SELECT id,options FROM bookings WHERE state='offered' AND user_id=?").get(ids[person]);
  const selection = { caseId: booking.id, index: 0 };
  const choice = await app.onLine(action('book-choice', person, selection));
  const confirmation = await app.onLine(action('book-confirm', person, selection));
  assert.equal(confirmation.bookingId, booking.id);
  return { id: booking.id, slot: JSON.parse(booking.options)[0], choice };
}

test('adding, moving and deleting a busy event updates each affected student and deduplicates repeated scans', async () => {
  const context = await fixture({ events: regularMeetings(), enable: false });
  const { app, action, events, sent, updates, creations, sqlite } = context;
  await app.conflicts.setEnabled(true);
  await app.conflicts.run();
  assert.equal((await app.conflicts.status()).cases.length, 0);

  const admin = event('administrative', wednesday + 5 * MINUTE, friday + 10 * MINUTE);
  events.push(admin);
  await Promise.all([scan(app), scan(app), scan(app)]);
  await app.drain(10);
  const open = await app.conflicts.status();
  assert.deepEqual(open.cases.map(row => row.state), ['pending', 'pending']);
  assert.ok(open.cases.every(row => row.series_id));
  assert.match((await app.onLine(action('conflict-status', 'teacher'))).reply, /等候學生重新預約.*已推播/);
  assert.deepEqual(await app.onLine(action('conflict-status', 'lin')), {});
  assert.deepEqual(sent.map(notice => notice.to).sort(), [ids.lin, ids.pan]);
  for (const notice of sent) {
    const action = notice.message.template.actions[0];
    const result = lineAction({
      type: 'postback', postback: { data: action.data }, mode: 'active', timestamp: monday,
      webhookEventId: 'calendar-confirmation', source: { type: 'user', userId: notice.to },
    });
    assert.equal(result.type, 'rebook');
    assert.ok(open.cases.some(row => row.id === result.conflictId));
  }

  admin.start.dateTime = iso(friday + 5 * MINUTE);
  await scan(app);
  await app.drain(10);
  assert.equal(sqlite.prepare("SELECT state FROM meeting_conflicts WHERE participant_key='lin'").get().state, 'cleared');
  assert.equal(sqlite.prepare("SELECT state FROM meeting_conflicts WHERE participant_key='pan'").get().state, 'pending');
  assert.match(sent.at(-1).message.text, /恢復原訂/);

  events.splice(events.indexOf(admin), 1);
  await Promise.all([scan(app), scan(app)]);
  await app.drain(10);
  const cleared = await app.conflicts.status();
  assert.ok(cleared.cases.every(row => row.state === 'cleared'));
  assert.equal(cleared.notifications.filter(row => row.kind === 'conflict_notice').length, 2);
  assert.equal(cleared.notifications.filter(row => row.kind === 'conflict_cleared').length, 2);
  assert.equal(updates.length + creations.length, 0);
});

test('confirmed rebooking moves the original recurring instance and LINE booking without creating replacements', async () => {
  const context = await fixture({ events: regularMeetings(), enable: false });
  const { app, events, updates, creations, google, setNow, sqlite } = context;
  await openBooking(context, 'pan');
  const created = await confirmBooking(context, 'pan');
  await app.bookings.applyOne(created.id);
  const bookingEvent = bookingEventId(created.id);
  events.push(event('administrative-tuesday', created.slot.start, created.slot.end));
  events.push(event('administrative-wednesday', wednesday, wednesday + MEETING_LENGTH));
  await app.conflicts.setEnabled(true);
  await app.conflicts.run();
  const cases = (await app.conflicts.status()).cases;
  const regular = cases.find(row => row.participant_key === 'lin');
  const extra = cases.find(row => row.participant_key === 'pan');
  assert.equal(regular.event_id, 'lin-this-week');
  assert.equal(extra.booking_id, created.id);
  assert.equal(extra.event_id, bookingEvent);
  assert.match((await openBooking(context, 'lin', extra.id)).text, /無法辦理/);

  await openBooking(context, 'lin', regular.id);
  const movedRegular = await confirmBooking(context, 'lin');
  assert.equal(movedRegular.choice.reply.template.actions[0].label, '確認改期');
  await Promise.all([app.bookings.applyOne(movedRegular.id), app.bookings.applyOne(movedRegular.id)]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].eventId, regular.event_id);
  assert.equal(events.find(item => item.id === regular.event_id).recurringEventId, regular.series_id);

  const moveBooking = google.moveBooking;
  google.moveBooking = async function (...args) {
    await moveBooking.apply(this, args);
    throw new GoogleError('patch');
  };
  await openBooking(context, 'pan', extra.id);
  const movedExtra = await confirmBooking(context, 'pan');
  await app.bookings.applyOne(movedExtra.id);
  await scan(app);
  assert.equal(sqlite.prepare('SELECT state FROM meeting_conflicts WHERE id=?').get(extra.id).state, 'pending');
  setNow(monday + 2 * MINUTE);
  await app.bookings.applyOne(movedExtra.id);
  await scan(app);

  assert.equal(updates.length, 2);
  assert.equal(updates[1].eventId, bookingEvent);
  assert.equal(creations.length, 1);
  const oldBooking = sqlite.prepare('SELECT target_start,target_end,state FROM bookings WHERE id=?').get(created.id);
  assert.deepEqual({ ...oldBooking }, { target_start: movedExtra.slot.start, target_end: movedExtra.slot.end, state: 'booked' });
  assert.equal(events.find(item => item.id === bookingEvent).extendedProperties.private[BOOKING_MARKER], created.id);
  assert.ok((await app.conflicts.status()).cases.every(row => row.state === 'resolved'));
});

test('birthdays, transparent tasks and unconfirmed events are excluded, while peer overlap goes to the teacher', async () => {
  const regular = regularMeetings();
  const context = await fixture({ events: [...regular,
    event('birthday', wednesday, wednesday + HOUR, { eventType: 'birthday' }),
    event('transparent-task', wednesday, wednesday + HOUR, { transparency: 'transparent' }),
    event('tentative', wednesday, wednesday + HOUR, { status: 'tentative' }),
    event('unanswered', friday, friday + HOUR, { attendees: [{ self: true, responseStatus: 'needsAction' }] }),
  ], enable: false });
  const { app, updates, sent } = context;
  await app.conflicts.setEnabled(true);
  await app.conflicts.run();
  assert.equal((await app.conflicts.status()).cases.length, 0);
  regular[1].start.dateTime = iso(wednesday);
  regular[1].end.dateTime = iso(wednesday + MEETING_LENGTH);
  await app.scheduled(monday + 5 * MINUTE);
  await app.drain(10);
  await scan(app);
  await app.drain(10);
  const status = await app.conflicts.status();
  assert.equal(status.cases.length, 2);
  assert.ok(status.cases.every(row => row.state === 'review' && row.reason === 'meeting_overlap'));
  assert.equal(status.notifications.filter(row => row.recipient === 'teacher').length, 2);
  assert.match(sent.find(notice => notice.to === ids.teacher).message.text, /與另一場學生晤談重疊/);
  const lin = status.cases.find(row => row.participant_key === 'lin');
  assert.match((await openBooking(context, 'lin', lin.id)).text, /無法辦理/);
  assert.equal(updates.length, 0);
});

test('a late conflict on a new slot is caught before the original Calendar event is patched', async () => {
  const context = await fixture({
    events: [...regularMeetings(), event('admin', wednesday, wednesday + MEETING_LENGTH)], enable: false,
  });
  const { app, events, sqlite, updates } = context;
  await app.conflicts.setEnabled(true);
  await app.conflicts.run();
  const [conflict] = (await app.conflicts.status()).cases;
  await openBooking(context, 'lin', conflict.id);
  const job = await confirmBooking(context, 'lin');
  events.push(event('late-busy', job.slot.start, job.slot.end));
  await app.bookings.applyOne(job.id);
  assert.deepEqual({ ...sqlite.prepare('SELECT state,reason FROM bookings WHERE id=?').get(job.id) },
    { state: 'review', reason: 'chosen_busy' });
  assert.equal(sqlite.prepare('SELECT state FROM meeting_conflicts').get().state, 'pending');
  assert.equal(updates.length, 0);
});

test('Calendar channel accepts its initial sync and only queues authenticated unique change messages', async () => {
  const callback = 'https://worker.example.com/google/calendar/webhook';
  const { app, google, events } = await fixture({ events: regularMeetings(), calendarCallback: callback, enable: false });
  let watchCalls = 0;
  let headers;
  google.watch = async (calendarId, id, token, address) => {
    assert.equal(calendarId, 'test@example.com');
    assert.equal(address, callback);
    watchCalls++;
    headers = new Headers({
      'x-goog-channel-id': id, 'x-goog-channel-token': token, 'x-goog-resource-id': 'fixture-resource',
      'x-goog-resource-state': 'sync', 'x-goog-message-number': '1',
    });
    assert.deepEqual(await app.calendarWatch.receive(headers), { scan: false });
    return { id, resourceId: 'fixture-resource', expiration: String(monday + 7 * DAY) };
  };
  await app.conflicts.setEnabled(true);
  await Promise.all([app.calendarWatch.renew(), app.calendarWatch.renew()]);
  assert.equal(watchCalls, 1);
  assert.equal((await app.conflicts.status()).watch.sync_at, monday);
  await app.conflicts.run();
  events.push(event('admin-after-watch', wednesday, wednesday + MEETING_LENGTH));
  headers.set('x-goog-resource-state', 'exists');
  headers.set('x-goog-message-number', '7');
  const forged = new Headers(headers);
  forged.set('x-goog-channel-token', 'a'.repeat(43));
  assert.equal(await app.calendarWatch.receive(forged), null);
  const signals = await Promise.all([app.calendarWatch.receive(headers), app.calendarWatch.receive(headers)]);
  assert.equal(signals.filter(signal => signal?.scan).length, 1);
  await app.conflicts.run();
  const status = await app.conflicts.status();
  assert.equal(status.watch.last_signal_at, monday);
  assert.equal(status.cases.length, 1);
  assert.equal(status.notifications.filter(row => row.kind === 'conflict_notice').length, 1);
});
