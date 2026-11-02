/**
 * The repetition guard: does a spoken turn add anything the room has not
 * already said? Cheap, deterministic, no model.
 *
 * A turn is broken into overlapping word n-grams ("shingles"); its novelty is
 * the share of them that appear nowhere earlier in the motion. A turn that
 * restates a colleague's case in the same words scores near 0; a turn that
 * brings a new number, mechanism or objection scores well above the line even
 * when it quotes what it answers. WASTE.staleTurnsToClose repeating turns in a
 * row is a stalemate: recorded and ruled, never argued for another round.
 *
 * Thresholds live in shared/budget.ts WASTE.
 */
import { WASTE } from '../../../shared/budget.ts';

const words = (text: string): string[] =>
  text.toLowerCase().replace(/[*_`>#]/g, ' ').match(/[\p{L}\p{N}$%.,']+/gu)?.map((w) => w.replace(/^[.,']+|[.,']+$/g, '')).filter(Boolean) ?? [];

function shingles(ws: string[], n = WASTE.shingle): Set<string> {
  const out = new Set<string>();
  if (ws.length < n) { if (ws.length) out.add(ws.join(' ')); return out; }
  for (let i = 0; i + n <= ws.length; i++) out.add(ws.slice(i, i + n).join(' '));
  return out;
}

/** What the motion has said so far, in a form a new turn can be checked against. */
export class NoveltyLedger {
  private seen = new Set<string>();

  constructor(prior: string[] = []) {
    for (const t of prior) this.add(t);
  }

  add(text: string) {
    for (const s of shingles(words(text))) this.seen.add(s);
  }

  /**
   * Share of this turn's n-grams never said before in the motion, 0..1, or
   * null when the turn is too short to judge (a one-line reaction).
   */
  novelty(text: string): number | null {
    const ws = words(text);
    if (ws.length < WASTE.minWords) return null;
    const sh = shingles(ws);
    let fresh = 0;
    for (const s of sh) if (!this.seen.has(s)) fresh++;
    return sh.size ? fresh / sh.size : 0;
  }

  /** Check a turn, then remember it. True when it repeats the room. */
  stale(text: string): boolean | null {
    const n = this.novelty(text);
    this.add(text);
    return n === null ? null : n < WASTE.minNovelty;
  }
}

/**
 * Carry the run of repeating turns across a round. A turn too short to judge
 * leaves the run where it was; a turn with something new resets it.
 */
export function staleRun(previous: number, turns: string[], ledger: NoveltyLedger): number {
  let run = previous;
  for (const t of turns) {
    const s = ledger.stale(t);
    if (s === true) run++;
    else if (s === false) run = 0;
  }
  return run;
}
