import { rules } from '../config.js';

// Everything user-facing runs on Africa/Nairobi time (UTC+3, no daylight saving).
const OFFSET_MS = rules.timezoneOffsetHours * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export function timeToMinutes(value) {
  const [h, m] = String(value).split(':').map(Number);
  return h * 60 + m;
}

export function minutesToLabel(minutes) {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}

// A UTC instant -> its weekday (0 = Sunday) and minutes since midnight in Nairobi.
export function nairobiParts(date) {
  const local = new Date(date.getTime() + OFFSET_MS);
  return {
    dayOfWeek: local.getUTCDay(),
    minutes: local.getUTCHours() * 60 + local.getUTCMinutes(),
    dateString: local.toISOString().slice(0, 10),
  };
}

// "2030-06-15" (a Nairobi calendar date) -> the UTC instant that day starts.
export function nairobiDayStart(dateString) {
  const [y, m, d] = dateString.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - OFFSET_MS);
}

export function dayOfWeekOf(dateString) {
  const [y, m, d] = dateString.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * MINUTE_MS);
}

// slots: [{ day_of_week, start_time, end_time }] as returned by Postgres.
// A session must fit entirely inside one weekly slot.
export function isWithinAvailability(slots, start, durationMinutes) {
  const { dayOfWeek, minutes } = nairobiParts(start);
  const end = minutes + durationMinutes;
  return slots.some(
    (s) =>
      s.day_of_week === dayOfWeek &&
      timeToMinutes(s.start_time) <= minutes &&
      end <= timeToMinutes(s.end_time)
  );
}

// All start times on a Nairobi calendar date that fit the tutor's weekly slots.
export function candidateStarts(slots, dateString, durationMinutes, stepMinutes) {
  const dow = dayOfWeekOf(dateString);
  const dayStart = nairobiDayStart(dateString);
  const out = [];
  for (const s of slots.filter((x) => x.day_of_week === dow)) {
    const from = timeToMinutes(s.start_time);
    const to = timeToMinutes(s.end_time);
    for (let m = from; m + durationMinutes <= to; m += stepMinutes) {
      out.push({ start: addMinutes(dayStart, m), label: minutesToLabel(m) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export function formatNairobi(date) {
  return new Date(date).toLocaleString('en-KE', {
    timeZone: 'Africa/Nairobi',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
