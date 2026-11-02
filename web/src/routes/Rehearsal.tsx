import { useMemo, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { Countdown, ThinkingPanel } from '../components/Cinematic';
import { Transcript } from '../components/Transcript';
import { MotionBar, TokenMeter } from '../components/MotionHud';
import { TableStrip } from '../components/Floor';
import { Roster } from '../components/Roster';
import { RoomSettings } from '../components/RoomSettings';
import { Sound } from '../lib/voice';
import { CUE_SPEC, type Cue } from '../lib/sound-core';
import { initialState, reducer } from '../lib/debate-state';
import type { DebateDetail, DebateEvent, Persona } from '../../../shared/types';
import { emptyUsage } from '../../../shared/types';

/**
 * /rehearsal — the animation and audio bench.
 *
 * Every cue and every state of the room can be looked at here on demand. It
 * runs entirely on local state: no server, no engine, no agent calls, so
 * nothing here can ever consume the owner's Claude quota. The room states are
 * folded through the real reducer from a hand-written event log, so what is
 * shown is exactly what a live debate with those events would show.
 */

const DEMO: Persona = {
  id: 'demo',
  name: 'Mei-Lin Zhou',
  role: 'Supply chain strategist',
  tagline: 'Beautiful prototypes die in tooling.',
  bio: '',
  expertise: ['tooling cost', 'unit economics', 'supplier risk'],
  personality: '',
  biases: '',
  style: '',
  color: '#34d399',
  initials: 'MZ',
};

const P = (id: string, name: string, role: string, color: string, initials: string, isModerator?: boolean): Persona => ({
  id, name, role, color, initials, isModerator, tagline: '', bio: '', expertise: [], personality: '', biases: '', style: '',
});

const CAST = [
  P('marcus', 'Marcus Hale', 'Chair', '#d9b45b', 'MH', true),
  P('sana', 'Dr. Sana Kapoor', 'Nutraceutical scientist', '#22d3ee', 'SK'),
  P('leo', 'Leo Marchetti', 'Industrial designer', '#a3e635', 'LM'),
  P('mei', 'Mei-Lin Zhou', 'Supply chain strategist', '#34d399', 'MZ'),
  P('ravi', 'Ravi Menon', 'D2C growth operator', '#f472b6', 'RM'),
];

/** A hand-written slice of a heated motion: every realism event, in order. */
function roomEvents(now: number): DebateEvent[] {
  let seq = 0;
  const e = (x: object, dt = 0): DebateEvent => ({ seq: ++seq, ts: now - 60_000 + seq * 1000 + dt, ...x }) as DebateEvent;
  const cutText = 'Probiotics survive fine in sachets, and the omega data is clean as long as the sachet is foil-lined. The weekly refill lands inside the margin floor at nineteen dollars landed, which is why';
  return [
    e({ type: 'status', status: 'meeting' }),
    e({ type: 'motion_open', motionId: 'm2', index: 2, total: 4, title: 'Sell the box at cost and make the margin on refills', motion: 'The organizer is sold at or near landed cost; gross margin is carried by the monthly refill.' }),
    e({ type: 'round', round: 3, rung: 3, rungName: 'stress' }),
    e({ type: 'belief', motionId: 'm2', beliefs: [
      { expert: 'sana', motionId: 'm2', stance: 1, confidence: 'medium', crux: '', reasons: [], sinceSeq: 0 },
      { expert: 'leo', motionId: 'm2', stance: -2, confidence: 'high', crux: '', reasons: [], sinceSeq: 0 },
      { expert: 'mei', motionId: 'm2', stance: 2, confidence: 'high', crux: '', reasons: [], sinceSeq: 0 },
      { expert: 'ravi', motionId: 'm2', stance: 1, confidence: 'medium', crux: '', reasons: [], sinceSeq: 0 },
    ] }),
    e({ type: 'message', id: 'r1', speaker: 'marcus', kind: 'marcus', text: 'Leo, you said premium pricing funds the design. Mei says it kills the attach rate. Answer her number.', shape: 'chair' }),
    e({ type: 'message', id: 'r2', speaker: 'leo', kind: 'floor', text: 'Her number assumes the box is a commodity. It is the only object on the counter people see every morning. Price it like a commodity and it gets treated like one.', shape: 'reply' }),
    e({ type: 'message', id: 'r3', speaker: 'ravi', kind: 'reaction', text: 'Seen every morning by whom? On what base?', shape: 'reaction' }),
    e({ type: 'message', id: 'r4', speaker: 'sana', kind: 'floor', text: cutText, shape: 'set_piece', cutOff: { atChar: cutText.length, by: 'mei' } }),
    e({ type: 'message', id: 'r5', speaker: 'mei', kind: 'reaction', text: 'Nineteen landed? On what volume?', shape: 'reaction', overlap: { with: 'r4', fromChar: cutText.length - 38 } }),
    e({ type: 'pause', ms: 2500, reason: 'tension' }),
    e({ type: 'aside', id: 'a1', from: 'ravi', to: 'mei', text: 'If attach comes in under seventy, Leo folds. Watch for it.' }),
    e({ type: 'message', id: 'r6', speaker: 'leo', kind: 'floor', text: 'Fine. If the pilot shows refill attach above seventy percent at cost, I will stop arguing for a premium box. Below that, the object has to pay for itself.', shape: 'reply' }),
    e({ type: 'pause', ms: 2000, reason: 'after_concession' }),
    e({ type: 'concession', concession: { motionId: 'm2', expert: 'leo', from: { stance: -2, confidence: 'high' }, to: { stance: 0, confidence: 'medium' }, kind: 'conditional', movedBy: { kind: 'evidence', who: 'mei' }, cost: 'his premium-object position from the first motion', messageId: 'r6' } }),
    e({ type: 'floor', motionId: 'm2', heat: { sana: 0.42, leo: 0.71, mei: 0.88, ravi: 0.3 }, handsUp: ['ravi'], clock: { elapsedSec: 1384, slotSec: 2700 } }),
    e({ type: 'budget', budget: { profile: 'standard', spentUsd: 9.42, outputTokens: 210_000, flagshipCalls: 71, calls: 120, turns: 58, projectedUsd: 11.6, estimateLowUsd: 6.2, estimateHighUsd: 11.5, billing: 'plan', ceilingUsd: null, state: 'ok' } }),
  ];
}

function useRoomState(withRealism: boolean) {
  return useMemo(() => {
    const now = Date.now() - 120_000; // in the past: renders still, like a reload
    const events = withRealism ? roomEvents(now) : roomEvents(now).filter((e) => ['status', 'motion_open', 'round', 'message'].includes(e.type)).map((e) =>
      e.type === 'message' ? ({ ...e, cutOff: undefined, overlap: undefined, shape: undefined } as DebateEvent) : e);
    const detail: DebateDetail = {
      id: 'rehearsal', title: 'Supplement organizer launch', status: 'meeting',
      config: { provider: 'claude', mode: 'directed', autonomy: 'interactive' },
      createdAt: now - 1_400_000, updatedAt: now, messageCount: 0, topic: '', ownerName: 'Dana', goal: null,
      personas: CAST, plan: { revision: 1, rationale: '', items: [
        { id: 'm1', title: 'Packaging business or habit business', detail: '', status: 'done' },
        { id: 'm2', title: 'Sell the box at cost', detail: '', status: 'active' },
        { id: 'm3', title: 'One sachet size', detail: '', status: 'pending' },
        { id: 'm4', title: 'Pilot design', detail: '', status: 'pending' },
      ] } as DebateDetail['plan'],
      events, pendingQuestion: null, pendingApproval: null, decisions: [], activeMotionId: 'm2',
      hasReport: false, hasPdf: false, hasTranscriptPdf: false, usage: { ...emptyUsage(), costUsd: 9.42 },
    } as DebateDetail;
    let s = reducer(initialState, { type: 'bootstrap', detail });
    // Two people talking at once, live.
    if (withRealism) {
      s = reducer(s, { type: 'frame', frame: { type: 'delta', messageId: 'live1', speaker: 'ravi', kind: 'floor', textDelta: 'The retention gap is the whole pitch. Sixty-eight against forty-one is not a rounding error, it is' } });
      s = reducer(s, { type: 'frame', frame: { type: 'delta', messageId: 'live2', speaker: 'leo', kind: 'reaction', textDelta: 'That is one company and one S-1.' } });
      s = reducer(s, { type: 'frame', frame: { type: 'speaking', speaker: 'ravi', phase: 'talking' } });
    }
    return s;
  }, [withRealism]);
}

export default function Rehearsal() {
  const nav = useNavigate();
  const [cine, setCine] = useState(false);
  const [phase, setPhase] = useState<'thinking' | 'talking' | null>('thinking');
  const [legacy, setLegacy] = useState(false);
  const sound = useSyncExternalStore(Sound.subscribe, () => Sound.settings);
  const room = useRoomState(!legacy);

  return (
    <div className="page-scroll">
      <div className="setup rehearsal">
        <div className="deck-head">
          <h1 className="deck-title">Rehearsal</h1>
          <div className="rh-row">
            <RoomSettings />
            <button className="btn sm" onClick={() => nav('/')}>Back to the deck</button>
          </div>
        </div>

        <p className="gate-lede" style={{ margin: '0 0 18px', maxWidth: '60ch', textAlign: 'left' }}>
          The motion and sound bench. Everything here runs on local state, so no debate is started and no
          model usage is consumed.
        </p>

        <h2 className="rh-h">Sound cues</h2>
        {!sound.enabled && <p className="rail-empty">Sound is off. Turn it on from the sound control above to hear the cues.</p>}
        <div className="rh-grid">
          {(Object.keys(CUE_SPEC) as Cue[]).map((c) => (
            <button key={c} className="rh-cue" disabled={!sound.enabled} onClick={() => Sound.preview(c, c === 'gavel' ? 2 : undefined)}>
              <span className="rh-cue-l">{CUE_SPEC[c].label}{CUE_SPEC[c].key ? '' : ' (all cues)'}</span>
              <span className="rh-cue-n">{CUE_SPEC[c].note}</span>
            </button>
          ))}
        </div>
        <div className="rh-row" style={{ marginTop: 12 }}>
          <button className="btn primary sm" onClick={() => setCine(true)}>Play the opening</button>
        </div>

        <h2 className="rh-h">The room</h2>
        <div className="rh-row" style={{ marginBottom: 12 }}>
          <div className="seg" role="radiogroup" aria-label="Event set">
            <button role="radio" aria-checked={!legacy} className={`seg-opt${!legacy ? ' on' : ''}`} onClick={() => setLegacy(false)}>Realism events</button>
            <button role="radio" aria-checked={legacy} className={`seg-opt${legacy ? ' on' : ''}`} onClick={() => setLegacy(true)}>An old debate</button>
          </div>
        </div>
        <div className="rh-room">
          <div className="rh-room-hud">
            <TokenMeter state={room} />
          </div>
          <div className="rh-room-body">
            <div className="rh-room-rail">
              <Roster state={room} />
            </div>
            <div className="wr-centre rh-room-centre">
              <MotionBar state={room} />
              <TableStrip state={room} />
              <Transcript state={room} dimmed={false} onOpenReport={() => {}} />
            </div>
          </div>
        </div>

        <h2 className="rh-h">Waiting states</h2>
        <div className="rh-row">
          <button className="btn sm" onClick={() => setPhase('thinking')}>Thinking</button>
          <button className="btn sm" onClick={() => setPhase('talking')}>Speaking</button>
          <button className="btn sm ghost" onClick={() => setPhase(null)}>Idle</button>
        </div>
        <div style={{ maxWidth: 620, marginTop: 12 }}>
          <AnimatePresence mode="wait">
            {phase && (
              <ThinkingPanel
                key={phase}
                persona={DEMO}
                phase={phase}
                direction="Mei, you said tooling doubles at 28 cavities. Where does that number come from?"
              />
            )}
          </AnimatePresence>
        </div>
      </div>

      <AnimatePresence>
        {cine && (
          <Countdown key="rehearse" panelSize={5} motionTitle="Frame the business" onDone={() => setCine(false)} />
        )}
      </AnimatePresence>
    </div>
  );
}
