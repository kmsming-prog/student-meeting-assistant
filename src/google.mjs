import { b64url, encodeString } from './security.mjs';
import { iso, timeValue, ZONE } from './time.mjs';

const tokenUrl = 'https://oauth2.googleapis.com/token';
const calendarUrl = 'https://www.googleapis.com/calendar/v3';
const scopes = ['calendar.events', 'calendar.events.freebusy']
  .map(scope => 'https://www.googleapis.com/auth/' + scope).join(' ');
const fields = 'id,etag,status,start,end,originalStartTime,recurringEventId,recurrence,transparency,locked,eventType,attendeesOmitted,attendees(self,responseStatus),extendedProperties(private)';
export const MOVE_MARKER = 'rma_move_id';
export const BOOKING_MARKER = 'rma_booking_id';

export function bookingEventId(bookingId) {
  return 'rma' + bookingId.replaceAll('-', '');
}

export function bookingIdFromEventId(eventId) {
  const parts = /^rma([a-f0-9]{8})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{12})$/.exec(eventId);
  return parts ? parts.slice(1).join('-') : null;
}

export class GoogleError extends Error {
  constructor(operation, status = 0) {
    super('google_' + operation + '_' + status);
    this.status = status;
    this.transient = status === 0 || status === 429 || status >= 500 || status === 412;
  }
}

let cachedCredential;
let cachedToken;
let tokenExpiry = 0;

async function requestJson(fetcher, url, init, operation) {
  try {
    const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(6_000), redirect: 'manual' });
    if (!response.ok) throw new GoogleError(operation, response.status);
    return await response.json();
  } catch (error) {
    if (error instanceof GoogleError) throw error;
    throw new GoogleError(operation);
  }
}

async function serviceToken(credential, fetcher) {
  let key;
  let email;
  try {
    const account = JSON.parse(credential);
    if (account.type !== 'service_account' || !account.client_email.endsWith('.iam.gserviceaccount.com')) throw new Error();
    email = account.client_email;
    const pem = account.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
    const pkcs8 = Uint8Array.from(atob(pem), char => char.charCodeAt(0));
    key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch {
    throw new Error('invalid_google_service_account');
  }
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(encodeString(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = b64url(encodeString(JSON.stringify({
    iss: email, scope: scopes, aud: tokenUrl, iat: now - 5, exp: now + 3_500,
  })));
  const content = header + '.' + claims;
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encodeString(content)));
  const result = await requestJson(fetcher, tokenUrl, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: content + '.' + b64url(signature) }),
  }, 'oauth');
  if (typeof result.access_token !== 'string' || !Number.isFinite(result.expires_in)) throw new GoogleError('oauth');
  return { value: result.access_token, expiry: Date.now() + result.expires_in * 1_000 };
}

async function accessToken(credential, fetcher) {
  if (!credential) throw new Error('missing_google_service_account');
  if (cachedCredential !== credential) {
    cachedCredential = credential;
    cachedToken = undefined;
  }
  if (cachedToken && Date.now() < tokenExpiry - 60_000) return cachedToken;
  // Workers I/O belongs to its request context. Only share completed token values.
  const result = await serviceToken(credential, fetcher);
  if (cachedCredential === credential) {
    cachedToken = result.value;
    tokenExpiry = result.expiry;
  }
  return result.value;
}

export class GoogleCalendar {
  constructor(env, fetcher = fetch) {
    this.credential = env.GOOGLE_SERVICE_ACCOUNT;
    this.fetcher = fetcher;
  }

  async call(path, operation, { method = 'GET', body, etag } = {}) {
    const token = await accessToken(this.credential, this.fetcher);
    const headers = { authorization: 'Bearer ' + token };
    if (body) headers['content-type'] = 'application/json';
    if (etag) headers['if-match'] = etag;
    try {
      return await requestJson(this.fetcher, calendarUrl + path, {
        method, headers, body: body ? JSON.stringify(body) : undefined,
      }, operation);
    } catch (error) {
      if (error.status === 401 && cachedToken === token) cachedToken = undefined;
      throw error;
    }
  }

  async list(calendarId, start, end) {
    const query = new URLSearchParams({
      timeMin: iso(start), timeMax: iso(end), timeZone: ZONE, singleEvents: 'true',
      showDeleted: 'false', maxResults: '250', fields: 'accessRole,nextPageToken,items(' + fields + ')',
    });
    const items = [];
    let accessRole;
    for (let page = 0; page < 8; page++) {
      const data = await this.call('/calendars/' + encodeURIComponent(calendarId) + '/events?' + query, 'list');
      if (!['writerWithoutPrivateAccess', 'writer', 'owner'].includes(data.accessRole)) {
        throw new Error('calendar_requires_writer_access');
      }
      accessRole = data.accessRole;
      items.push(...(data.items ?? []));
      if (!data.nextPageToken) return { items, accessRole };
      query.set('pageToken', data.nextPageToken);
    }
    throw new Error('calendar_page_limit');
  }

  async extraBusy(ids, start, end) {
    if (!ids.length) return [];
    const result = await this.call('/freeBusy', 'freebusy', {
      method: 'POST', body: { timeMin: iso(start), timeMax: iso(end), timeZone: ZONE, items: ids.map(id => ({ id })) },
    });
    return ids.flatMap(id => {
      const calendar = result.calendars?.[id];
      if (!calendar || calendar.errors?.length || !Array.isArray(calendar.busy)) throw new Error('busy_calendar_unavailable');
      return calendar.busy.map(slot => {
        const interval = { start: Date.parse(slot.start), end: Date.parse(slot.end) };
        if (!Number.isFinite(interval.start) || !(interval.end > interval.start)) throw new Error('bad_busy_interval');
        return interval;
      });
    });
  }

  get(calendarId, eventId) {
    const path = '/calendars/' + encodeURIComponent(calendarId) + '/events/' + encodeURIComponent(eventId);
    return this.call(path + '?fields=' + encodeURIComponent(fields), 'get');
  }

  watch(calendarId, id, token, address) {
    const path = '/calendars/' + encodeURIComponent(calendarId) + '/events/watch';
    return this.call(path, 'watch', {
      method: 'POST', body: { id, token, address, type: 'web_hook', params: { ttl: '604800' } },
    });
  }

  async move(calendarId, event, slot, caseId) {
    if (!event.recurringEventId || !event.originalStartTime?.dateTime || event.id === event.recurringEventId ||
        event.recurrence?.length || !event.etag) throw new Error('refused_non_instance');
    return this.patchTime(calendarId, event, slot, caseId);
  }

  async moveBooking(calendarId, event, slot, bookingId, moveId) {
    if (event.id !== bookingEventId(bookingId) || event.recurringEventId || event.recurrence?.length ||
        event.extendedProperties?.private?.[BOOKING_MARKER] !== bookingId || !event.etag) {
      throw new Error('refused_booking_event');
    }
    return this.patchTime(calendarId, event, slot, moveId);
  }

  patchTime(calendarId, event, slot, moveId) {
    const path = '/calendars/' + encodeURIComponent(calendarId) + '/events/' + encodeURIComponent(event.id);
    return this.call(path + '?sendUpdates=none&fields=' + encodeURIComponent(fields), 'patch', {
      method: 'PATCH',
      etag: event.etag,
      body: {
        start: { dateTime: iso(slot.start), timeZone: ZONE },
        end: { dateTime: iso(slot.end), timeZone: ZONE },
        extendedProperties: { private: { ...event.extendedProperties?.private, [MOVE_MARKER]: moveId } },
      },
    });
  }

  createBooking(calendarId, slot, bookingId, summary) {
    const path = '/calendars/' + encodeURIComponent(calendarId) + '/events';
    return this.call(path + '?sendUpdates=none&fields=' + encodeURIComponent(fields), 'insert', {
      method: 'POST',
      body: {
        id: bookingEventId(bookingId),
        summary,
        location: '老師辦公室',
        start: { dateTime: iso(slot.start), timeZone: ZONE },
        end: { dateTime: iso(slot.end), timeZone: ZONE },
        extendedProperties: { private: { [BOOKING_MARKER]: bookingId } },
      },
    });
  }
}

export function busyIntervals(events, excludedId) {
  return events.flatMap(event => {
    if (event.id === excludedId || event.status === 'cancelled' || event.status === 'tentative' ||
        event.transparency === 'transparent' || event.eventType === 'birthday' || event.eventType === 'workingLocation' ||
        event.attendees?.some(attendee => attendee.self &&
          ['declined', 'needsAction', 'tentative'].includes(attendee.responseStatus))) return [];
    const interval = { start: timeValue(event.start), end: timeValue(event.end) };
    if (!Number.isFinite(interval.start) || !(interval.end > interval.start)) throw new Error('bad_calendar_interval');
    return [interval];
  });
}
