import { useEffect, useRef, useState } from 'react';
import { motion, useAnimationControls } from 'framer-motion';

const HOLD_MS = 900;

/**
 * Press-and-hold confirmation (END DEBATE).
 *
 * A plain click used to do nothing at all, silently, which reads as a broken
 * button. Now the label says HOLD up front, a short press says so explicitly,
 * and the fill bar shows progress toward the commit.
 */
export function HoldButton({
  label,
  holdLabel,
  onConfirm,
}: {
  label: string;
  holdLabel: string;
  onConfirm: () => void;
}) {
  const controls = useAnimationControls();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nudgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAt = useRef(0);
  const [holding, setHolding] = useState(false);
  const [nudge, setNudge] = useState(false);
  const fired = useRef(false);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (nudgeTimer.current) clearTimeout(nudgeTimer.current);
  }, []);

  const start = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (fired.current) return;
    // Keep receiving events even if the finger slides off the button.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    startedAt.current = Date.now();
    setNudge(false);
    setHolding(true);
    controls.set({ scaleX: 0 });
    void controls.start({ scaleX: 1, transition: { duration: HOLD_MS / 1000, ease: 'linear' } });
    timer.current = setTimeout(() => {
      fired.current = true;
      setHolding(false);
      onConfirm();
      setTimeout(() => { fired.current = false; }, 1500);
    }, HOLD_MS);
  };

  const cancel = () => {
    const held = Date.now() - startedAt.current;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
    void controls.start({ scaleX: 0, transition: { duration: 0.18 } });
    // A real click that was too short: say why nothing happened.
    if (startedAt.current && held < HOLD_MS && !fired.current) {
      setNudge(true);
      if (nudgeTimer.current) clearTimeout(nudgeTimer.current);
      nudgeTimer.current = setTimeout(() => setNudge(false), 2200);
    }
    startedAt.current = 0;
  };

  return (
    <button
      className={`btn sm danger holdbtn ${nudge ? 'nudge' : ''}`}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onConfirm(); } }}
      onContextMenu={(e) => e.preventDefault()}
      title="Press and hold to end the session"
      aria-label={`${label}. Press and hold to confirm.`}
    >
      <motion.span className="hb-fill" animate={controls} initial={{ scaleX: 0 }} />
      <span className="hb-label">
        {holding ? holdLabel : nudge ? 'Hold it down' : label}
      </span>
    </button>
  );
}
