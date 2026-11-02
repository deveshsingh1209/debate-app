import type { DebateState } from '../lib/stream';
import { IRRITATED, OVERHEATED, SeatAvatar, heatColor } from './Seat';

/**
 * The table: who is in the room and what state they are in, how hot the room
 * is, and the meeting clock. Fed by the floor director's checkpoints; on a
 * debate from before the director (no `floor` event) it shows the seats and
 * who is speaking, and leaves the tension and the clock out rather than
 * printing a zero that means nothing.
 */

/** The room's tension: the mean of its two hottest seats. A duel heats a room; one angry seat warms it. */
export function roomTension(heat: Record<string, number> | undefined): number | null {
  if (!heat) return null;
  const v = Object.values(heat).filter((n) => Number.isFinite(n)).sort((a, b) => b - a);
  if (!v.length) return null;
  return v.length === 1 ? v[0] : (v[0] + v[1]) / 2;
}

export function tensionWord(t: number): string {
  if (t >= OVERHEATED) return 'Overheated';
  if (t >= IRRITATED) return 'Heated';
  if (t >= 0.35) return 'Tense';
  return 'Calm';
}

export function fmtMeeting(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function TensionMeter({ tension }: { tension: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, tension)) * 100);
  const word = tensionWord(tension);
  return (
    <span className="tension" title={`Room tension ${pct}%: the two hottest seats, averaged`}>
      <span className="tension-k">{word}</span>
      <span
        className="tension-track"
        role="meter"
        aria-label="Room tension"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`${word}, ${pct}%`}
      >
        <span className="tension-fill" style={{ transform: `scaleX(${pct / 100})`, background: heatColor(tension) }} />
        <span className="tension-tick" style={{ left: `${IRRITATED * 100}%` }} aria-hidden />
      </span>
    </span>
  );
}

export function TableStrip({ state }: { state: DebateState }) {
  const floor = state.floor;
  const seats = state.personaOrder.map((id) => state.personas[id]).filter(Boolean);
  if (!seats.length) return null;
  const tension = roomTension(floor?.heat);
  const speakingIds = new Set(state.streams.map((s) => s.speaker));
  if (state.speaking.speaker && state.speaking.phase === 'talking') speakingIds.add(state.speaking.speaker);

  // With nothing but faces to show, the strip is redundant beside the open
  // left rail; CSS hides it there (and only there) by this class.
  const facesOnly = tension === null && !floor && speakingIds.size < 2;

  return (
    <div className={`table-strip${facesOnly ? ' faces-only' : ''}`} aria-label="The table">
      <div className="ts-seats">
        {seats.map((p) => (
          <SeatAvatar
            key={p.id}
            persona={p}
            size={28}
            state={speakingIds.has(p.id) ? 'speaking' : state.speaking.speaker === p.id && state.speaking.phase === 'thinking' ? 'thinking' : null}
            heat={floor?.heat[p.id]}
            handUp={floor?.handsUp.includes(p.id)}
          />
        ))}
      </div>
      {speakingIds.size > 1 && <span className="ts-crosstalk">Talking over each other</span>}
      <span className="ts-spacer" />
      {tension !== null && <TensionMeter tension={tension} />}
      {floor && (
        <span className="ts-clock num" title="Meeting time: the room's own clock, advanced by speech and silence">
          {fmtMeeting(floor.clock.elapsedSec)}
        </span>
      )}
    </div>
  );
}
