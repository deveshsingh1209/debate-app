import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { SeatAvatar } from './Seat';
import type { Persona, StageFrame } from '../../../shared/types';

/**
 * Pre-session theatre and in-session waiting states.
 *
 * Timing follows a fixed beat sheet in milliseconds,
 * springs with real physics rather than linear fades, and every visual beat
 * paired with an audio cue so the two read as one event.
 */

/* ------------------------------------------------------------------ */
/* Countdown: "debate is about to begin"                               */
/* ------------------------------------------------------------------ */

const BEATS = {
  announce: 0,       // voice: panel assembled
  ringIn: 400,
  count: 1800,       // 3 . 2 . 1
  tickGap: 900,
  handoff: 4600,     // voice: the floor is yours, Marcus
  done: 6400,
} as const;

export function Countdown({
  panelSize,
  motionTitle,
  onDone,
}: {
  panelSize: number;
  motionTitle?: string;
  onDone: () => void;
}) {
  const [n, setN] = useState<number | null>(null);
  const [phase, setPhase] = useState<'announce' | 'count' | 'handoff'>('announce');
  const timers = useRef<number[]>([]);

  /**
   * The dismiss callback is held in a ref, and the beat sheet below runs ONCE
   * per mount, deliberately.
   *
   * It used to depend on `onDone`, which the parent recreates on every render.
   * The war room re-renders on every streamed token, so the effect was being
   * torn down and restarted several times a second: every timer was cleared,
   * including the one that dismisses this overlay at BEATS.done (6.4s). It
   * could never survive long enough to fire, so the countdown stayed pinned
   * over the transcript for the whole session and the voice line restarted on
   * a loop. A fixed performance must not restart because its parent re-rendered.
   */
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const reduced = useReducedMotion();

  useEffect(() => {
    const t = (fn: () => void, ms: number) => timers.current.push(window.setTimeout(fn, ms));

    // Silent on purpose: the first motion opens with the chair's gavel a
    // moment later, and one cue is enough. Under reduced motion there is no
    // count at all, just the line, held long enough to read.
    if (reduced) {
      t(() => doneRef.current(), 1800);
      return () => timers.current.forEach(clearTimeout);
    }

    t(() => setPhase('count'), BEATS.count - 200);
    [3, 2, 1].forEach((v, i) => {
      t(() => setN(v), BEATS.count + i * BEATS.tickGap);
    });

    t(() => {
      setPhase('handoff');
      setN(null);
    }, BEATS.handoff);

    t(() => doneRef.current(), BEATS.done);
    return () => {
      timers.current.forEach(clearTimeout);
    };
    // Mount-only, on purpose. See the note on doneRef above: any dependency
    // here restarts the whole beat sheet and the overlay never lifts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <motion.div className="cine" initial={{ opacity: 1 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      {phase === 'announce' && (
        <motion.div
          className="cine-copy"
          initial={{ opacity: 1, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="label brass">In session</div>
          <div className="cine-line h-display">The debate is about to begin</div>
          <div className="cine-sub">
            {panelSize} expert{panelSize === 1 ? '' : 's'} and the chair
            {motionTitle ? ` · first motion: ${motionTitle}` : ''}
          </div>
        </motion.div>
      )}

      {phase === 'count' && n !== null && (
        <motion.div
          key={n}
          className="cine-count h-display num"
          initial={{ scale: 1.15, opacity: 0.2 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.9, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 26 }}
        >
          {n}
        </motion.div>
      )}

      {phase === 'handoff' && (
        <motion.div
          className="cine-copy"
          initial={{ opacity: 1, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 150, damping: 16 }}
        >
          <div className="label brass">Chair recognised</div>
          <div className="cine-line h-display">The floor is yours, Marcus</div>
          <motion.div
            className="cine-bar"
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: 1.4, ease: 'linear' }}
          />
        </motion.div>
      )}
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Thinking: what this expert is actually weighing                     */
/* ------------------------------------------------------------------ */

/**
 * A generic spinner says "wait". This says who is thinking, through which
 * lens, and what was put to them, so the pause carries information.
 */
export function ThinkingPanel({
  persona,
  direction,
  phase,
}: {
  persona: Persona | undefined;
  direction?: string | null;
  phase: 'thinking' | 'talking' | null;
}) {
  const [lens, setLens] = useState(0);
  const lenses = persona?.expertise?.length ? persona.expertise : ['the evidence'];

  useEffect(() => {
    if (phase !== 'thinking') return;
    const t = setInterval(() => setLens((i) => (i + 1) % lenses.length), 1500);
    return () => clearInterval(t);
  }, [phase, lenses.length]);

  if (!persona || !phase) return null;
  const accent = persona.color;

  return (
    <motion.div
      className="thinkpanel"
      style={{ ['--accent' as string]: accent, ['--pc' as string]: accent }}
      initial={{ opacity: 1, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
    >
      <div className="tp-head">
        <SeatAvatar persona={persona} state={phase === 'talking' ? 'speaking' : 'thinking'} size={32} />
        <div>
          <div className="tp-name">{persona.name}</div>
          <div className="tp-state label">
            {phase === 'talking' ? 'Speaking' : 'Composing a response'}
          </div>
        </div>
        {/* Waveform doubles as the state indicator: agitated while thinking,
            steady while speaking. */}
        <div className={`wave ${phase}`} aria-hidden>
          {Array.from({ length: 7 }, (_, i) => <span key={i} style={{ animationDelay: `${i * 90}ms` }} />)}
        </div>
      </div>

      {phase === 'thinking' && (
        <div className="tp-body">
          <div className="tp-lens">
            <span className="label">Through the lens of</span>
            <motion.span
              key={lens}
              className="tp-lens-v"
              initial={{ opacity: 1, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
            >
              {lenses[lens]}
            </motion.span>
          </div>
          {direction && <div className="tp-q">“{direction}”</div>}
          <div className="tp-scan" aria-hidden />
        </div>
      )}
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Processing bay: the long silences before the room exists            */
/* ------------------------------------------------------------------ */

/**
 * Intake, dossier reading and panel design can each run for minutes with
 * nothing to stream, which reads as a hang. This shows the work: a scanning
 * instrument, a live clock so it is obviously not frozen, and phase-accurate
 * captions that rotate rather than a generic spinner.
 */
const BAY: Record<string, { label: string; head: string; lines: string[] }> = {
  intake: {
    label: 'Intake',
    head: 'Reading your brief',
    lines: [
      'Parsing the topic statement',
      'Testing whether the mission is clear enough to brief a panel',
      'Looking for the decision hiding inside the question',
      'Checking what a useful outcome would look like',
    ],
  },
  dossier: {
    label: 'Dossier',
    head: 'Reading your documents',
    lines: [
      'Opening the uploaded files',
      'Pulling out figures and their sources',
      'Noting decisions already made, and why',
      'Marking constraints that bind the debate',
      'Hunting contradictions worth arguing about',
    ],
  },
  panel_design: {
    label: 'Panel design',
    head: 'Assembling the panel',
    lines: [
      'Mapping which disciplines this problem actually demands',
      'Researching the current state of the domain',
      'Drafting experts with real biases, not agreeable ones',
      'Engineering the friction lines between seats',
    ],
  },
  planning: {
    label: 'Agenda',
    head: 'Drafting the motions',
    lines: [
      'Turning the mission into propositions that can be ruled on',
      'Ordering motions so early rulings inform later ones',
      'Pre-loading research the room will want on the table',
    ],
  },
  reporting: {
    label: 'Report',
    head: 'Writing the report',
    lines: [
      'Tracing every conclusion back to the argument that settled it',
      'Grading the evidence behind each claim',
      'Preserving dissent rather than laundering it away',
      'Building the charts and the decision register',
    ],
  },
};

export function ProcessingBay({ phase, files }: { phase: string; files?: number }) {
  const cfg = BAY[phase];
  const [line, setLine] = useState(0);
  const [secs, setSecs] = useState(0);

  useEffect(() => {
    setLine(0);
    setSecs(0);
  }, [phase]);

  useEffect(() => {
    if (!cfg) return;
    const rot = setInterval(() => setLine((i) => (i + 1) % cfg.lines.length), 3400);
    const clock = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => { clearInterval(rot); clearInterval(clock); };
  }, [cfg]);

  if (!cfg) return null;
  const mins = Math.floor(secs / 60);
  const clock = mins > 0 ? `${mins}m ${String(secs % 60).padStart(2, '0')}s` : `${secs}s`;

  return (
    <motion.div
      className="bay"
      initial={{ opacity: 1, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="bay-scan" aria-hidden>
        <div className="sheets">
          {Array.from({ length: Math.min(files || 3, 6) }, (_, i) => (
            <span key={i} className="sheet">
              {Array.from({ length: 5 }, (_, r) => <i key={r} style={{ width: `${45 + ((i * 13 + r * 29) % 50)}%` }} />)}
            </span>
          ))}
        </div>
        <span className="beam" />
      </div>

      <div className="bay-body">
        <div className="bay-top">
          <span className="label brass">{cfg.label}</span>
          <span className="bay-clock num">{clock}</span>
        </div>
        <div className="bay-head h-display">{cfg.head}</div>
        <motion.div
          key={line}
          className="bay-line"
          initial={{ opacity: 1, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
        >
          {cfg.lines[line]}
          {files ? <span className="bay-files"> · {files} file{files === 1 ? '' : 's'}</span> : null}
        </motion.div>
        <div className="bay-track" aria-hidden><span /></div>
        <div className="bay-note">
          This step is agents genuinely thinking, so it can take a few minutes. The session keeps
          running even if you close this tab.
        </div>
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Stage: what the room is doing when nobody is speaking               */
/* ------------------------------------------------------------------ */

const ACTOR_LABEL: Record<string, string> = {
  marcus: 'The chair',
  chair: 'The chair',
  referee: 'The referee',
  research: 'Research desk',
  panel: 'The panel',
  report: 'Drafting',
  quant: 'Quant desk',
};

/**
 * Most of a motion is not speech. Marcus choosing who speaks next, the referee
 * judging a round, the chair writing a ruling: each is a long agent turn that
 * produces nothing until it lands, and the room used to look dead for the whole
 * of it.
 *
 * This shows who is working, on what, for how long, and — the part that makes
 * it feel alive rather than decorated — their ACTUAL reasoning as it streams.
 * It is not a spinner pretending to be busy; it is the thinking itself.
 */
export function StagePanel({ stage }: { stage: StageFrame | null }) {
  const [secs, setSecs] = useState(0);
  const tailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!stage) return;
    const tick = () => setSecs(Math.max(0, Math.round((Date.now() - stage.since) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [stage?.since, stage]);

  // Follow the reasoning as it arrives.
  useEffect(() => {
    const el = tailRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [stage?.thinking]);

  if (!stage) return null;
  const mins = Math.floor(secs / 60);
  const clock = mins > 0 ? `${mins}m ${String(secs % 60).padStart(2, '0')}s` : `${secs}s`;

  return (
    <motion.div
      className={`stage-panel a-${stage.actor}`}
      initial={{ opacity: 1, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 180, damping: 22 }}
    >
      <div className="sp-head">
        <span className="sp-pulse" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        <span className="sp-actor">{ACTOR_LABEL[stage.actor] ?? stage.actor}</span>
        <span className="sp-clock num">{clock}</span>
      </div>

      <div className="sp-label">{stage.label}</div>
      {stage.detail && <div className="sp-detail">{stage.detail}</div>}

      {stage.thinking ? (
        <div className="sp-think" ref={tailRef}>
          <span className="label">Reasoning, live</span>
          <p>{stage.thinking}</p>
        </div>
      ) : (
        <div className="sp-warmup">
          <span className="label">Working</span>
        </div>
      )}
    </motion.div>
  );
}
