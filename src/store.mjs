import { DAY, HOUR, MINUTE, monthRange } from './time.mjs';
import { TEACHER } from './config.mjs';

const enabled = "(SELECT value FROM settings WHERE key='automation') = 'on'";
const d1Changes = result => result.meta.changes > 0;
const leaseTime = 2 * MINUTE;
const retryWindow = 23 * HOUR;
const pushCap = 180;

export class Store {
  constructor(database) {
    this.db = database;
  }

  q(sql, ...args) {
    const statement = this.db.prepare(sql);
    return args.length ? statement.bind(...args) : statement;
  }

  async setup(keys) {
    await this.db.batch(keys.map(key => this.q('INSERT OR IGNORE INTO participants (key) VALUES (?)', key)));
  }

  async runtime() {
    const { results } = await this.q("SELECT key,value FROM settings WHERE key IN ('automation','last_scan')").all();
    const settings = Object.fromEntries(results.map(row => [row.key, row.value]));
    return { enabled: settings.automation === 'on', lastScan: settings.last_scan ? Number(settings.last_scan) : null };
  }

  setting(key, value) {
    return this.q('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value));
  }

  async settingValue(key) {
    return (await this.q('SELECT value FROM settings WHERE key=?', key).first())?.value;
  }

  async setAutomation(enable, keys, now) {
    if (!enable) {
      await this.db.batch([this.setting('automation', 'off'), this.audit(now, 'automation_off')]);
      return true;
    }
    const placeholders = keys.map(() => '?').join(',');
    const [changed] = await this.db.batch([
      this.q(`INSERT INTO settings(key,value) SELECT 'automation','on'
        WHERE (SELECT COUNT(*) FROM participants WHERE active=1 AND key IN (${placeholders})) = ?
        ON CONFLICT(key) DO UPDATE SET value='on'`, ...keys, keys.length),
      this.q("INSERT INTO audit(at,action) SELECT ?, 'automation_on' WHERE changes()=1", now),
    ]);
    return d1Changes(changed);
  }

  audit(now, action, caseId = null, detail = null) {
    return this.q('INSERT INTO audit(at,action,case_id,detail) VALUES (?,?,?,?)', now, action, caseId, detail);
  }

  async participants() {
    return (await this.q('SELECT key,active,line_user_id IS NOT NULL AS bound FROM participants WHERE booking_user_id IS NULL').all()).results;
  }

  participantByLine(lineUserId) {
    return this.q('SELECT key,active FROM participants WHERE line_user_id=?', lineUserId).first();
  }

  async bookingNameByLine(lineUserId) {
    return (await this.q('SELECT name FROM booking_names WHERE line_user_id=?', lineUserId).first())?.name ?? null;
  }

  activateBookingFriend(key, userId, timestamp) {
    return this.q(`INSERT INTO participants(key,booking_user_id,active,last_line_at) VALUES (?,?,1,?)
      ON CONFLICT(key) DO UPDATE SET active=1,last_line_at=excluded.last_line_at
      WHERE participants.booking_user_id=excluded.booking_user_id AND excluded.last_line_at>participants.last_line_at`,
    key, userId, timestamp).all();
  }

  async canDeliver(key, userId) {
    return Boolean(await this.q(`SELECT 1 FROM participants WHERE key=? AND active=1
      AND COALESCE(line_user_id, booking_user_id)=?`, key, userId).first());
  }

  async invite(key, hash, deadline, now) {
    const [updated] = await this.db.batch([
      this.q('UPDATE participants SET invite_hash=?, invite_deadline=? WHERE key=? AND line_user_id IS NULL', hash, deadline, key),
      this.q("INSERT INTO audit(at,action,detail) SELECT ?,'invite_issued',? WHERE changes()=1", now, key),
    ]);
    return d1Changes(updated);
  }

  async revoke(key, now) {
    const [updated] = await this.db.batch([
      this.q(`UPDATE participants SET line_user_id=NULL, active=0, last_line_at=0, invite_hash=NULL, invite_deadline=NULL
        WHERE key=? AND (line_user_id IS NOT NULL OR invite_hash IS NOT NULL)`, key),
      this.q("INSERT INTO audit(at,action,detail) SELECT ?,'binding_revoked',? WHERE changes()=1", now, key),
    ]);
    return d1Changes(updated);
  }

  async selections(action, now, hash) {
    const nonce = crypto.randomUUID();
    const first = this.q('INSERT OR IGNORE INTO webhook_receipts VALUES (?,?,?)', action.id, nonce, now);
    const gate = 'EXISTS (SELECT 1 FROM webhook_receipts WHERE id=? AND nonce=?)';
    const args = [action.id, nonce];
    const statements = [first];
    switch (action.type) {
      case 'bind':
        statements.push(
          this.q(`UPDATE OR IGNORE participants SET line_user_id=?, active=1, last_line_at=?,
            invite_hash=NULL, invite_deadline=NULL WHERE invite_hash=? AND invite_deadline>?
            AND line_user_id IS NULL AND ${gate} RETURNING key`,
          action.userId, action.timestamp, hash, now, ...args),
          this.q("INSERT INTO audit(at,action,detail) SELECT ?,'binding_done',key FROM participants WHERE line_user_id=? AND changes()=1",
            now, action.userId),
        );
        break;
      case 'registration-bind':
        statements.push(
          this.q(`UPDATE OR IGNORE participants SET line_user_id=?,active=1,last_line_at=?,
            invite_hash=NULL,invite_deadline=NULL WHERE key=? AND line_user_id IS NULL AND ${gate} RETURNING key`,
          action.userId, action.timestamp, action.studentKey ?? null, ...args),
          this.q(`INSERT INTO audit(at,action,detail) SELECT ?,'student_registered',? WHERE changes()=1`,
          now, action.studentKey + ':' + action.identitySource),
        );
        if (action.bookingName) {
          statements.push(
            this.q(`INSERT OR IGNORE INTO booking_names(line_user_id,name,created_at)
              SELECT ?,?,? WHERE ${gate}
              AND NOT EXISTS (SELECT 1 FROM participants WHERE line_user_id=?)`,
            action.userId, action.bookingName, now, ...args, action.userId),
            this.q(`INSERT INTO audit(at,action) SELECT ?,'booking_name_registered' WHERE changes()=1`, now),
          );
        }
        break;
      case 'follow':
      case 'unfollow':
        statements.push(
          this.q(`UPDATE participants SET active=?, last_line_at=? WHERE (line_user_id=? OR booking_user_id=?)
            AND (last_line_at<? OR (last_line_at=? AND active=1 AND ?=0)) AND ${gate} RETURNING key`,
          Number(action.type === 'follow'), action.timestamp, action.userId, action.userId, action.timestamp, action.timestamp,
          Number(action.type === 'follow'), ...args),
          this.q(`INSERT INTO audit(at,action,detail) SELECT ?,?,key FROM participants
            WHERE (line_user_id=? OR booking_user_id=?) AND last_line_at=? AND active=? AND changes()>0`,
          now, action.type, action.userId, action.userId, action.timestamp, Number(action.type === 'follow')),
        );
        break;
      case 'choice': {
        const path = '$[' + action.index + '].start';
        statements.push(this.q(`INSERT INTO case_choices(case_id,user_id,choice_index,chosen_at)
          SELECT cases.id,?,?,? FROM cases WHERE cases.id=? AND state='offered' AND deadline>?
          AND json_extract(options,?)>? AND ${enabled} AND ${gate}
          AND EXISTS(SELECT 1 FROM participants WHERE key=cases.student_key AND line_user_id=? AND active=1)
          ON CONFLICT(case_id) DO UPDATE SET user_id=excluded.user_id,choice_index=excluded.choice_index,chosen_at=excluded.chosen_at
            WHERE excluded.chosen_at>=case_choices.chosen_at
          RETURNING case_id AS id`, action.userId, action.index, action.timestamp, action.caseId, now, path, now, ...args, action.userId));
        break;
      }
      case 'confirm': {
        const startPath = '$[' + action.index + '].start';
        const endPath = '$[' + action.index + '].end';
        statements.push(
          this.q(`UPDATE cases SET state='applying', target_start=json_extract(options,?), target_end=json_extract(options,?),
            chosen_user_id=?, apply_after=?, updated_at=?
            WHERE id=? AND state='offered' AND deadline>? AND json_extract(options,?)>?
            AND ${enabled} AND ${gate}
            AND EXISTS(SELECT 1 FROM participants WHERE key=cases.student_key AND line_user_id=? AND active=1)
            AND EXISTS(SELECT 1 FROM case_choices WHERE case_id=cases.id AND user_id=? AND choice_index=?)
            AND NOT EXISTS(SELECT 1 FROM cases other WHERE other.state='applying'
              AND other.target_start<json_extract(cases.options,?) AND other.target_end>json_extract(cases.options,?))
            AND NOT EXISTS(SELECT 1 FROM bookings other WHERE other.state='applying'
              AND other.target_start<json_extract(cases.options,?) AND other.target_end>json_extract(cases.options,?))
            RETURNING id`, startPath, endPath, action.userId, now, now, action.caseId, now, startPath, now,
          ...args, action.userId, action.userId, action.index, endPath, startPath, endPath, startPath),
          this.q("INSERT INTO audit(at,action,case_id) SELECT ?, 'choice_accepted', ? WHERE changes()=1", now, action.caseId),
        );
        break;
      }
      case 'test':
        statements.push(
          this.q(`UPDATE line_tests SET confirmed_at=? WHERE id=? AND deadline>? AND confirmed_at IS NULL AND ${gate}
            AND EXISTS(SELECT 1 FROM participants WHERE key=? AND line_user_id=? AND active=1) RETURNING id`,
          now, action.testId, now, ...args, TEACHER, action.userId),
          this.q("INSERT INTO audit(at,action,detail) SELECT ?, 'line_test_confirmed', ? WHERE changes()=1", now, action.testId),
        );
        break;
      case 'book':
      case 'rebook':
      case 'conflict-status':
      case 'status':
        statements.push(this.q(`SELECT key,active FROM participants WHERE line_user_id=? AND ${gate}`, action.userId, ...args));
        break;
    }
    const [firstResult, selection] = await this.db.batch(statements);
    return { fresh: d1Changes(firstResult), selected: selection?.results?.[0] };
  }

  async existing(calendarId, start, end) {
    const { results } = await this.q('SELECT event_id,series_id,original_start FROM cases WHERE calendar_id=? AND original_start>=? AND original_start<?',
      calendarId, start, end).all();
    return results;
  }

  push(push, now, guard = '1=1', ...args) {
    return this.q(`INSERT OR IGNORE INTO outbox
      (id,case_id,conflict_id,kind,recipient,destination,message,retry_key,expires_at,next_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${guard}`, push.id, push.caseId ?? null, push.conflictId ?? null,
    push.kind, push.recipient, push.destination ?? null, JSON.stringify(push.message), crypto.randomUUID(), push.expires, now, now, ...args);
  }

  async recordScan(cases, now) {
    const statements = [];
    const indexes = [];
    for (const { row, push } of cases) {
      indexes.push(statements.length);
      statements.push(this.q(`INSERT OR IGNORE INTO cases
        (id,calendar_id,event_id,series_id,student_key,source_etag,original_start,original_end,options,deadline,state,reason,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${enabled}`, row.id, row.calendar_id, row.event_id,
      row.series_id, row.student_key, row.source_etag, row.original_start, row.original_end, row.options, row.deadline,
      row.state, row.reason, now, now));
      statements.push(this.q('INSERT INTO audit(at,action,case_id,detail) SELECT ?,?,?,? WHERE changes()=1',
        now, row.state === 'offered' ? 'proposal_created' : 'review_needed', row.id, row.reason));
      statements.push(this.push(push, now, 'EXISTS (SELECT 1 FROM cases WHERE id=?)', row.id));
    }
    statements.push(this.setting('last_scan', now));
    const result = await this.db.batch(statements);
    return indexes.filter(index => d1Changes(result[index])).length;
  }

  async openForReview(now) {
    return (await this.q("SELECT * FROM cases WHERE state='offered' AND deadline<=? ORDER BY deadline LIMIT 5", now).all()).results;
  }

  async claimApply(now, onlyId) {
    const owner = crypto.randomUUID();
    return this.q(`UPDATE cases SET lease_owner=?, lease_until=?, attempts=attempts+1
      WHERE id=(SELECT id FROM cases WHERE state='applying' AND apply_after<=? AND lease_until<=?
        AND (? IS NULL OR id=?) AND ${enabled} ORDER BY apply_after,id LIMIT 1) RETURNING *`,
    owner, now + leaseTime, now, now, onlyId ?? null, onlyId ?? null).first();
  }

  async applyAuthorized(row) {
    return Boolean(await this.q(`SELECT 1 AS ok FROM cases JOIN participants ON participants.key=cases.student_key
      WHERE cases.id=? AND cases.state='applying' AND cases.lease_owner=? AND ${enabled}
      AND participants.active=1 AND participants.line_user_id=cases.chosen_user_id`, row.id, row.lease_owner).first());
  }

  async retryApply(row, now, reason) {
    await this.db.batch([
      this.q(`UPDATE cases SET lease_until=0,lease_owner=NULL,apply_after=?
        WHERE id=? AND state='applying' AND lease_owner=?`, now + MINUTE, row.id, row.lease_owner),
      this.q("INSERT INTO audit(at,action,case_id,detail) SELECT ?,'calendar_retry',?,? WHERE changes()=1", now, row.id, reason),
    ]);
  }

  async transition(row, state, reason, pushes, now, actingUser) {
    const tag = crypto.randomUUID();
    const guard = 'EXISTS (SELECT 1 FROM cases WHERE id=? AND transition_tag=?)';
    const permitted = actingUser
      ? `AND deadline>? AND ${enabled} AND EXISTS(SELECT 1 FROM participants WHERE key=cases.student_key AND line_user_id=? AND active=1)`
      : '';
    const statements = [
      this.q(`UPDATE cases SET state=?,reason=?,updated_at=?,transition_tag=?,lease_owner=NULL,lease_until=0,chosen_user_id=NULL
        WHERE id=? AND state=? AND (lease_owner IS NULL AND ? IS NULL OR lease_owner=?) ${permitted}`,
      state, reason, now, tag, row.id, row.state, row.lease_owner, row.lease_owner, ...(actingUser ? [now, actingUser] : [])),
      this.q('INSERT INTO audit(at,action,case_id,detail) SELECT ?,?,?,? WHERE changes()=1', now, state, row.id, reason),
      ...pushes.map(push => this.push(push, now, guard, row.id, tag)),
    ];
    return d1Changes((await this.db.batch(statements))[0]);
  }

  case(id) {
    return this.q('SELECT * FROM cases WHERE id=?', id).first();
  }

  async queueTest(id, now, push) {
    await this.db.batch([
      this.q('INSERT INTO line_tests (id,created_at,deadline) VALUES (?,?,?)', id, now, push.expires),
      this.push(push, now),
      this.audit(now, 'line_test_queued', null, id),
    ]);
  }

  async claimPush(now) {
    const [monthStart, monthEnd] = monthRange(now);
    return this.q(`UPDATE outbox SET state='sending',lease_owner=?,lease_until=?,attempts=attempts+1,
      destination=COALESCE(destination,(SELECT COALESCE(line_user_id,booking_user_id) FROM participants WHERE key=outbox.recipient AND active=1)),
      first_attempt_at=COALESCE(first_attempt_at,?)
      WHERE id=(SELECT o.id FROM outbox o
        WHERE o.state IN ('pending','sending') AND o.next_at<=? AND o.lease_until<=? AND o.expires_at>?
        AND (o.first_attempt_at>? OR (o.first_attempt_at IS NULL AND
          (SELECT COUNT(*) FROM outbox WHERE first_attempt_at>=? AND first_attempt_at<?) < ?))
        AND (o.kind<>'offer' OR (${enabled} AND EXISTS(SELECT 1 FROM cases c WHERE c.id=o.case_id AND c.state='offered' AND c.deadline>?)))
        AND (o.kind NOT IN ('conflict_notice','conflict_notice_review','conflict_review','conflict_cleared') OR
          EXISTS(SELECT 1 FROM meeting_conflicts c JOIN calendar_monitor monitor ON monitor.id=1
            JOIN participants recipient ON recipient.key=o.recipient
            WHERE c.id=o.conflict_id AND monitor.enabled=1
            AND c.state=CASE o.kind WHEN 'conflict_notice' THEN 'pending'
              WHEN 'conflict_cleared' THEN 'cleared' ELSE 'review' END
            AND (o.recipient='teacher' OR c.booking_id IS NULL OR EXISTS(SELECT 1 FROM bookings original
              WHERE original.id=c.booking_id AND original.user_id=COALESCE(recipient.line_user_id,recipient.booking_user_id)))))
        ORDER BY (o.kind='offer'),o.next_at,o.id LIMIT 1) RETURNING *`,
    crypto.randomUUID(), now + leaseTime, now, now, now, now, now - retryWindow, monthStart, monthEnd, pushCap, now).first();
  }

  async finishPush(row, state, reason, now) {
    await this.db.batch([
      this.q(`UPDATE outbox SET state=?,reason=?,lease_owner=NULL,lease_until=0,next_at=?,updated_at=?
        WHERE id=? AND lease_owner=?`, state, reason, now + Math.min(row.attempts * 10, 60) * MINUTE, now, row.id, row.lease_owner),
      this.q('INSERT INTO audit(at,action,case_id,detail) SELECT ?,?,?,? WHERE changes()=1',
        now, 'line_' + state, row.case_id, row.kind + (reason ? ':' + reason : '')),
    ]);
  }

  async sweep(now) {
    await this.db.batch([
      this.q('DELETE FROM webhook_receipts WHERE seen_at<?', now - 30 * DAY),
      this.q(`UPDATE outbox SET state='failed',reason='delivery_deadline',updated_at=?
        WHERE state IN ('pending','sending') AND lease_until<=? AND (expires_at<=? OR first_attempt_at<=?)`,
      now, now, now, now - retryWindow),
      this.q(`UPDATE outbox SET state='skipped',reason='case_inactive',updated_at=?
        WHERE kind='offer' AND state IN ('pending','sending') AND lease_until<=?
        AND NOT EXISTS(SELECT 1 FROM cases WHERE id=outbox.case_id AND state='offered')`, now, now),
    ]);
  }

  async status(now) {
    const [start, end] = monthRange(now);
    const [bindings, cases, delivery, tests, audit, quota, bookings] = await this.db.batch([
      this.q('SELECT key,active,line_user_id IS NOT NULL AS bound FROM participants WHERE booking_user_id IS NULL ORDER BY key'),
      this.q(`SELECT id,student_key,original_start,deadline,state,reason,target_start,target_end,updated_at
        FROM cases ORDER BY state='review' DESC,updated_at DESC LIMIT 40`),
      this.q(`SELECT id,case_id,kind,recipient,state,attempts,reason,updated_at FROM outbox
        WHERE state<>'skipped' ORDER BY state='failed' DESC,updated_at DESC LIMIT 30`),
      this.q('SELECT id,created_at,deadline,confirmed_at FROM line_tests ORDER BY created_at DESC LIMIT 10'),
      this.q('SELECT at,action,case_id,detail FROM audit ORDER BY id DESC LIMIT 45'),
      this.q('SELECT COUNT(*) AS attempted FROM outbox WHERE first_attempt_at>=? AND first_attempt_at<?', start, end),
      this.q(`SELECT id,reschedule_id,participant_key,COALESCE(display_name,line_display_name) AS name,
        state,reason,target_start,target_end,deadline,updated_at FROM bookings
        ORDER BY state='review' DESC,updated_at DESC LIMIT 40`),
    ]);
    return { bindings: bindings.results, cases: cases.results, bookings: bookings.results, delivery: delivery.results, tests: tests.results,
      audit: audit.results, pushBudget: { attempted: quota.results[0].attempted, cap: pushCap } };
  }
}
