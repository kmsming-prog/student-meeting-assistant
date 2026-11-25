import { TEACHER } from './config.mjs';
import { BookingFlow } from './bookings.mjs';
import { CalendarWatch } from './calendar-watch.mjs';
import { ConflictMonitor } from './conflicts.mjs';
import { busyIntervals, GoogleError, MOVE_MARKER } from './google.mjs';
import { bookingEntryMessage, confirmationMessage, LineError, lineTestMessage, noSuitableTimeReply, proposalMessage, textMessage } from './line.mjs';
import { RegistrationFlow } from './registration.mjs';
import { randomCode, sha256 } from './security.mjs';
import { available, candidateOptions, DAY, HOUR, intervalLabel, isBackupSlot, localDay, localTime, MEETING_LENGTH, MINUTE, timeValue, weekday } from './time.mjs';

const reasons = {
  no_slot: '同一週及下一週都沒有可用的備用時段',
  backup_window_changed: '所選時段已移出備用範圍，請協助安排',
  too_late: '距原晤談或備用時段太近',
  student_unbound: '學生尚未完成 LINE 綁定或已封鎖官方帳號',
  no_reply: '學生逾時未選擇時段',
  calendar_changed: '原晤談已由其他方式更動，請確認目前安排',
  calendar_special: '行事曆事件為特殊類型、已鎖定或有受邀者',
  calendar_missing: '找不到原晤談',
  calendar_failed: '更新結果需要確認，請查看 Google Calendar',
  source_conflict_gone: '原時段的衝突已解除，請確認是否保留原安排',
  chosen_busy: '所選時段新增行程',
  selection_overlap: '所選時段正由另一筆改期處理',
  authorization_changed: '學生的 LINE 綁定已變更或自動化已暫停',
  offer_failed: 'LINE 改期通知發送失敗',
  none_work: '學生表示列出的時段都不合適',
};

export function safeError(error) {
  const message = error?.message;
  return typeof message === 'string' && /^(?:google_[a-z]+_\d{1,3}|line_[a-z]+_\d{1,3}|(?:bad|missing|invalid|calendar|busy_calendar|refused)_[a-z_]{1,45})$/.test(message)
    ? message : 'internal_error';
}

function normalInstance(event, student) {
  const start = timeValue(event.start);
  const original = timeValue(event.originalStartTime);
  const end = timeValue(event.end);
  const duration = end - start;
  return event.id && typeof event.etag === 'string' && event.etag &&
    event.id !== student.seriesId && event.recurringEventId === student.seriesId && !event.recurrence?.length &&
    event.status === 'confirmed' && event.start?.dateTime && event.originalStartTime?.dateTime &&
    start === original && (duration === MEETING_LENGTH || duration === HOUR) &&
    weekday(start) === student.weekday && localTime(start) === student.start &&
    !event.extendedProperties?.private?.[MOVE_MARKER];
}

function special(event) {
  return event.locked || (event.eventType && event.eventType !== 'default') || event.attendeesOmitted ||
    event.attendees?.some(attendee => !attendee.self) || event.transparency === 'transparent';
}

export class MeetingAssistant {
  constructor({ config, store, google, line, calendarCallback, now = Date.now }) {
    this.config = config;
    this.store = store;
    this.google = google;
    this.line = line;
    this.now = now;
    this.students = new Map(config.students.map(student => [student.key, student]));
    const push = this.push.bind(this);
    this.conflicts = new ConflictMonitor({ config, store, google, now, push });
    this.calendarWatch = new CalendarWatch({ store, google, calendarId: config.calendarId, address: calendarCallback, now });
    this.bookings = new BookingFlow({ config, store, google, line, conflicts: this.conflicts, now, push });
    this.registration = new RegistrationFlow({ students: config.students, store, line });
  }

  push(kind, id, recipient, message, expires, caseId) {
    return { id: kind + ':' + id + ':' + recipient, recipient, message, expires, kind, caseId };
  }

  teacherAlert(row, reason, now) {
    const name = this.students.get(row.student_key)?.name ?? row.student_key;
    const when = intervalLabel(row.original_start, row.original_end);
    return this.push('review', row.id, TEACHER,
      textMessage('老師您好，' + name + ' 的學生晤談需要您協助。原定 ' + when + '。' + reasons[reason] + '。案件編號 ' + row.id),
      now + DAY, row.id);
  }

  review(row, reason, now, actingUser) {
    const pushes = [this.teacherAlert(row, reason, now)];
    if (row.state === 'applying') {
      pushes.push(this.push('student_review', row.id, row.student_key,
        textMessage('你選擇的改期需要老師再確認。已通知老師，請等候最後的晤談安排。'), now + DAY, row.id));
    }
    return this.store.transition(row, 'review', reason, pushes, now, actingUser);
  }

  async discover(now) {
    const { calendarId, busyCalendarIds } = this.config;
    const horizon = now + 45 * DAY;
    // Read through the last candidate week while limiting conflict detection to 45 days.
    const availabilityEnd = horizon + 14 * DAY;
    const [{ items }, extra] = await Promise.all([
      this.google.list(calendarId, now, availabilityEnd),
      this.google.extraBusy(busyCalendarIds, now, availabilityEnd),
    ]);
    const [{ results: participants }, existing] = await Promise.all([
      this.store.q('SELECT key,active FROM participants').all(), this.store.existing(calendarId, now, horizon),
    ]);
    const active = new Set(participants.filter(row => row.active).map(row => row.key));
    const handled = new Set(existing.map(row => row.series_id + ':' + row.original_start));
    const studentBySeries = new Map(this.config.students.map(student => [student.seriesId, student]));
    // With the calendar source selected by ID, only the current instance is excluded from conflicts.
    const occupied = items.flatMap(event => busyIntervals([event]).map(slot => ({ ...slot, id: event.id })));
    const found = [];
    for (const event of items) {
      const student = studentBySeries.get(event.recurringEventId);
      if (!student || !event.id || event.status === 'cancelled') continue;
      const start = timeValue(event.start);
      const end = timeValue(event.end);
      const original = timeValue(event.originalStartTime);
      if (!Number.isFinite(original) || original < now || original >= horizon || !(end > start) ||
          handled.has(student.seriesId + ':' + original)) continue;
      const busy = [...occupied.filter(slot => slot.id !== event.id), ...extra];
      if (available({ start, end }, busy)) continue;
      const row = {
        id: crypto.randomUUID(), calendar_id: calendarId, event_id: event.id, series_id: student.seriesId,
        student_key: student.key, source_etag: event.etag ?? null, original_start: original,
        original_end: original + (end - start), options: '[]', deadline: now, state: 'review', reason: null,
      };
      const options = candidateOptions(original, now, busy);
      const deadline = options.length ? Math.min(now + 48 * HOUR, original - 30 * MINUTE, options[0].start - 30 * MINUTE) : now;
      if (special(event)) row.reason = 'calendar_special';
      else if (!normalInstance(event, student)) row.reason = 'calendar_changed';
      else if (original - 30 * MINUTE <= now) row.reason = 'too_late';
      else if (!options.length) row.reason = 'no_slot';
      else if (!active.has(student.key)) row.reason = 'student_unbound';
      else {
        row.state = 'offered';
        row.options = JSON.stringify(options);
        row.deadline = deadline;
      }
      const push = row.reason
        ? this.teacherAlert(row, row.reason, now)
        : this.push('offer', row.id, student.key, proposalMessage(row), deadline, row.id);
      found.push({ row, push, options });
    }
    return found;
  }

  async preview() {
    const rows = await this.discover(this.now());
    return rows.map(({ row, options }) => ({
      student: this.students.get(row.student_key)?.name,
      original: intervalLabel(row.original_start, row.original_end),
      candidates: options.map(slot => intervalLabel(slot.start, slot.end)),
      disposition: row.reason ? reasons[row.reason] : '可以透過 LINE 協調',
    }));
  }

  async scan() {
    const now = this.now();
    try {
      const rows = await this.discover(now);
      return await this.store.recordScan(rows, now);
    } catch (error) {
      const reason = safeError(error);
      const date = localDay(now);
      const push = this.push('system', date + ':' + reason, TEACHER,
        textMessage('老師您好，學生晤談助理暫時無法檢查行事曆。請查看管理狀態。代碼 ' + reason), now + DAY);
      await this.store.db.batch([this.store.audit(now, 'scan_error', null, reason), this.store.push(push, now)]);
      return 0;
    }
  }

  async preflight() {
    const now = this.now();
    const { calendarId, busyCalendarIds, students } = this.config;
    const googleCheck = async () => {
      const result = await this.google.list(calendarId, now, now + 45 * DAY);
      await this.google.extraBusy(busyCalendarIds, now, now + 45 * DAY);
      return {
        access: result.accessRole,
        calendars: 1 + busyCalendarIds.length,
        series: students.map(student => ({
          student: student.name,
          matchingInstances: result.items.filter(event => normalInstance(event, student)).length,
        })),
      };
    };
    const [google, line] = await Promise.allSettled([googleCheck(), this.line.info()]);
    return {
      google: google.status === 'fulfilled' ? google.value : { error: safeError(google.reason) },
      line: line.status === 'fulfilled' ? { displayName: line.value.displayName, basicId: line.value.basicId } : { error: safeError(line.reason) },
    };
  }

  async issueInvite(key) {
    const now = this.now();
    const code = randomCode();
    const deadline = now + HOUR;
    return await this.store.invite(key, await sha256(code), deadline, now) ? { code, deadline } : null;
  }

  async testLine() {
    const teacher = (await this.store.participants()).find(row => row.key === TEACHER);
    if (!teacher?.active) return null;
    const now = this.now();
    const id = crypto.randomUUID();
    const deadline = now + HOUR;
    await this.store.queueTest(id, now, this.push('test', id, TEACHER, lineTestMessage(id), deadline));
    return { id, deadline };
  }

  async onLine(action) {
    const now = this.now();
    // Old deliveries cannot reuse a code or select a newly created case.
    if (action.timestamp < now - DAY || action.timestamp > now + 5 * MINUTE) return {};
    if (action.type === 'book-choice') return this.bookings.choose(action);
    if (action.type === 'book-confirm') return this.bookings.confirm(action);
    if (action.type === 'book-decline') return this.bookings.decline(action);
    if (action.type === 'register' || action.type === 'registration-submit' || action.type === 'registration-prompt') {
      return this.registration.handle(action, now);
    }
    if (action.type === 'decline') {
      const row = await this.store.case(action.caseId);
      if (row?.state === 'offered' && await this.review(row, 'none_work', now, action.userId)) {
        return { reply: noSuitableTimeReply, drain: true };
      }
      return { reply: '這筆改期選項已失效或已處理。' };
    }
    const hash = action.type === 'bind' ? await sha256(action.code) : undefined;
    const { fresh, selected } = await this.store.selections(action, now, hash);
    if (!fresh) return {};
    if (action.type === 'book-more') return this.bookings.page(action);
    if (action.type === 'bind') {
      return selected
        ? { reply: '身分綁定完成。請保留此官方帳號為好友，以便接收學生晤談通知。', menuUser: action.userId }
        : { reply: '綁定碼已使用、已過期，或此 LINE 帳號已有綁定。請向老師確認。' };
    }
    if (action.type === 'status') {
      const registeredName = selected?.active ? null : await this.store.bookingNameByLine(action.userId);
      const registered = selected?.active || registeredName;
      const text = registered ? this.registration.registeredMessage(selected?.key, registeredName) :
        '第一次預約請先選「學生身分登記」並填寫姓名。';
      return { reply: bookingEntryMessage(text, !registered) };
    }
    if (action.type === 'conflict-status') {
      return selected?.active && selected.key === TEACHER ? { reply: await this.conflicts.teacherSummary() } : {};
    }
    if (action.type === 'book' || action.type === 'rebook') {
      return { bookingUser: {
        userId: action.userId, key: selected?.active ? selected.key : null,
        timestamp: action.timestamp, conflictId: action.conflictId,
      } };
    }
    if (action.type === 'book-name') return this.bookings.namePrompt(action);
    if (action.type === 'book-name-text') return this.bookings.rename(action);
    if (action.type === 'test') {
      return selected ? { reply: '已收到按鈕回傳，LINE 連線測試完成。' } : {};
    }
    if (action.type === 'choice') {
      if (!selected) return { reply: '這個選項目前無法使用。請查看最新通知或聯絡老師。' };
      const row = await this.store.case(selected.id);
      return row?.state === 'offered' ? { reply: confirmationMessage(row, action.index, false) } : {};
    }
    if (action.type === 'confirm') {
      if (selected) return { caseId: selected.id, reply: '已收到你的選擇，正在確認行事曆。結果會再透過 LINE 通知。' };
      const participant = await this.store.participantByLine(action.userId);
      if (!participant?.active || participant.key === TEACHER) return {};
      const row = await this.store.case(action.caseId);
      if (row?.student_key === participant.key && row.state === 'offered' && row.deadline > now &&
          JSON.parse(row.options)[action.index]?.start > now &&
          await this.store.q('SELECT 1 FROM case_choices WHERE case_id=? AND user_id=? AND choice_index=?',
            row.id, action.userId, action.index).first() &&
          await this.review(row, 'selection_overlap', now, action.userId)) {
        return { reply: '這個時段目前需要老師確認。已建案請老師協助。', drain: true };
      }
      return { reply: '這個選項目前無法使用。請查看最新通知或聯絡老師。' };
    }
    return {};
  }

  async confirm(row, now) {
    const name = this.students.get(row.student_key)?.name ?? row.student_key;
    const when = intervalLabel(row.target_start, row.target_end);
    const old = intervalLabel(row.original_start, row.original_end);
    const student = this.push('confirmation', row.id, row.student_key,
      textMessage('你的學生晤談已由 ' + old + ' 改至 ' + when + '（台灣時間）。地點為老師辦公室。'), now + DAY, row.id);
    const teacher = this.push('confirmation', row.id, TEACHER,
      textMessage('老師您好，' + name + ' 的學生晤談已由 ' + old + ' 改至 ' + when + '（台灣時間），地點為老師辦公室。'), now + DAY, row.id);
    return this.store.transition(row, 'moved', null, [student, teacher], now);
  }

  applied(row, event) {
    return event.id === row.event_id && event.recurringEventId === row.series_id &&
      event.extendedProperties?.private?.[MOVE_MARKER] === row.id &&
      timeValue(event.start) === row.target_start && timeValue(event.end) === row.target_end;
  }

  async applyOne(onlyId) {
    const now = this.now();
    const row = await this.store.claimApply(now, onlyId);
    if (!row) return false;
    const student = this.students.get(row.student_key);
    const original = { start: row.original_start, end: row.original_end };
    const target = { start: row.target_start, end: row.target_end };
    try {
      if (!student || row.calendar_id !== this.config.calendarId || row.series_id !== student.seriesId) {
        return this.review(row, 'calendar_changed', now);
      }
      const event = await this.google.get(row.calendar_id, row.event_id);
      if (event.status !== 'cancelled' && this.applied(row, event)) return this.confirm(row, now);
      if (event.status === 'cancelled') return this.review(row, 'calendar_missing', now);
      if (!isBackupSlot(target)) return this.review(row, 'backup_window_changed', now);
      if (special(event)) return this.review(row, 'calendar_special', now);
      if (event.id !== row.event_id || !normalInstance(event, student) || event.etag !== row.source_etag ||
          timeValue(event.start) !== original.start || timeValue(event.end) !== original.end) {
        return this.review(row, 'calendar_changed', now);
      }
      if (Math.min(original.start, target.start) <= this.now() + 15 * MINUTE) return this.review(row, 'too_late', now);
      const start = Math.min(original.start, target.start);
      const end = Math.max(original.end, target.end);
      const [{ items }, extra] = await Promise.all([
        this.google.list(row.calendar_id, start, end),
        this.google.extraBusy(this.config.busyCalendarIds, start, end),
      ]);
      const busy = [...busyIntervals(items, row.event_id), ...extra];
      if (available(original, busy)) return this.review(row, 'source_conflict_gone', now);
      if (!available(target, busy)) return this.review(row, 'chosen_busy', now);
      if (!await this.store.applyAuthorized(row)) return this.review(row, 'authorization_changed', now);
      if (Math.min(original.start, target.start) <= this.now() + 15 * MINUTE) return this.review(row, 'too_late', now);
      const moved = await this.google.move(row.calendar_id, event, target, row.id);
      if (!this.applied(row, moved)) throw new GoogleError('patch');
      return this.confirm(row, this.now());
    } catch (error) {
      if (error instanceof GoogleError && error.status === 404) return this.review(row, 'calendar_missing', now);
      if (error instanceof GoogleError && error.transient && row.attempts < 4) {
        await this.store.retryApply(row, now, safeError(error));
        return true;
      }
      await this.store.db.batch([this.store.audit(now, 'calendar_apply_error', row.id, safeError(error))]);
      return this.review(row, 'calendar_failed', now);
    }
  }

  async offerFailure(item, now) {
    if (item.kind !== 'offer') return;
    const row = await this.store.case(item.case_id);
    if (row?.state === 'offered') await this.review(row, 'offer_failed', now);
  }

  async drain(limit = 4) {
    for (let index = 0; index < limit; index++) {
      const now = this.now();
      const item = await this.store.claimPush(now);
      if (!item) return;
      if (!item.destination || !await this.store.canDeliver(item.recipient, item.destination)) {
        await this.store.finishPush(item, 'failed', 'recipient_unavailable', now);
        await this.offerFailure(item, now);
        continue;
      }
      try {
        await this.line.push(item.destination, JSON.parse(item.message), item.retry_key);
      } catch (error) {
        const retry = error instanceof LineError && error.transient && item.attempts < 8;
        await this.store.finishPush(item, retry ? 'pending' : 'failed', safeError(error), now);
        if (!retry) await this.offerFailure(item, now);
        continue;
      }
      await this.store.finishPush(item, 'sent', null, now);
    }
  }

  async scheduled(scheduledTime) {
    const now = this.now();
    const runtime = await this.store.runtime();
    const monitor = await this.store.q('SELECT enabled FROM calendar_monitor WHERE id=1').first();
    await this.store.sweep(now);
    if (runtime.enabled) {
      const expired = await this.store.openForReview(now);
      for (const row of expired) await this.review(row, 'no_reply', now);
      await this.applyOne();
      if (!monitor.enabled && new Date(scheduledTime).getUTCMinutes() % 30 === 0) await this.scan();
    }
    await this.bookings.applyOne();
    if (monitor.enabled) {
      await this.conflicts.requestScan();
      await Promise.all([this.calendarWatch.renew(), this.conflicts.run()]);
    }
    await this.drain();
  }
}
