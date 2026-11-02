/**
 * The turn trailer (docs/PHASE2-PLAN.md 2c, 2e).
 *
 * A floor turn is prose: the founder watches it stream, every other seat reads
 * it back as speech. What the engine needs to know about a turn that is not
 * speech (where the speaker now stands, how good the evidence behind each
 * claim is, who they put a question to, and whether they want the desk or the
 * research desk) rides out as a block of trailing lines with known keys,
 * stripped before anything else reads the turn:
 *
 *   STANCE: for+1 | confidence: medium | crux: first-cohort churn under 3%
 *   CLAIMS: [observed] eleven pilots ran two to three quarters; [assumed] AI-native buyers move faster
 *   ASK: kabir | Which base is that payback on?
 *   COMPUTE: refunds over gross revenue, Q3, from the sales export
 *   RESEARCH: median days to production for bank AI pilots, 2025
 *
 * This generalises the old one-line `COMPUTE:` desk call. Only a block at the
 * END counts: a line that merely looks like a trailer in the middle of a turn
 * stays speech, so a sentence that happens to start "Claims:" cannot be lost.
 *
 * Pure module: no engine, no I/O, tested in trailer.selftest.ts.
 */
import type { ClaimRecord, Confidence, EvidenceGrade, Stance } from '../../../shared/types.ts';

export const TRAILER_KEYS = ['STANCE', 'CLAIMS', 'ASK', 'COMPUTE', 'RESEARCH'] as const;
export type TrailerKey = (typeof TRAILER_KEYS)[number];

/** Markdown and bullet noise a model puts in front of a key: `**STANCE:**`, `- CLAIMS:`, `> ASK:`. */
const LEAD = /^[\s*_>•-]{0,6}/;
const KEY_LINE = /^[\s*_>•-]{0,6}(STANCE|CLAIMS|ASK|COMPUTE|RESEARCH)\b[\s*_]*:[\s*_]*(.*)$/i;

export interface TrailerStance {
  stance: Stance;
  confidence: Confidence;
  crux: string;
}

export interface Trailer {
  stance?: TrailerStance;
  /** The STANCE line's raw value, for the belief ledger's richer parse (moved / cost / kind). */
  stanceRaw?: string;
  claims?: ClaimRecord[];
  ask?: { to: string; question: string };
  /** A calculation for the quant desk. */
  compute?: string;
  /** A question for the research desk. */
  research?: string;
}

export interface SplitTurn {
  /** The spoken words only. */
  text: string;
  trailer: Trailer;
  /** Which keys were present, in order, including ones whose value did not parse. */
  keys: TrailerKey[];
}

/**
 * A line the trailer continues onto: a wrapped CLAIMS list, which starts with
 * its next grade or a separator. Nothing looser: a lowercase line after a key
 * line is more likely speech that kept going, and speech must never be hidden.
 */
function continuation(line: string): boolean {
  return /^\s*[[;]/.test(line);
}

function strip(v: string): string {
  return v.replace(/^[*_\s]+/, '').replace(/[*_\s]+$/, '').trim();
}

const STANCE_WORD: Record<string, number> = { for: 1, against: -1, neutral: 0, undecided: 0 };

function parseStance(v: string): TrailerStance | undefined {
  const parts = v.split('|').map((p) => p.trim());
  const head = parts[0]?.toLowerCase() ?? '';
  const word = head.match(/\b(for|against|neutral|undecided)\b/)?.[1];
  const digit = head.match(/([+-]?)\s*([0-2])\b/);
  let n: number | null = null;
  if (digit) {
    n = Number(digit[2]) * (digit[1] === '-' ? -1 : 1);
    // "against 2" and "against-2" both mean -2; "for 2" means +2.
    if (word === 'against' && n > 0) n = -n;
  } else if (word) {
    n = STANCE_WORD[word];
  }
  if (n === null || Number.isNaN(n)) return undefined;
  const stance = Math.max(-2, Math.min(2, n)) as Stance;
  let confidence: Confidence = 'medium';
  let crux = '';
  for (const p of parts.slice(1)) {
    const c = p.match(/^confidence\s*[:=]?\s*(low|medium|high)\b/i);
    if (c) { confidence = c[1].toLowerCase() as Confidence; continue; }
    const k = p.match(/^crux\s*[:=]?\s*(.+)$/i);
    if (k) crux = strip(k[1]).slice(0, 300);
  }
  return { stance, confidence, crux };
}

/** "[persona experience]" is how a speaker may well write the persona grade. */
const GRADE = /\[\s*(measured|observed|assumed|mixed|persona)(?:\s+experience)?\s*\]/gi;

function parseClaims(v: string): ClaimRecord[] {
  const out: ClaimRecord[] = [];
  const marks = [...v.matchAll(GRADE)];
  if (!marks.length) {
    // An ungraded claim is graded the honest default: nobody showed it was more than that.
    const text = strip(v).replace(/[;,.\s]+$/, '');
    return text ? [{ text: text.slice(0, 300), grade: 'assumed' }] : [];
  }
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index! + marks[i][0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index! : v.length;
    const text = strip(v.slice(start, end)).replace(/[;,\s]+$/, '');
    if (text) out.push({ text: text.slice(0, 300), grade: marks[i][1].toLowerCase() as EvidenceGrade });
  }
  return out.slice(0, 6);
}

function parseAsk(v: string): { to: string; question: string } | undefined {
  const bar = v.indexOf('|');
  const to = strip(bar >= 0 ? v.slice(0, bar) : v.split(/\s+/)[0] ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const question = strip(bar >= 0 ? v.slice(bar + 1) : v.split(/\s+/).slice(1).join(' '));
  return to && question ? { to: to.slice(0, 16), question: question.slice(0, 300) } : undefined;
}

/** A request the desk can act on: a bare marker or a fragment is not one. */
function request(v: string): string | undefined {
  const q = strip(v);
  return q.length >= 12 ? q.slice(0, 500) : undefined;
}

/**
 * Split a turn into what was said and the trailer after it.
 *
 * Scans up from the bottom over blank lines, key lines and continuation lines
 * (a wrapped CLAIMS value). The trailer starts at the first key line of that
 * run; anything above it, including a trailer-looking line followed by more
 * speech, is speech.
 */
export function splitTrailer(raw: string): SplitTurn {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  let firstKey = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (KEY_LINE.test(line)) { firstKey = i; continue; }
    // Tentatively part of the block; it only counts if a key line sits above it.
    if (continuation(line)) continue;
    break;
  }
  if (firstKey < 0) return { text: raw.trim(), trailer: {}, keys: [] };

  // Group each key line with the continuation lines under it.
  const entries: { key: TrailerKey; value: string }[] = [];
  for (let i = firstKey; i < lines.length; i++) {
    const m = lines[i].match(KEY_LINE);
    if (m) entries.push({ key: m[1].toUpperCase() as TrailerKey, value: m[2] });
    else if (lines[i].trim() && entries.length) entries[entries.length - 1].value += ' ' + lines[i].trim();
  }

  const trailer: Trailer = {};
  for (const { key, value } of entries) {
    if (key === 'STANCE') { const s = parseStance(value); if (s) { trailer.stance = s; trailer.stanceRaw = strip(value); } }
    else if (key === 'CLAIMS') { const c = parseClaims(value); if (c.length) trailer.claims = [...(trailer.claims ?? []), ...c].slice(0, 6); }
    else if (key === 'ASK') { const a = parseAsk(value); if (a) trailer.ask = a; }
    else if (key === 'COMPUTE') { const q = request(value); if (q) trailer.compute = q; }
    else if (key === 'RESEARCH') { const q = request(value); if (q) trailer.research = q; }
  }
  return {
    text: lines.slice(0, firstKey).join('\n').trim(),
    trailer,
    keys: entries.map((e) => e.key),
  };
}

// ---------- the streaming hold-back ----------

/** Could this start of a line still turn into a key line? */
function couldBeKey(partial: string): boolean {
  const t = partial.replace(LEAD, '').toUpperCase();
  if (!t) return true;
  for (const k of TRAILER_KEYS) {
    if (k.startsWith(t)) return true;                         // "STA", "CL"
    if (t.startsWith(k)) {
      const rest = t.slice(k.length);
      if (/^[\s*_]*$/.test(rest)) return true;                // "STANCE", "STANCE **"
      if (/^[\s*_]*:/.test(rest)) return true;                // "STANCE:" — a key line
    }
  }
  return false;
}

/**
 * Hold back anything that could be the trailer while a turn streams, so it
 * never flashes on screen and vanishes (the old `COMPUTE:` line did exactly
 * that). A line is released the moment it cannot be a key line; a key line is
 * held until the turn ends, and released after all if speech follows it.
 *
 * What it emits is always a prefix of the raw text, in order; the published
 * message (spoken text from splitTrailer) replaces the stream either way.
 */
export class TrailerStreamFilter {
  private line = '';
  /** How much of the current line has already been emitted. */
  private sent = 0;
  /** Whole lines held as a possible trailer, newline included. */
  private held = '';

  constructor(private readonly emit: (text: string) => void) {}

  push(chunk: string): void {
    for (const ch of chunk) {
      if (ch === '\n') this.endLine();
      else this.line += ch;
    }
    this.flushPartial();
  }

  private endLine() {
    const line = this.line;
    this.line = '';
    const sent = this.sent;
    this.sent = 0;
    if (sent > 0) {                                           // already known to be speech
      this.emit(line.slice(sent) + '\n');
      return;
    }
    if (!line.trim() || KEY_LINE.test(line) || (this.held && continuation(line))) {
      // Blank lines are only worth holding when a trailer may be forming.
      if (this.held || KEY_LINE.test(line)) this.held += line + '\n';
      else this.emit(line + '\n');
      return;
    }
    this.release();
    this.emit(line + '\n');
  }

  /** Emit as much of the incomplete line as is certainly speech. */
  private flushPartial() {
    if (!this.line) return;
    if (this.sent > 0) {
      if (this.line.length > this.sent) {
        this.emit(this.line.slice(this.sent));
        this.sent = this.line.length;
      }
      return;
    }
    if (couldBeKey(this.line)) return;
    if (this.held && continuation(this.line)) return;
    this.release();
    this.emit(this.line);
    this.sent = this.line.length;
  }

  /** Held lines turned out to be speech after all. */
  private release() {
    if (!this.held) return;
    this.emit(this.held);
    this.held = '';
  }
}
