/** Lightweight pub/sub so booking/admin mutations can refresh open slot pickers. */
const listeners = new Set();

export function subscribeScheduleUpdated(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitScheduleUpdated() {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // ignore listener errors
    }
  }
}
