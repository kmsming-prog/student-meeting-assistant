import { TEACHER } from './config.mjs';
import { bookingEventId, bookingIdFromEventId, busyIntervals, MOVE_MARKER } from './google.mjs';
import { conflictMessage, textMessage } from './line.mjs';
import { available, DAY, intervalLabel, MEETING_LENGTH, MINUTE, overlaps, timeValue } from './time.mjs';

const active = "state IN ('pending','review')";
const idle = "NOT EXISTS(SELECT 1 FROM bookings WHERE reschedule_id=meeting_conflicts.id AND state='applying')";
const scanGuard = 'EXISTS(SELECT 1 FROM calendar_monitor WHERE id=1 AND enabled=1 AND lease_owner=?)';
export const activeRebooking = "(bookings.reschedule_id IS NULL OR EXISTS(SELECT 1 FROM meeting_conflicts c " +
  "JOIN calendar_monitor monitor ON monitor.id=1 " +
  "WHERE c.id=bookings.reschedule_id AND c.state='pending' AND monitor.enabled=1))";

function protectedMeeting(event) {
  return !event.etag || !event.start?.dateTime || !event.end?.dateTime || event.recurrence?.length ||
    event.locked || (event.eventType && event.eventType !== 'default') || event.attendeesOmitted ||
    event.attendees?.some(attendee => !attendee.self) || timeValue(event.end) - timeValue(event.start) !== MEETING_LENGTH;
}

function conflictReason(snapshot, meeting) {
  const others = snapshot.busy.filter(slot => slot.id !== meeting.id && overlaps(slot, meeting));
  if (others.some(slot => snapshot.meetings.has(slot.id))) return 'meeting_overlap';
  if (!others.length && available(meeting, snapshot.extra)) return null;
  return protectedMeeting(meeting.event) ? 'calendar_special' : 'busy_event';
}

function sameStart(row, meeting) {
  return meeting && row.original_start === meeting.start && row.original_end === meeting.end &&
    row.booking_id === meeting.bookingId && row.series_id === meeting.seriesId && row.participant_key === meeting.participant;
}

export class ConflictMonitor {
  constructor({ config, store, google, now, push }) {
    this.config = config;
    this.store = store;
    this.google = google;
    this.now = now;
    this.push = push;
    this.series = new Map(config.students.map(student => [student.seriesId, student]));
  }

  async status() {
    const [monitor, cases, notifications, watches] = await this.store.db.batch([
      this.store.q('SELECT enabled,last_scan,last_error,watch_error,requested>completed AS queued FROM calendar_monitor WHERE id=1'),
      this.store.q(`SELECT c.id,c.event_id,c.series_id,c.booking_id,c.participant_key,c.name,c.state,c.reason,
        c.original_start,c.original_end,c.target_start,c.target_end,c.updated_at,
        (p.active=1 AND COALESCE(p.line_user_id,p.booking_user_id) IS NOT NULL AND
          (c.booking_id IS NULL OR b.user_id=COALESCE(p.line_user_id,p.booking_user_id))) AS reachable
        FROM meeting_conflicts c JOIN participants p ON p.key=c.participant_key
        LEFT JOIN bookings b ON b.id=c.booking_id
        ORDER BY c.state IN ('pending','review') DESC,c.updated_at DESC LIMIT 75`),
      this.store.q(`SELECT conflict_id,kind,recipient,state,attempts,reason,updated_at FROM outbox
        WHERE conflict_id IS NOT NULL ORDER BY updated_at DESC LIMIT 100`),
      this.store.q(`SELECT expires_at,sync_at,last_signal_at FROM calendar_watches
        WHERE calendar_id=? AND resource_id IS NOT NULL AND expires_at>? ORDER BY expires_at DESC LIMIT 1`,
      this.config.calendarId, this.now()),
    ]);
    return { monitor: monitor.results[0], watch: watches.results[0] ?? null, cases: cases.results, notifications: notifications.results };
  }

  async teacherSummary() {
    const { cases, notifications } = await this.status();
    const pending = cases.filter(row => row.state === 'pending' || row.state === 'review');
    const resolved = cases.filter(row => row.state === 'resolved').slice(0, 3);
    const lines = [pending.length ? '待改期的學生晤談' : '目前沒有待改期的學生晤談。'];
    for (const row of pending.slice(0, 10)) {
      const notice = notifications.find(item => item.conflict_id === row.id && item.recipient === row.participant_key);
      const state = row.state === 'review' ? '請老師協助' : '等候學生重新預約';
      const delivery = !row.reachable ? '學生目前無法接收通知' :
        notice?.state === 'sent' ? '已推播' : notice?.state === 'failed' ? '推播失敗' : '待推播';
      lines.push(row.name + ' ' + intervalLabel(row.original_start, row.original_end) + ' · ' + state + ' · ' + delivery);
    }
    if (resolved.length) {
      lines.push('最近完成的改期');
      for (const row of resolved) lines.push(row.name + ' ' + intervalLabel(row.target_start, row.target_end));
    }
    return lines.join('\n');
  }

  async setEnabled(enabled) {
    const now = this.now();
    await this.store.db.batch([
      this.store.q('UPDATE calendar_monitor SET enabled=?,requested=requested+1 WHERE id=1', Number(enabled)),
      this.store.audit(now, enabled ? 'calendar_monitor_enabled' : 'calendar_monitor_paused'),
    ]);
  }

  requestScan() {
    return this.store.q('UPDATE calendar_monitor SET requested=requested+1 WHERE id=1 AND enabled=1').all();
  }

  async snapshot(start, end) {
    const [{ items }, extra] = await Promise.all([
      this.google.list(this.config.calendarId, start, end),
      this.google.extraBusy(this.config.busyCalendarIds, start, end),
    ]);
    const bookingIds = [...new Set(items.map(event => bookingIdFromEventId(event.id)).filter(Boolean))];
    const queries = [];
    for (let offset = 0; offset < bookingIds.length; offset += 80) {
      const ids = bookingIds.slice(offset, offset + 80);
      queries.push(this.store.q(`SELECT id,participant_key,COALESCE(display_name,line_display_name) AS name FROM bookings
        WHERE calendar_id=? AND state='booked' AND reschedule_id IS NULL AND participant_key<>?
        AND id IN (${ids.map(() => '?').join(',')})`, this.config.calendarId, TEACHER, ...ids));
    }
    const results = queries.length ? await this.store.db.batch(queries) : [];
    const bookings = new Map(results.flatMap(result => result.results).map(row => [bookingEventId(row.id), row]));
    const meetings = new Map();
    const busy = [];
    for (const event of items) {
      const [slot] = busyIntervals([event]);
      if (!slot) continue;
      busy.push({ id: event.id, ...slot });
      const student = this.series.get(event.recurringEventId);
      const booking = bookings.get(event.id);
      if ((!student && !booking) || event.status !== 'confirmed' || event.id === event.recurringEventId) continue;
      meetings.set(event.id, {
        id: event.id, ...slot, event, seriesId: student?.seriesId ?? null, bookingId: booking?.id ?? null,
        participant: student?.key ?? booking.participant_key, name: student?.name ?? booking.name ?? 'LINE 好友',
      });
    }
    return { meetings, busy, extra };
  }

  closeEpisode(row, reason, now, owner) {
    const statements = [this.store.q(`UPDATE meeting_conflicts SET state='cleared',reason=?,updated_at=?
      WHERE id=? AND ${active} AND ${idle} AND ${scanGuard}`, reason, now, row.id, owner)];
    if (reason === 'conflict_cleared' && row.original_start > now) {
      const when = intervalLabel(row.original_start, row.original_end) + '（台灣時間）';
      const notice = this.push('conflict_cleared', row.id, row.participant_key,
        textMessage('學生晤談的時段衝突已解除，恢復原訂 ' + when + '。'), now + DAY);
      statements.push(this.store.push({ ...notice, conflictId: row.id }, now,
        "changes()=1 AND EXISTS(SELECT 1 FROM outbox WHERE conflict_id=? " +
        "AND kind IN ('conflict_notice','conflict_notice_review') AND state='sent')", row.id));
    }
    return statements;
  }

  noticeStatements(row, now, owner) {
    const guard = `EXISTS(SELECT 1 FROM meeting_conflicts c WHERE c.id=? AND c.state=?) AND ${scanGuard}`;
    const reachable = `EXISTS(SELECT 1 FROM participants p JOIN meeting_conflicts c ON c.participant_key=p.key
      WHERE c.id=? AND p.active=1 AND COALESCE(p.line_user_id,p.booking_user_id) IS NOT NULL
      AND (c.booking_id IS NULL OR EXISTS(SELECT 1 FROM bookings original
        WHERE original.id=c.booking_id AND original.user_id=COALESCE(p.line_user_id,p.booking_user_id))))`;
    const until = Math.min(row.original_start, now + 7 * DAY);
    const kind = row.state === 'pending' ? 'conflict_notice' : 'conflict_notice_review';
    const student = this.push(kind, row.id, row.participant_key, conflictMessage(row), until);
    const statements = [this.store.push({ ...student, conflictId: row.id }, now,
      guard + ' AND ' + reachable, row.id, row.state, owner, row.id)];
    if (row.state === 'review') {
      const when = intervalLabel(row.original_start, row.original_end) + '（台灣時間）';
      const descriptions = {
        meeting_overlap: '與另一場學生晤談重疊',
        no_reply: '即將開始且改期尚未完成',
        calendar_special: '和其他行程撞期，事件需要人工處理',
      };
      const reason = descriptions[row.reason];
      const teacher = this.push('conflict_review', row.id, TEACHER,
        textMessage(row.name + ' 原訂 ' + when + ' 的學生晤談' + reason + '。請協助確認安排。'), until);
      statements.push(this.store.push({ ...teacher, conflictId: row.id }, now, guard, row.id, row.state, owner));
    }
    return statements;
  }

  async scan(now, owner) {
    const snapshot = await this.snapshot(now, now + 45 * DAY);
    const { results } = await this.store.q(`SELECT * FROM meeting_conflicts WHERE calendar_id=? AND ${active}`,
      this.config.calendarId).all();
    const existing = new Map(results.map(row => [row.event_id, row]));
    const statements = [];
    for (const meeting of snapshot.meetings.values()) {
      if (meeting.start < now || meeting.start >= now + 45 * DAY) continue;
      let reason = conflictReason(snapshot, meeting);
      if (!reason) continue;
      if (reason === 'busy_event' && meeting.start - now <= 30 * MINUTE) reason = 'no_reply';
      const previous = existing.get(meeting.id);
      existing.delete(meeting.id);
      const same = sameStart(previous ?? {}, meeting);
      if (previous && !same) statements.push(...this.closeEpisode(previous, 'event_changed', now, owner));
      const row = {
        id: same ? previous.id : crypto.randomUUID(), original_start: meeting.start, original_end: meeting.end,
        participant_key: meeting.participant, name: meeting.name, reason, state: reason === 'busy_event' ? 'pending' : 'review',
      };
      if (same) {
        statements.push(this.store.q(`UPDATE meeting_conflicts SET state=?,reason=?,updated_at=?
          WHERE id=? AND ${active} AND ${idle} AND ${scanGuard} AND (state<>? OR reason<>?)`,
        row.state, reason, now, row.id, owner, row.state, reason));
      } else {
        statements.push(this.store.q(`INSERT OR IGNORE INTO meeting_conflicts
          (id,calendar_id,event_id,series_id,booking_id,participant_key,name,original_start,original_end,state,reason,created_at,updated_at)
          SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${scanGuard}
          AND NOT EXISTS(SELECT 1 FROM meeting_conflicts WHERE calendar_id=? AND event_id=? AND state='resolved' AND updated_at>=?)
          AND NOT EXISTS(SELECT 1 FROM cases old WHERE old.calendar_id=? AND old.event_id=?
            AND old.state IN ('offered','applying') AND (SELECT value FROM settings WHERE key='automation')='on')`,
        row.id, this.config.calendarId, meeting.id, meeting.seriesId, meeting.bookingId, meeting.participant, meeting.name,
        meeting.start, meeting.end, row.state, reason, now, now, owner,
        this.config.calendarId, meeting.id, now, this.config.calendarId, meeting.id));
      }
      statements.push(...this.noticeStatements(row, now, owner));
    }
    for (const row of existing.values()) {
      const meeting = snapshot.meetings.get(row.event_id);
      const reason = row.original_start<=now ? 'event_elapsed' : sameStart(row, meeting) ? 'conflict_cleared' : 'event_changed';
      statements.push(...this.closeEpisode(row, reason, now, owner));
    }
    if (statements.length) await this.store.db.batch(statements);
  }

  async run() {
    for (let attempt = 0; attempt < 2; attempt++) {
      const now = this.now();
      const owner = crypto.randomUUID();
      const claim = await this.store.q(`UPDATE calendar_monitor SET lease_owner=?,lease_until=?
        WHERE id=1 AND enabled=1 AND requested>completed AND lease_until<=? RETURNING requested`,
      owner, now + 3 * MINUTE, now).first();
      if (!claim) return;
      try {
        await this.scan(now, owner);
        await this.store.q(`UPDATE calendar_monitor SET completed=?,last_scan=?,last_error=NULL,lease_owner=NULL,lease_until=0
          WHERE id=1 AND lease_owner=?`, claim.requested, this.now(), owner).all();
      } catch (error) {
        const detail = /^(google_[a-z]+_\d{1,3}|calendar_[a-z_]+|busy_calendar_[a-z_]+)$/.test(error.message)
          ? error.message : 'calendar_scan_failed';
        await this.store.q('UPDATE calendar_monitor SET last_error=?,lease_owner=NULL,lease_until=0 WHERE id=1 AND lease_owner=?',
          detail, owner).all();
        return;
      }
    }
  }

  async rebooking(id, userId) {
    return this.store.q(`SELECT c.* FROM meeting_conflicts c JOIN participants p ON p.key=c.participant_key
      JOIN calendar_monitor monitor ON monitor.id=1
      WHERE c.id=? AND c.calendar_id=? AND c.state='pending' AND c.original_start>? AND monitor.enabled=1
      AND p.active=1 AND COALESCE(p.line_user_id,p.booking_user_id)=?
      AND (c.booking_id IS NULL OR EXISTS(SELECT 1 FROM bookings b WHERE b.id=c.booking_id AND b.user_id=? AND b.state='booked'))`,
    id, this.config.calendarId, this.now(), userId, userId).first();
  }

  async validate(conflict, event, target, now) {
    if (conflict.original_start <= now || timeValue(event.start) !== conflict.original_start ||
        timeValue(event.end) !== conflict.original_end || protectedMeeting(event)) return 'source_changed';
    const snapshot = await this.snapshot(Math.min(conflict.original_start, target.start), Math.max(conflict.original_end, target.end));
    const original = snapshot.meetings.get(conflict.event_id);
    if (!sameStart(conflict, original)) return 'source_changed';
    const reason = conflictReason(snapshot, original);
    if (reason === 'meeting_overlap' || reason === 'calendar_special') return 'meeting_overlap';
    if (!reason) return 'source_conflict_gone';
    if (!available(target, [...snapshot.busy, ...snapshot.extra])) return 'chosen_busy';
    return null;
  }

  applied(conflict, event, row) {
    return event.id === conflict.event_id && event.status === 'confirmed' &&
      event.extendedProperties?.private?.[MOVE_MARKER] === row.id &&
      timeValue(event.start) === row.target_start && timeValue(event.end) === row.target_end;
  }

  move(conflict, event, target, id) {
    return conflict.booking_id
      ? this.google.moveBooking(conflict.calendar_id, event, target, conflict.booking_id, id)
      : this.google.move(conflict.calendar_id, event, target, id);
  }

  resolve(row, now, tag) {
    const guard = 'EXISTS(SELECT 1 FROM bookings WHERE id=? AND transition_tag=?)';
    return [
      this.store.q(`UPDATE bookings SET target_start=?,target_end=?,updated_at=?
        WHERE id=(SELECT booking_id FROM meeting_conflicts WHERE id=?) AND state='booked' AND ${guard}`,
      row.target_start, row.target_end, now, row.reschedule_id, row.id, tag),
      this.store.q(`UPDATE meeting_conflicts SET state='resolved',reason='rebooked',target_start=?,target_end=?,updated_at=?
        WHERE id=? AND ${guard}`, row.target_start, row.target_end, now, row.reschedule_id, row.id, tag),
    ];
  }
}
