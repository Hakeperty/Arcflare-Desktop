// Keeping replies in order. IPC replies and events can land in any order, so
// an older answer must not replace a newer one on screen.

/**
 * Live state from an event, plus one read for what happened before the
 * subscription. The read is dropped when an event arrived first: each event
 * carries the whole state and is at least as new as the read. Returns the unsubscribe.
 */
export function follow<T>(subscribe: (fn: (x: T) => void) => () => void, read: () => Promise<T | undefined>, apply: (x: T) => void): () => void {
  let seen = false;
  const off = subscribe((x) => { seen = true; apply(x); });
  read().then((x) => { if (!seen && x !== undefined) apply(x); }).catch(() => { /* the events still arrive */ });
  return () => { seen = true; off(); };
}

/** Each call takes a ticket; a ticket is current until the next one is taken. */
export function tickets(): () => () => boolean {
  let n = 0;
  return () => { const mine = ++n; return () => mine === n; };
}
