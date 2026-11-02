import type { CSSProperties } from 'react';
import type { Persona } from '../../../shared/types';

/**
 * A seat at the table: the persona's initials in their own colour, and the
 * state of the person in it.
 *
 *   speaking   a solid ring and a slow breath
 *   thinking   a broken ring turning: composing a reply
 *   irritated  heat at or over IRRITATED: a warm outer ring, warmer as it climbs
 *   hand up    a small dot at the shoulder: wants the floor
 *
 * Every state is in the accessible name too; colour is never the only signal.
 */

/** Between the director's duel threshold (0.5) and the chair stepping in (0.85). */
export const IRRITATED = 0.6;
export const OVERHEATED = 0.85;

export type SeatState = 'speaking' | 'thinking' | null;

export function heatWord(h: number): string {
  if (h >= OVERHEATED) return 'boiling over';
  if (h >= IRRITATED) return 'irritated';
  if (h >= 0.35) return 'warm';
  return 'calm';
}

/** The heat ramp as a CSS colour: cool → warm → hot. */
export function heatColor(h: number): string {
  if (h >= OVERHEATED) return 'var(--heat-hot)';
  if (h >= IRRITATED) return `color-mix(in oklab, var(--heat-hot) ${Math.round(((h - IRRITATED) / (OVERHEATED - IRRITATED)) * 100)}%, var(--heat-warm))`;
  return `color-mix(in oklab, var(--heat-warm) ${Math.round(Math.max(0, h / IRRITATED) * 100)}%, var(--heat-cool))`;
}

export function SeatAvatar({
  persona,
  state,
  heat,
  handUp,
  size = 34,
  showName,
}: {
  persona: Pick<Persona, 'name' | 'initials' | 'color' | 'isModerator'>;
  state: SeatState;
  heat?: number;
  handUp?: boolean;
  size?: number;
  showName?: boolean;
}) {
  const hot = heat !== undefined && heat >= IRRITATED;
  const style = {
    '--pc': persona.color,
    '--seat-size': `${size}px`,
    ...(hot ? { '--seat-heat': heatColor(heat!) } : {}),
  } as CSSProperties;
  const parts = [persona.name];
  if (state === 'speaking') parts.push('speaking');
  if (state === 'thinking') parts.push('composing a reply');
  if (hot) parts.push(heatWord(heat!));
  if (handUp) parts.push('wants the floor');

  return (
    <span
      className={`seat ${state ?? 'idle'}${hot ? ' hot' : ''}${heat !== undefined && heat >= OVERHEATED ? ' boiling' : ''}${handUp ? ' hand' : ''}`}
      style={style}
      role="img"
      aria-label={parts.join(', ')}
      title={parts.join(' · ')}
    >
      <span className="seat-disc" aria-hidden>
        {persona.initials}
      </span>
      <span className="seat-ring" aria-hidden />
      {hot && <span className="seat-heat" aria-hidden />}
      {handUp && <span className="seat-hand" aria-hidden />}
      {showName && <span className="seat-name">{persona.name.split(' ').slice(-1)[0]}</span>}
    </span>
  );
}
