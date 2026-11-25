export const TEACHER = 'teacher';
const idPattern = /^[A-Za-z0-9_.@#+-]{1,254}$/;

export function configuration(env) {
  let profile;
  try {
    profile = JSON.parse(env.MEETING_PROFILE);
  } catch {
    throw new Error('missing_meeting_profile');
  }
  const { calendarId, busyCalendarIds = [], students } = profile ?? {};
  if (typeof calendarId !== 'string' || !idPattern.test(calendarId) || calendarId === 'primary' ||
      !Array.isArray(busyCalendarIds) || busyCalendarIds.length > 20 ||
      busyCalendarIds.some(id => typeof id !== 'string' || !idPattern.test(id) || id === 'primary' || id === calendarId) ||
      !Array.isArray(students) || students.length < 1 || students.length > 12) {
    throw new Error('invalid_meeting_profile');
  }
  const keys = new Set([TEACHER]);
  const series = new Set();
  for (const student of students) {
    const { key, name, seriesId, weekday, start } = student ?? {};
    if (typeof key !== 'string' || !/^[a-z][a-z0-9_-]{0,23}$/.test(key) || keys.has(key) ||
        typeof name !== 'string' || !name.trim() || name.length > 30 ||
        typeof seriesId !== 'string' || !/^[A-Za-z0-9_-]{3,512}$/.test(seriesId) || series.has(seriesId) ||
        !Number.isInteger(weekday) || weekday < 1 || weekday > 5 ||
        typeof start !== 'string' || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(start)) {
      throw new Error('invalid_student_profile');
    }
    keys.add(key);
    series.add(seriesId);
  }
  return { calendarId, busyCalendarIds: [...new Set(busyCalendarIds)], students, keys: [...keys] };
}
