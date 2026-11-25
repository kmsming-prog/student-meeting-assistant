import { randomCode, sha256, tokenMatches } from './security.mjs';
import { HOUR, MINUTE } from './time.mjs';

export const calendarWebhookPath = '/google/calendar/webhook';

function callbackAddress(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.pathname === calendarWebhookPath &&
        !url.username && !url.password && !url.search && !url.hash) return url.href;
  } catch {
    // The periodic scan can still run without a configured callback.
  }
  return null;
}

export class CalendarWatch {
  constructor({ store, google, calendarId, address, now = Date.now }) {
    this.store = store;
    this.google = google;
    this.calendarId = calendarId;
    this.address = callbackAddress(address);
    this.now = now;
  }

  async renew() {
    if (!this.address) return 'missing_calendar_callback';
    const now = this.now();
    const id = crypto.randomUUID();
    const token = randomCode(32);
    const pending = await this.store.q(`INSERT OR IGNORE INTO calendar_watches
      (id,calendar_id,callback_url,token_hash,expires_at)
      SELECT ?,?,?,?,? WHERE (SELECT enabled FROM calendar_monitor WHERE id=1)=1
      AND NOT EXISTS(SELECT 1 FROM calendar_watches WHERE calendar_id=? AND callback_url=?
        AND (resource_id IS NULL AND expires_at>? OR resource_id IS NOT NULL AND expires_at>?))
      RETURNING id`, id, this.calendarId, this.address, await sha256(token), now + 2 * MINUTE,
    this.calendarId, this.address, now, now + HOUR).first();
    if (!pending) return null;

    try {
      const channel = await this.google.watch(this.calendarId, id, token, this.address);
      const expires = Number(channel.expiration);
      if (channel.id !== id || typeof channel.resourceId !== 'string' || !channel.resourceId ||
          channel.resourceId.length > 512 || !Number.isSafeInteger(expires) || expires <= now) {
        throw new Error('invalid_calendar_watch');
      }
      await this.store.db.batch([
        this.store.q('UPDATE calendar_watches SET resource_id=?,expires_at=? WHERE id=?', channel.resourceId, expires, id),
        this.store.q('UPDATE calendar_monitor SET watch_error=NULL WHERE id=1'),
      ]);
      return null;
    } catch (error) {
      const code = /^(google_watch_\d{1,3}|invalid_calendar_watch)$/.test(error.message) ? error.message : 'calendar_watch_failed';
      await this.store.q('UPDATE calendar_monitor SET watch_error=? WHERE id=1', code).all();
      return code;
    }
  }

  async receive(headers) {
    const id = headers.get('x-goog-channel-id');
    const token = headers.get('x-goog-channel-token');
    const resource = headers.get('x-goog-resource-id');
    const state = headers.get('x-goog-resource-state');
    const number = headers.get('x-goog-message-number');
    if (!/^[a-f0-9-]{36}$/.test(id ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(token ?? '') ||
        !resource || resource.length > 512 || !/^\d{1,32}$/.test(number ?? '') ||
        !['sync', 'exists', 'not_exists'].includes(state)) return null;
    const now = this.now();
    const watch = await this.store.q(`SELECT token_hash,resource_id FROM calendar_watches
      WHERE id=? AND calendar_id=? AND callback_url=? AND expires_at>?`, id, this.calendarId, this.address, now).first();
    if (!watch || (watch.resource_id ? watch.resource_id !== resource : state !== 'sync') ||
        !await tokenMatches(await sha256(token), watch.token_hash)) return null;

    const receipt = 'calendar:' + id + ':' + number;
    const nonce = crypto.randomUUID();
    const recorded = 'EXISTS(SELECT 1 FROM webhook_receipts WHERE id=? AND nonce=?)';
    const changed = state !== 'sync';
    const result = await this.store.db.batch([
      this.store.q('INSERT OR IGNORE INTO webhook_receipts(id,nonce,seen_at) VALUES (?,?,?)', receipt, nonce, now),
      this.store.q(`UPDATE calendar_watches SET sync_at=COALESCE(sync_at,?),last_signal_at=COALESCE(?,last_signal_at)
        WHERE id=? AND ${recorded}`, changed ? null : now, changed ? now : null, id, receipt, nonce),
      this.store.q(`UPDATE calendar_monitor SET requested=requested+1 WHERE id=1 AND enabled=1 AND ?=1 AND ${recorded}`,
      Number(changed), receipt, nonce),
    ]);
    return { scan: result[2].meta.changes > 0 };
  }
}
