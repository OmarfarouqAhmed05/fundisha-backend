// The booking lifecycle as a state machine.
//   pending   -> confirmed | declined (tutor), cancelled (student)
//   confirmed -> completed (tutor, after the session ends), cancelled (either party)
//   declined, cancelled, completed are final.
export const TRANSITIONS = {
  pending: { confirmed: 'tutor', declined: 'tutor', cancelled: 'student' },
  confirmed: { completed: 'tutor', cancelled: 'either' },
  declined: {},
  cancelled: {},
  completed: {},
};

export function allowedNext(status) {
  return Object.keys(TRANSITIONS[status] || {});
}

export function whoMayMove(from, to) {
  return TRANSITIONS[from]?.[to] || null; // 'tutor' | 'student' | 'either' | null
}

export function priceFor(hourlyRateKes, durationMinutes) {
  return Math.max(1, Math.round((hourlyRateKes * durationMinutes) / 60));
}
