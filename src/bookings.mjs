import { TEACHER } from './config.mjs';
import { activeRebooking } from './conflicts.mjs';
import { bookingEventId, BOOKING_MARKER, busyIntervals, GoogleError } from './google.mjs';
import { bookingMessage, confirmationMessage, LineError, noSuitableTimeReply, registrationNameMessage, textMessage } from './line.mjs';
import { bookingFriendProfile } from './menu.mjs';
import { sha256 } from './security.mjs';
import { available, bookingOptions, bookingRange, DAY, HOUR, intervalLabel, isBackupSlot, MINUTE, timeValue } from './time.mjs';

const unready = '行事曆目前無法提供可預約時段。請稍後再試或聯絡老師。';
const expired = '這個預約選項已失效，請重新點選「預約晤談」。';
const pending = '已收到預約確認，正在檢查行事曆。完成後會用 LINE 通知。';
const friendPrefix = 'friend:';
const nameLimit = 30;
const permitted = `EXISTS (SELECT 1 FROM participants p
  WHERE p.key=bookings.participant_key AND p.active=1
  AND COALESCE(p.line_user_id,p.booking_user_id)=bookings.user_id)`;
const openForUser = `user_id=? AND (state='applying' OR (state='offered' AND deadline>?)) AND ${permitted}`;
const notes = {
  none_work: '列出的時段都不合適',
  backup_window_changed: '選定時段已移出備用範圍',
  booking_window_changed: '選定時段已超出預約日期範圍',
  meeting_overlap: '原晤談時段與另一場學生晤談重疊',
  source_conflict_gone: '原時段的衝突已解除，請確認目前安排',
  source_changed: '原晤談已有變更，請確認目前安排',
  chosen_busy: '選定時段已有其他行程',
  too_late: '選定的時段即將開始',
  calendar_failed: '需要確認行事曆的新增結果',
  authorization_changed: '身分或行事曆授權已變更',
};

function slotInRange(slot, range) {
  return slot.start >= range.start && slot.end <= range.end;
}

function cleanName(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function usesStudentName(row) {
  return row.participant_key !== TEACHER && !row.reschedule_id;
}

export class BookingFlow {
  constructor({ config, store, google, line, conflicts, now, push }) {
    this.config = config;
    this.store = store;
    this.google = google;
    this.line = line;
    this.conflicts = conflicts;
    this.now = now;
    this.push = push;
    this.names = new Map(config.students.map(student => [student.key, student.name]));
  }

  async busy(start, end) {
    const [{ items }, extra] = await Promise.all([
      this.google.list(this.config.calendarId, start, end),
      this.google.extraBusy(this.config.busyCalendarIds, start, end),
    ]);
    return [...busyIntervals(items), ...extra];
  }

  open(userId, now) {
    return this.store.q(`SELECT * FROM bookings WHERE ${openForUser}
      ORDER BY state='applying' DESC,created_at DESC LIMIT 1`, userId, now).first();
  }

  name(row) {
    return row.display_name || row.line_display_name || this.names.get(row.participant_key) || 'LINE 好友';
  }

  async studentName(userId) {
    const participant = await this.store.participantByLine(userId);
    return (participant?.active && this.names.get(participant.key)) || this.store.bookingNameByLine(userId);
  }

  offered(action, now) {
    return this.store.q(`SELECT * FROM bookings WHERE id=? AND user_id=?
      AND state='offered' AND deadline>? AND ${permitted} AND ${activeRebooking}`,
    action.caseId, action.userId, now).first();
  }

  async registrationReply(userId) {
    const name = await this.studentName(userId);
    return name ? '預約會使用你已登記的姓名「' + name + '」。' : registrationNameMessage();
  }

  async offer(userId, key, requestedAt = this.now(), conflictId = null) {
    const conflict = conflictId ? await this.conflicts.rebooking(conflictId, userId) : null;
    if (conflictId && !conflict) return textMessage('這筆改期目前無法辦理。請查看最新通知或聯絡老師。');
    let profile;
    try {
      profile = await bookingFriendProfile(this.store, this.line, userId);
    } catch {
      return textMessage('目前無法確認 LINE 好友狀態。請稍後再試。');
    }
    if (!profile) return textMessage('請先將本官方帳號加入好友，再點「預約晤談」。');
    const now = this.now();
    if (conflict) {
      key = conflict.participant_key;
    } else if (key !== TEACHER && !this.names.has(key)) {
      key = friendPrefix + await sha256(userId);
      await this.store.activateBookingFriend(key, userId, requestedAt);
    }
    const existing = await this.open(userId, now);
    if (existing?.state === 'applying') return textMessage(pending);
    const needsName = !conflict && key !== TEACHER;
    const registeredName = needsName ? await this.studentName(userId) : null;
    if (needsName && !registeredName) return registrationNameMessage();

    const range = bookingRange(now);
    const cached = existing && JSON.parse(existing.options);
    const reusable = cached && existing.reschedule_id === conflictId && bookingRange(existing.created_at).start === range.start &&
      cached.every(slot => slotInRange(slot, range) && isBackupSlot(slot));
    let options;
    try {
      options = bookingOptions(range.start, range.end, await this.busy(range.start, range.end), Boolean(conflict));
    } catch {
      return reusable ? bookingMessage(existing) : textMessage(unready);
    }
    const offeredOptions = JSON.stringify(options);
    if (reusable && existing.options === offeredOptions) return bookingMessage(existing);
    if (existing) {
      const reason = existing.reschedule_id !== conflictId ? 'new_booking_request' :
        reusable ? 'booking_options_changed' : 'booking_window_changed';
      await this.finish(existing, 'closed', reason, [], now, userId);
    }
    const deadline = Math.min(now + 48 * HOUR, options.length ? options[0].start - 30 * MINUTE : Infinity);
    const id = crypto.randomUUID();
    const nickname = conflict?.name || [...cleanName(profile.displayName)].slice(0, nameLimit).join('') ||
      this.names.get(key) || 'LINE 好友';
    await this.store.db.batch([
      this.store.q(`UPDATE bookings SET state='closed',reason='expired',updated_at=?
        WHERE state='offered' AND ((user_id=? AND deadline<=?) OR (participant_key=? AND user_id<>?))`,
      now, userId, now, key, userId),
      this.store.q(`INSERT OR IGNORE INTO bookings
        (id,participant_key,user_id,calendar_id,options,deadline,state,created_at,updated_at,line_display_name,display_name,reschedule_id)
        SELECT ?, p.key, ?, ?,?,?, 'offered',?,?,?,?,? FROM participants p
        WHERE p.key=? AND COALESCE(p.line_user_id,p.booking_user_id)=? AND p.active=1
        AND (? IS NULL OR EXISTS(SELECT 1 FROM meeting_conflicts WHERE id=? AND state='pending'))
        AND NOT EXISTS(SELECT 1 FROM bookings WHERE ${openForUser})`,
      id, userId, this.config.calendarId, offeredOptions, deadline, now, now, nickname, registeredName, conflictId,
      key, userId, conflictId, conflictId, userId, now),
      this.store.q("INSERT INTO audit(at,action,case_id) SELECT ?,'booking_offered',? WHERE changes()=1", now, id),
    ]);
    const row = await this.open(userId, now);
    return row?.state === 'offered' && row.reschedule_id === conflictId
      ? bookingMessage(row) : textMessage(row?.state === 'applying' ? pending : expired);
  }

  async page(action) {
    const now = this.now();
    const row = await this.store.q(`SELECT id,options,reschedule_id,created_at FROM bookings
      WHERE id=? AND user_id=? AND state='offered' AND deadline>? AND reschedule_id IS NULL AND ${permitted}`,
    action.caseId, action.userId, now).first();
    if (!row || bookingRange(row.created_at).start !== bookingRange(now).start) return { reply: expired };
    return { reply: bookingMessage(row, action.offset) ?? expired };
  }

  async choose(action) {
    const now = this.now();
    const offer = await this.offered(action, now);
    if (!offer) return { reply: expired };
    const needsName = usesStudentName(offer);
    const registeredName = needsName ? await this.studentName(action.userId) : null;
    if (needsName && !registeredName) return { reply: registrationNameMessage() };
    const range = bookingRange(now);
    const startPath = '$[' + action.index + '].start';
    const endPath = '$[' + action.index + '].end';
    const row = await this.store.q(`UPDATE bookings SET choice_index=?,chosen_at=?,updated_at=?,display_name=COALESCE(?,display_name)
      WHERE id=? AND state='offered' AND user_id=? AND deadline>?
      AND json_extract(options,?)>=? AND json_extract(options,?)<=?
      AND (chosen_at IS NULL OR chosen_at<=?) AND ${permitted} AND ${activeRebooking}
      RETURNING id,options,participant_key,line_display_name,display_name,reschedule_id`,
    action.index, action.timestamp, now, registeredName, action.caseId, action.userId, now, startPath, range.start, endPath, range.end,
    action.timestamp).first();
    return row ? { reply: confirmationMessage(row, action.index, true, this.name(row)) } : { reply: expired };
  }

  async namePrompt(action) {
    const row = await this.offered(action, this.now());
    if (!row || row.choice_index !== action.index || row.reschedule_id) return { reply: expired };
    return { reply: row.participant_key === TEACHER
      ? '請傳送「預約名稱 王小明」來更改顯示名稱，最多 30 個字。傳「預約名稱」可用回 LINE 暱稱。'
      : await this.registrationReply(action.userId) };
  }

  async rename(action) {
    const participant = await this.store.participantByLine(action.userId);
    if (participant?.key !== TEACHER) return { reply: await this.registrationReply(action.userId) };
    const name = cleanName(action.name);
    if ([...name].length > nameLimit) return { reply: '預約名稱最多 30 個字。請縮短後再傳送。' };
    const now = this.now();
    const row = await this.store.q(`UPDATE bookings SET display_name=?,name_updated_at=?,updated_at=?
      WHERE user_id=? AND participant_key=? AND state='offered' AND reschedule_id IS NULL AND deadline>? AND chosen_at<=?
      AND (name_updated_at IS NULL OR name_updated_at<=?) AND ${permitted}
      RETURNING id,options,choice_index,participant_key,line_display_name,display_name`,
    name || null, action.timestamp, now, action.userId, TEACHER, now, action.timestamp, action.timestamp).first();
    return row ? { reply: confirmationMessage(row, row.choice_index, true, this.name(row)) }
      : { reply: '請先在「預約晤談」選擇時段，再設定預約名稱。' };
  }

  async confirm(action) {
    const now = this.now();
    const offer = await this.offered(action, now);
    if (!offer) return { reply: expired };
    const needsName = usesStudentName(offer);
    const registeredName = needsName ? await this.studentName(action.userId) : null;
    if (needsName && !registeredName) return { reply: registrationNameMessage() };
    const range = bookingRange(now);
    const startPath = '$[' + action.index + '].start';
    const endPath = '$[' + action.index + '].end';
    const [updated] = await this.store.db.batch([
      this.store.q(`UPDATE bookings SET state='applying',target_start=json_extract(options,?),
        target_end=json_extract(options,?),apply_after=?,updated_at=?,display_name=COALESCE(?,display_name)
        WHERE id=? AND user_id=? AND state='offered' AND deadline>? AND choice_index=?
        AND json_extract(options,?)>=? AND json_extract(options,?)<=? AND ${permitted} AND ${activeRebooking}
        AND NOT EXISTS(SELECT 1 FROM bookings b WHERE b.state='applying'
          AND (b.reschedule_id=bookings.reschedule_id OR
          (b.target_start<json_extract(bookings.options,?) AND b.target_end>json_extract(bookings.options,?))))
        AND NOT EXISTS(SELECT 1 FROM cases c WHERE c.state='applying'
          AND c.target_start<json_extract(bookings.options,?) AND c.target_end>json_extract(bookings.options,?))
        RETURNING id`, startPath, endPath, now, now, registeredName, action.caseId, action.userId, now, action.index,
      startPath, range.start, endPath, range.end,
      endPath, startPath, endPath, startPath),
      this.store.q("INSERT INTO audit(at,action,case_id) SELECT ?,'booking_confirmed',? WHERE changes()=1", now, action.caseId),
    ]);
    if (updated.results[0]) return { bookingId: action.caseId, reply: pending };
    return { reply: '這個時段目前無法確認。請選其他時段，或重新點「預約晤談」取得新選項。' };
  }

  async decline(action) {
    const now = this.now();
    const row = await this.offered(action, now);
    if (!row || !await this.review(row, 'none_work', now, action.userId)) return { reply: expired };
    return { reply: noSuitableTimeReply, drain: true };
  }

  async close(id) {
    const row = await this.store.q("SELECT * FROM bookings WHERE id=? AND state IN ('offered','review')", id).first();
    return row ? this.finish(row, 'closed', 'manual', [], this.now()) : false;
  }

  async finish(row, state, reason, pushes, now, actingUser) {
    const tag = crypto.randomUUID();
    const actor = actingUser ? `AND user_id=? AND deadline>? AND ${permitted}` : '';
    const guard = 'EXISTS (SELECT 1 FROM bookings WHERE id=? AND transition_tag=?)';
    const result = await this.store.db.batch([
      this.store.q(`UPDATE bookings SET state=?,reason=?,transition_tag=?,updated_at=?,lease_owner=NULL,lease_until=0
        WHERE id=? AND state=? AND lease_owner IS ? ${actor}`, state, reason, tag, now,
      row.id, row.state, row.lease_owner, ...(actingUser ? [actingUser, now] : [])),
      this.store.q('INSERT INTO audit(at,action,case_id,detail) SELECT ?,?,?,? WHERE changes()=1', now,
        'booking_' + state, row.id, reason),
      ...(row.reschedule_id && state === 'booked' ? this.conflicts.resolve(row, now, tag) : []),
      ...pushes.map(push => this.store.push({ ...push, conflictId: row.reschedule_id }, now, guard, row.id, tag)),
    ]);
    return result[0].meta.changes > 0;
  }

  review(row, reason, now, userId) {
    const text = (row.participant_key === TEACHER ? '你的學生晤談預約' : this.name(row) + ' 的學生晤談預約') +
      '需要協助。' + notes[reason] + '。預約編號 ' + row.id;
    const pushes = [this.push('booking_review', row.id, TEACHER, textMessage(text), now + DAY)];
    if (row.state === 'applying' && row.participant_key !== TEACHER) {
      const notice = this.push('booking_review_requester', row.id, row.participant_key,
        textMessage('這筆預約需要老師再確認。已通知老師協助安排。'), now + DAY);
      pushes.push({ ...notice, destination: row.user_id });
    }
    return this.finish(row, 'review', reason, pushes, now, userId);
  }

  booked(row, now) {
    const when = intervalLabel(row.target_start, row.target_end) + '（台灣時間）';
    const result = row.reschedule_id ? '改期完成，已更新原行事曆活動。' : '預約完成，已加入行事曆。';
    const recipient = row.participant_key === TEACHER ? '' : this.name(row) + '，';
    const verb = row.reschedule_id ? '已改期至 ' : '已預約 ';
    const student = this.push('booking_confirmation', row.id, row.participant_key,
      textMessage(recipient + result + '時間為 ' + when + '，地點為老師辦公室。'), now + DAY);
    const pushes = [{ ...student, destination: row.user_id }];
    if (row.participant_key !== TEACHER) {
      pushes.push(this.push('booking_confirmation', row.id, TEACHER,
        textMessage(this.name(row) + ' 的學生晤談' + verb + when + '，地點為老師辦公室。'), now + DAY));
    }
    return this.finish(row, 'booked', null, pushes, now);
  }

  matches(row, event) {
    return event.status !== 'cancelled' && event.id === bookingEventId(row.id) &&
      event.extendedProperties?.private?.[BOOKING_MARKER] === row.id &&
      timeValue(event.start) === row.target_start && timeValue(event.end) === row.target_end;
  }

  async applyOne(id) {
    const now = this.now();
    const row = await this.store.q(`UPDATE bookings SET lease_owner=?,lease_until=?,attempts=attempts+1
      WHERE id=(SELECT id FROM bookings WHERE state='applying' AND apply_after<=? AND lease_until<=?
        AND (? IS NULL OR id=?) ORDER BY apply_after,id LIMIT 1) RETURNING *`,
    crypto.randomUUID(), now + 2 * MINUTE, now, now, id ?? null, id ?? null).first();
    if (!row) return false;
    try {
      if (row.calendar_id !== this.config.calendarId ||
          (row.participant_key !== TEACHER && !this.names.has(row.participant_key) &&
            !row.participant_key.startsWith(friendPrefix))) {
        return this.review(row, 'authorization_changed', now);
      }
      const conflict = row.reschedule_id ? await this.store.q(`SELECT * FROM meeting_conflicts WHERE id=?
        AND calendar_id=? AND participant_key=?`, row.reschedule_id, row.calendar_id, row.participant_key).first() : null;
      if (row.reschedule_id && !conflict) return this.review(row, 'authorization_changed', now);
      let existing;
      try {
        existing = await this.google.get(row.calendar_id, conflict ? conflict.event_id : bookingEventId(row.id));
      } catch (error) {
        if (!(error instanceof GoogleError && error.status === 404)) throw error;
      }
      if (conflict && !existing) return this.review(row, 'source_changed', now);
      if (conflict && this.conflicts.applied(conflict, existing, row)) return this.booked(row, now);
      if (!conflict && existing) {
        return this.matches(row, existing) ? this.booked(row, now) : this.review(row, 'calendar_failed', now);
      }
      const slot = { start: row.target_start, end: row.target_end };
      if (!isBackupSlot(slot)) return this.review(row, 'backup_window_changed', now);
      // The timestamp is set when the booking is confirmed and stays fixed during retries.
      if (!slotInRange(slot, bookingRange(row.updated_at))) return this.review(row, 'booking_window_changed', now);
      if (slot.start <= this.now() + 15 * MINUTE) return this.review(row, 'too_late', now);
      if (conflict) {
        const reason = await this.conflicts.validate(conflict, existing, slot, this.now());
        if (reason) return this.review(row, reason, now);
      } else if (!available(slot, await this.busy(slot.start, slot.end))) {
        return this.review(row, 'chosen_busy', now);
      }
      if (!await bookingFriendProfile(this.store, this.line, row.user_id)) {
        return this.review(row, 'authorization_changed', now);
      }
      const authorized = await this.store.q(`SELECT 1 AS ok FROM bookings WHERE id=? AND lease_owner=?
        AND state='applying' AND ${permitted} AND ${activeRebooking}`, row.id, row.lease_owner).first();
      if (!authorized) return this.review(row, 'authorization_changed', now);
      if (slot.start <= this.now() + 15 * MINUTE) return this.review(row, 'too_late', now);
      if (conflict) {
        const moved = await this.conflicts.move(conflict, existing, slot, row.id);
        if (!this.conflicts.applied(conflict, moved, row)) throw new GoogleError('patch');
        return this.booked(row, this.now());
      }
      const summary = row.participant_key === TEACHER && !row.line_display_name && !row.display_name
        ? '學生晤談助理｜預約測試'
        : '學生晤談－' + this.name(row);
      const event = await this.google.createBooking(row.calendar_id, slot, row.id, summary);
      if (!this.matches(row, event)) throw new GoogleError('insert');
      return this.booked(row, this.now());
    } catch (error) {
      const retryable = (error instanceof LineError && error.transient) ||
        (error instanceof GoogleError && (error.transient || error.status === 409));
      if (retryable && row.attempts < 4) {
        await this.store.db.batch([
          this.store.q(`UPDATE bookings SET lease_until=0,lease_owner=NULL,apply_after=? WHERE id=?
            AND state='applying' AND lease_owner=?`, now + MINUTE, row.id, row.lease_owner),
          this.store.q("INSERT INTO audit(at,action,case_id,detail) SELECT ?,'booking_retry',?,? WHERE changes()=1",
            now, row.id, error.message),
        ]);
        return true;
      }
      return this.review(row, 'calendar_failed', now);
    }
  }
}
