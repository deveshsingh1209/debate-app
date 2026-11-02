import { useEffect, useRef, useState } from 'react';

/**
 * Anti-flash helpers.
 *
 * A screen that appears for 80ms and vanishes reads as a glitch, not a step.
 * The rule here: a transient state is either invisible or held long enough to
 * be read on purpose. Never in between.
 */

/**
 * Gates a loading indicator. Returns true only once `delay` has passed while
 * still loading, and then keeps returning true for at least `hold` so it
 * cannot blink out the instant the data lands.
 *
 *   const showSpinner = useDeferredPending(loading);
 */
export function useDeferredPending(pending: boolean, delay = 260, hold = 480): boolean {
  const [visible, setVisible] = useState(false);
  const shownAt = useRef(0);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    if (pending) {
      // Only admit we are waiting if the wait is long enough to notice.
      t = setTimeout(() => {
        shownAt.current = Date.now();
        setVisible(true);
      }, delay);
    } else if (visible) {
      // Already visible: stay up long enough to have been readable.
      const left = Math.max(0, hold - (Date.now() - shownAt.current));
      t = setTimeout(() => setVisible(false), left);
    }
    return () => clearTimeout(t);
  }, [pending, visible, delay, hold]);

  return visible;
}

/**
 * Holds a value for at least `ms` before allowing it to change, so a state the
 * user is meant to register (a confirmation, a handoff) cannot flicker past.
 */
export function useHeld<T>(value: T, ms = 700): T {
  const [held, setHeld] = useState(value);
  const changedAt = useRef(Date.now());

  useEffect(() => {
    if (value === held) return;
    const elapsed = Date.now() - changedAt.current;
    const wait = Math.max(0, ms - elapsed);
    const t = setTimeout(() => {
      changedAt.current = Date.now();
      setHeld(value);
    }, wait);
    return () => clearTimeout(t);
  }, [value, held, ms]);

  return held;
}
