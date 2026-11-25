export const ZONE = 'Asia/Taipei';
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const MEETING_LENGTH = 30 * MINUTE;
const utcOffset = 8 * HOUR;
const week = 7 * DAY;
const weekdays = ['日', '一', '二', '三', '四', '五', '六'];

const windows = [
  { weekday: 2, start: '11:00', end: '11:30' },
  { weekday: 2, start: '12:30', end: '13:00' },
  { weekday: 2, start: '13:30', end: '15:30' },
  { weekday: 3, start: '14:00', end: '15:30' },
  { weekday: 4, start: '12:30', end: '13:00' },
  { weekday: 4, start: '13:30', end: '15:30' },
  { weekday: 5, start: '10:30', end: '11:30' },
  { weekday: 5, start: '12:30', end: '13:00' },
  { weekday: 5, start: '13:30', end: '15:30' },
];

function shift(ms) {
  return new Date(ms + utcOffset);
}

export function localTime(ms) {
  return shift(ms).toISOString().slice(11, 16);
}

export function weekday(ms) {
  return shift(ms).getUTCDay();
}

export function localDay(ms) {
  return shift(ms).toISOString().slice(0, 10);
}

function midnight(ms) {
  return Date.parse(localDay(ms) + 'T00:00:00+08:00');
}

export function bookingRange(now) {
  const start = midnight(now) + DAY;
  return { start, end: start + week };
}

function minuteOfDay(hhmm) {
  const [hours, minutes] = hhmm.split(':').map(Number);
  return hours * 60 + minutes;
}

export function dateLabel(ms) {
  const day = localDay(ms).slice(5).replace('-', '/');
  return `${day}（${weekdays[weekday(ms)]}）`;
}

export function label(ms) {
  return dateLabel(ms) + localTime(ms);
}

export function intervalLabel(start, end) {
  return label(start) + '–' + localTime(end);
}

export function iso(ms) {
  return new Date(ms).toISOString();
}

export function monthRange(ms) {
  const date = shift(ms);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  return [Date.UTC(year, month, 1) - utcOffset, Date.UTC(year, month + 1, 1) - utcOffset];
}

export function timeValue(value) {
  if (value?.dateTime) return Date.parse(value.dateTime);
  if (value?.date) return Date.parse(value.date + 'T00:00:00+08:00');
  return NaN;
}

export function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

export function available(slot, intervals) {
  return !intervals.some(interval => overlaps(slot, interval));
}

export function isBackupSlot({ start, end }) {
  if (!Number.isSafeInteger(start) || end !== start + MEETING_LENGTH) return false;
  const day = weekday(start);
  const offset = start - midnight(start);
  return windows.some(window => {
    if (window.weekday !== day) return false;
    const first = minuteOfDay(window.start) * MINUTE;
    const last = minuteOfDay(window.end) * MINUTE;
    return offset >= first && offset + MEETING_LENGTH <= last && (offset - first) % MEETING_LENGTH === 0;
  });
}

function weeklyOptions(monday, earliest, busy, horizon, prioritizeWindows = true) {
  const optionsByWindow = windows.map(window => {
    const day = monday + (window.weekday - 1) * DAY;
    const end = day + minuteOfDay(window.end) * MINUTE;
    const options = [];
    for (let start = day + minuteOfDay(window.start) * MINUTE; start + MEETING_LENGTH <= end; start += MEETING_LENGTH) {
      const slot = { start, end: start + MEETING_LENGTH };
      if (start >= earliest && slot.end <= horizon && available(slot, busy)) options.push(slot);
    }
    return options;
  });
  if (!prioritizeWindows) return optionsByWindow.flat();
  const firstPerWindow = optionsByWindow.flatMap(options => options.slice(0, 1));
  const remaining = optionsByWindow.flatMap(options => options.slice(1));
  return [...firstPerWindow, ...remaining].slice(0, 3).sort((a, b) => a.start - b.start);
}

export function candidateOptions(originalStart, now, busy) {
  const monday = midnight(originalStart) - ((weekday(originalStart) + 6) % 7) * DAY;
  const earliest = now + 2 * HOUR;
  const sameWeek = weeklyOptions(monday, earliest, busy, monday + week);
  return sameWeek.length ? sameWeek : weeklyOptions(monday + week, earliest, busy, monday + 2 * week);
}

export function bookingOptions(earliest, horizon, busy, rescheduling = false) {
  const monday = midnight(earliest) - ((weekday(earliest) + 6) % 7) * DAY;
  const options = [];
  for (let start = monday; start < horizon && (!rescheduling || options.length < 3); start += week) {
    options.push(...weeklyOptions(start, earliest, busy, horizon, rescheduling));
  }
  return rescheduling ? options.slice(0, 3) : options;
}
