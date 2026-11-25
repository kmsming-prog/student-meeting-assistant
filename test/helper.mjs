import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { configuration } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { MeetingAssistant } from '../src/service.mjs';
import { HOUR, iso, timeValue } from '../src/time.mjs';
import { sha256 } from '../src/security.mjs';
import { bookingEventId, BOOKING_MARKER, GoogleError, MOVE_MARKER } from '../src/google.mjs';

export const migration = ['0001_initial.sql', '0002_bookings.sql', '0003_friend_booking.sql', '0004_calendar_conflicts.sql', '0005_booking_names.sql']
  .map(filename => readFileSync(new URL('../migrations/' + filename, import.meta.url), 'utf8')).join('\n');

export function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(migration);
  const db = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bindings: [],
        bind(...bindings) {
          this.bindings = bindings;
          return this;
        },
        execute() {
          const results = statement.all(...this.bindings);
          const changes = /^(INSERT|UPDATE|DELETE)\b/.test(sql) ? sqlite.prepare('SELECT changes() AS count').get().count : 0;
          return { results, meta: { changes } };
        },
        async all() { return this.execute(); },
        async first() { return this.execute().results[0] ?? null; },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map(statement => statement.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { db, sqlite };
}

const lin = { key: 'lin', name: '甲同學', seriesId: 'series-lin', weekday: 3, start: '13:30' };
const pan = { key: 'pan', name: '乙同學', seriesId: 'series-pan', weekday: 5, start: '10:00' };
export const profile = { calendarId: 'test@example.com', busyCalendarIds: [], students: [lin, pan] };
export const ids = { teacher: 'U' + 'a'.repeat(32), lin: 'U' + 'b'.repeat(32), pan: 'U' + 'c'.repeat(32), stranger: 'U' + 'd'.repeat(32) };
export const monday = Date.parse('2026-11-23T08:00:00+08:00');
export const tuesday = Date.parse('2026-11-24T11:00:00+08:00');
export const wednesday = Date.parse('2026-11-25T13:30:00+08:00');
export const thursday = Date.parse('2026-11-26T13:30:00+08:00');
export const friday = Date.parse('2026-11-27T10:00:00+08:00');
export const menuId = 'richmenu-' + '1'.repeat(32);

export function bookingCardActions(message) {
  if (message.type === 'template') return message.template.actions;
  const grid = message.contents.body.contents.filter(component => component.layout === 'horizontal');
  return [
    ...grid.flatMap(row => row.contents.map(tile => tile.action)),
    ...message.contents.footer.contents.map(button => button.action),
  ];
}

export function event(id, start, end = start + HOUR, extra = {}) {
  return {
    id, start: { dateTime: iso(start) }, end: { dateTime: iso(end) },
    etag: '"tested-etag"', status: 'confirmed', eventType: 'default', ...extra,
  };
}

export function sampleEvents() {
  return [
    event('lin-this-week', wednesday, undefined, { recurringEventId: lin.seriesId, originalStartTime: { dateTime: iso(wednesday) } }),
    event('pan-this-week', friday, undefined, { recurringEventId: pan.seriesId, originalStartTime: { dateTime: iso(friday) } }),
    event('external-busy', wednesday + 15 * 60_000, wednesday + 45 * 60_000),
  ];
}

export async function fixture({ events = sampleEvents(), bound = ['teacher', 'lin', 'pan'], enable = true, calendarCallback } = {}) {
  const { db, sqlite } = database();
  const store = new Store(db);
  let now = monday;
  let receiptNumber = 0;
  const sent = [];
  const updates = [];
  const creations = [];
  const google = {
    async list(calendarId, start, end) {
      const items = events.filter(event => timeValue(event.start) < end && timeValue(event.end) > start);
      return { items: structuredClone(items), accessRole: 'writer' };
    },
    async extraBusy() { return []; },
    async get(calendarId, eventId) {
      const item = events.find(meeting => meeting.id === eventId);
      if (!item) throw new GoogleError('get', 404);
      return structuredClone(item);
    },
    async move(calendarId, event, slot, marker) {
      const current = events.find(item => item.id === event.id);
      updates.push({ calendarId, eventId: event.id, slot, etag: event.etag });
      current.start = { dateTime: iso(slot.start) };
      current.end = { dateTime: iso(slot.end) };
      current.extendedProperties = { private: { ...current.extendedProperties?.private, [MOVE_MARKER]: marker } };
      return structuredClone(current);
    },
    async moveBooking(calendarId, item, slot, bookingId, marker) {
      if (item.id !== bookingEventId(bookingId)) throw new Error('refused_booking_event');
      return this.move(calendarId, item, slot, marker);
    },
    async createBooking(calendarId, slot, bookingId, summary) {
      const id = bookingEventId(bookingId);
      if (events.some(item => item.id === id)) throw new GoogleError('insert', 409);
      const created = event(id, slot.start, slot.end, {
        summary, extendedProperties: { private: { [BOOKING_MARKER]: bookingId } },
      });
      events.push(created);
      creations.push({ calendarId, bookingId, slot, summary });
      return structuredClone(created);
    },
  };
  const friends = new Set(bound.map(person => ids[person]));
  const line = {
    async push(to, message, retryKey) { sent.push({ to, message, retryKey }); },
    async info() { return { basicId: '@test' }; },
    async profile(userId) { return friends.has(userId) ? { displayName: 'LINE 暱稱' } : null; },
    async menuForUser(userId) { return friends.has(userId) ? menuId : null; },
  };
  const config = configuration({ MEETING_PROFILE: JSON.stringify(profile) });
  const app = new MeetingAssistant({ config, store, google, line, calendarCallback, now: () => now });
  await store.setup(config.keys);
  function action(type, user, attrs = {}) {
    return { type, userId: ids[user], id: 'webhook-' + (++receiptNumber), timestamp: now, ...attrs };
  }
  for (const person of bound) {
    const invitation = await app.issueInvite(person);
    await app.onLine(action('bind', person, { code: invitation.code }));
  }
  if (enable) await store.setAutomation(true, config.keys, now);
  return { app, store, sqlite, line, google, action, sent, updates, creations, events, friends, setNow(value) { now = value; } };
}

export async function bindCode(store, person, value, now) {
  await store.invite(person, await sha256(value), now + HOUR, now);
}
