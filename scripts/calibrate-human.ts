/**
 * Calibrate the realism metrics against real meetings. No model calls, no network.
 *
 * scripts/transcript-metrics.ts scores a debate against target bands that came
 * from memory and from published per-dialogue-act figures in other units
 * (docs/HUMAN-BASELINES.md). This script reads the AMI and ICSI meeting corpora
 * (annotations only, NXT XML), rebuilds each meeting as the same Turn[] the
 * debate loader produces, and runs the very same computeMetrics() over it. So a
 * human number here is in the script's own units, not converted from them.
 *
 * Inputs: a corpus directory downloaded by hand (see docs/HUMAN-CALIBRATION.md).
 * Corpus data lives OUTSIDE the repo and is never committed.
 *
 *   npx tsx scripts/calibrate-human.ts --corpus ami  --dir ../_corpora/ami
 *   npx tsx scripts/calibrate-human.ts --corpus icsi --dir ../_corpora/icsi/ICSI --json out.json
 *   npx tsx scripts/calibrate-human.ts --corpus ami --dir ... --bands docs/calibration-proposed-bands.json
 *
 * Options:
 *   --json <file>        write per-meeting metrics and distributions as JSON
 *   --min-turns <n>      meetings with fewer expert turns are left out (default 20)
 *   --overlap-min <sec>  how far into another speaker's unit a turn must start to
 *                        count as overlap (default 0.5; 0 and 1.0 are reported too)
 *   --with-backchannels  count backchannel units as turns (default: they are not)
 *   --window <n>         score consecutive windows of n expert turns instead of
 *                        whole meetings (a debate is 20-80 expert turns; a
 *                        meeting is 100-900, and some metrics grow with length)
 *   --bands <file>       also score every meeting against a proposed band file
 *
 * Definitions (each one is also next to its code):
 *   unit         one dialogue act: speaker, start, end, words, DA type.
 *   backchannel  AMI DA `bck`; ICSI general tag `b`. Not a turn by default: the
 *                simulator's turns are contributions, and "mm-hm" is not one.
 *   turn         a maximal run of one speaker's non-backchannel units, taken in
 *                order of start time. Another speaker's backchannel does not end
 *                a turn; another speaker's contribution does.
 *   overlap      a turn whose first unit starts inside another speaker's unit,
 *                at least --overlap-min seconds before that unit ends.
 *   cut off      the turn being overlapped (by any amount), when its speaker
 *                then stops mid-sentence (no terminal . ? ! in the transcript)
 *                while the newcomer is still talking. One per interrupted
 *                turn, like the engine's cutOff (the interrupter is not
 *                counted twice).
 *   chair        AMI scenario meetings: the Project Manager (role PM). ICSI has
 *                no annotated chair, so every speaker is an "expert" there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { bandOf, computeMetrics, REALISM_TARGETS, type DebateInput, type Metrics, type Turn } from './transcript-metrics.ts';

// ---------- NXT XML ----------

/** One element of an NXT words file, in document order. Non-words (vocal sounds, gaps) are kept so ranges resolve. */
export interface Tok {
  id: string;
  text: string;
  start: number;
  end: number;
  /** A spoken word (counts toward length). */
  word: boolean;
  /** Attaches to the previous token with no space (punctuation, "'s", "'re", hyphen halves). */
  glue: boolean;
  /** Joins the next token with no space (a hyphen). */
  glueNext: boolean;
}

const decode = (s: string) =>
  s.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attr = (attrs: string, name: string): string | undefined => {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name.replace(':', '\\:')}="([^"]*)"`));
  return m ? decode(m[1]) : undefined;
};
const num = (s: string | undefined) => (s === undefined || s === '' ? NaN : Number(s));

/** ICSI word classes that are punctuation or symbols, not words. */
const ICSI_PUNCT = new Set(['.', 'CM', 'LQUOTE', 'RQUOTE', 'QUOTE', 'SYM', 'HYPH']);

/**
 * Parse an AMI or ICSI words file. AMI marks punctuation with punc="true";
 * ICSI classes every token with c= (W, CM, ., TRUNCW, APOSS, HYPH, ...).
 * Either way, a token that starts with an apostrophe ("'s", "'re") is a clitic
 * of the word before it, and a hyphen glues its two neighbours ("Mm - hmm").
 */
export function parseWords(xml: string): Tok[] {
  const out: Tok[] = [];
  const re = /<(w|vocalsound|nonvocalsound|disfmarker|gap|comment|pause|transformerror)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
  for (const m of xml.matchAll(re)) {
    const [, tag, attrs, body] = m;
    const id = attr(attrs, 'nite:id');
    if (!id) continue;
    const start = num(attr(attrs, 'starttime'));
    const end = num(attr(attrs, 'endtime'));
    if (tag !== 'w') {
      out.push({ id, text: '', start, end, word: false, glue: false, glueNext: false });
      continue;
    }
    const text = decode((body ?? '').trim());
    const c = attr(attrs, 'c');
    const punct = attr(attrs, 'punc') === 'true' || (c !== undefined && ICSI_PUNCT.has(c)) || (!c && /^[^\p{L}\p{N}]+$/u.test(text));
    const clitic = /^'/.test(text) || c === 'APOSS';
    const hyph = c === 'HYPH' || text === '-';
    out.push({ id, text, start, end, word: !punct && !clitic && !!text, glue: punct || clitic || hyph, glueNext: hyph });
  }
  return out;
}

/** Resolve the nite:child hrefs inside one element ("f.xml#id(a)..id(b)" or "f.xml#id(a)") to tokens. */
function resolveChildren(body: string, toks: Tok[], index: Map<string, number>): Tok[] {
  const out: Tok[] = [];
  for (const m of body.matchAll(/<nite:child\s+href="[^#"]*#id\(([^)]+)\)(?:\.\.id\(([^)]+)\))?"/g)) {
    const a = index.get(m[1]);
    const b = index.get(m[2] ?? m[1]);
    if (a === undefined || b === undefined) continue;
    for (let i = a; i <= b; i++) out.push(toks[i]);
  }
  return out;
}

/** Join tokens into text whose whitespace split is the spoken words, with punctuation attached. */
export function joinText(toks: Tok[]): string {
  let s = '';
  let glueNext = false;
  for (const t of toks) {
    if (!t.text) continue;
    s += !s || t.glue || glueNext ? t.text : ` ${t.text}`;
    glueNext = t.glueNext;
  }
  return s;
}

// ---------- units ----------

export interface Unit {
  speaker: string;
  start: number;
  end: number;
  text: string;
  words: number;
  /** The raw DA label: an AMI type name ('inf', 'bck', 'el.inf') or an ICSI MRDA tag ('s^aa', 'qy^rt', 'b'). */
  da: string;
  backchannel: boolean;
  /** The DA is a question (AMI elicit-*, ICSI q* general tags). */
  question: boolean;
  /** ICSI only: the DA was marked interrupted (%-). */
  interruptedDa: boolean;
}

function timesOf(toks: Tok[]): { start: number; end: number } {
  let start = Infinity, end = -Infinity;
  for (const t of toks) {
    if (Number.isFinite(t.start)) start = Math.min(start, t.start);
    if (Number.isFinite(t.end)) end = Math.max(end, t.end);
    if (Number.isFinite(t.start)) end = Math.max(end, t.start);
  }
  return { start, end };
}

const index = (toks: Tok[]) => new Map(toks.map((t, i) => [t.id, i]));

/** AMI dialog-act file for one speaker. `types` maps da-types.xml ids (ami_da_1) to names (bck). */
export function parseAmiDialogActs(xml: string, toks: Tok[], speaker: string, types: Map<string, string>): Unit[] {
  const idx = index(toks);
  const out: Unit[] = [];
  for (const m of xml.matchAll(/<dact\b[^>]*>([\s\S]*?)<\/dact>/g)) {
    const body = m[1];
    const typeId = body.match(/role="da-aspect"\s+href="[^#"]*#id\(([^)]+)\)"/)?.[1];
    const da = (typeId && types.get(typeId)) || 'unlab';
    const ts = resolveChildren(body, toks, idx);
    const { start, end } = timesOf(ts);
    const words = ts.filter((t) => t.word).length;
    if (!words || !Number.isFinite(start)) continue;
    out.push({ speaker, start, end, text: joinText(ts), words, da, backchannel: da === 'bck', question: da.startsWith('el.'), interruptedDa: false });
  }
  return out;
}

/** AMI da-types.xml: id -> short name. */
export function parseAmiDaTypes(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of xml.matchAll(/<da-type\s+nite:id="([^"]+)"\s+name="([^"]+)"/g)) out.set(m[1], m[2]);
  return out;
}

/**
 * The MRDA general tags of an ICSI label. "fh|s" is two acts in one segment;
 * "s^aa" is general tag s with specific tag aa; ".%-" is a disruption suffix.
 */
export function icsiGeneralTags(label: string): string[] {
  return label.split('|').map((p) => p.split(/[\^.:]/)[0]).filter(Boolean);
}

/** ICSI dialogue-acts file for one speaker. ICSI DAs carry their own times. */
export function parseIcsiDialogActs(xml: string, toks: Tok[], speaker: string): Unit[] {
  const idx = index(toks);
  const out: Unit[] = [];
  for (const m of xml.matchAll(/<dialogueact\b([^>]*)>([\s\S]*?)<\/dialogueact>/g)) {
    const [, attrs, body] = m;
    const da = attr(attrs, 'type') ?? '';
    const ts = resolveChildren(body, toks, idx);
    const words = ts.filter((t) => t.word).length;
    const wt = timesOf(ts);
    const start = Number.isFinite(num(attr(attrs, 'starttime'))) ? num(attr(attrs, 'starttime')) : wt.start;
    const end = Number.isFinite(num(attr(attrs, 'endtime'))) ? num(attr(attrs, 'endtime')) : wt.end;
    if (!words || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    const tags = icsiGeneralTags(da);
    out.push({
      speaker, start, end, text: joinText(ts), words, da,
      backchannel: tags.length > 0 && tags.every((t) => t === 'b'),
      question: tags.some((t) => /^q/.test(t)),
      // "%-" is interrupted; "%--" is abandoned by the speaker, which is not the same thing.
      interruptedDa: /%-(?!-)/.test(da),
    });
  }
  return out;
}

// ---------- turns ----------

export interface HumanTurn {
  speaker: string;
  start: number;
  end: number;
  units: Unit[];
  text: string;
  words: number;
  /** Seconds the first unit ran inside another speaker's unit (0 = clean start). */
  overlapSec: number;
  cutOff: boolean;
}

export interface TurnOptions {
  /** Count backchannel units as turns of their own (default false). */
  withBackchannels?: boolean;
  /** Seconds a turn must start before the other speaker's unit ends to count as overlap (default 0.5). Used by analyseMeeting. */
  overlapMinSec?: number;
}

/**
 * Build turns from units. Units are taken in order of start time; a run of one
 * speaker's units is one turn. Backchannels are skipped unless asked for, so
 * "A ... (B: mm-hm) ... A" stays one turn of A's.
 */
/** A unit the transcriber left without terminal punctuation: the speaker broke off. */
export const incomplete = (text: string) => !/[.?!]["')\]]*\s*$/.test(text.trim());

export function buildTurns(units: Unit[], opts: TurnOptions = {}): HumanTurn[] {
  const core = units.filter((u) => opts.withBackchannels || !u.backchannel).sort((a, b) => a.start - b.start || a.end - b.end);
  const turns: HumanTurn[] = [];
  for (const u of core) {
    const cur = turns[turns.length - 1];
    if (cur && cur.speaker === u.speaker) {
      cur.units.push(u);
      cur.end = Math.max(cur.end, u.end);
    } else {
      turns.push({ speaker: u.speaker, start: u.start, end: u.end, units: [u], text: '', words: 0, overlapSec: 0, cutOff: false });
    }
  }
  for (const t of turns) {
    t.text = t.units.map((u) => u.text).join(' ');
    t.words = t.units.reduce((a, u) => a + u.words, 0);
  }

  // Which turn each unit belongs to, so a cut can be marked on the right turn.
  const turnOf = new Map<Unit, HumanTurn>();
  for (const t of turns) for (const u of t.units) turnOf.set(u, t);
  const pos = new Map(core.map((u, i) => [u, i]));

  for (let ti = 0; ti < turns.length; ti++) {
    const t = turns[ti];
    const first = t.units[0];
    // The other speaker's unit in progress at this onset that runs on longest.
    let over: Unit | null = null;
    for (let i = pos.get(first)! - 1; i >= 0; i--) {
      const u = core[i];
      if (u.start < first.start - 600) break;
      if (u.speaker === t.speaker || u.start >= first.start) continue;
      if (u.end > first.start && (!over || u.end > over.end)) over = u;
    }
    if (!over) continue;
    t.overlapSec = Math.min(over.end, first.end) - first.start;
    if (t.overlapSec <= 0) continue;
    // Cut off: the overlapped speaker stops mid-sentence before the newcomer is
    // done. "Mid-sentence" is the transcriber's call: both corpora end a
    // finished unit with . ? or ! Any overlap counts here, not --overlap-min:
    // checked against ICSI's hand-coded interrupted acts (%-), this rule gives
    // the same rate (11.2 vs 10.9 per 100 turns) at precision and recall ~0.5,
    // and stricter thresholds undercount (docs/HUMAN-CALIBRATION.md).
    const victim = turnOf.get(over);
    if (!victim || victim.cutOff || over.end >= t.end || !incomplete(over.text)) continue;
    victim.cutOff = true;
  }
  return turns;
}

// ---------- meetings ----------

export interface Meeting {
  id: string;
  corpus: 'ami' | 'icsi';
  /** e.g. 'scenario' / 'non-scenario' for AMI, the series (Bed, Bmr, Bro, ...) for ICSI. */
  kind: string;
  units: Unit[];
  /** Speaker letter of the chair, if the corpus marks one. */
  chair: string | null;
}

export interface Extras {
  speakers: number;
  durationMin: number;
  units: number;
  /** Backchannel units by anyone, per 100 expert turns. */
  backchannelPer100: number;
  /** Backchannels as a share of all units. */
  backchannelUnitShare: number;
  /** Expert turns that contain a question-type DA (the '?' count is computeMetrics' questionShare). */
  daQuestionShare: number;
  /** Overlap per 100 expert turns at 0 s (any), 0.5 s and 1 s into the other speaker's unit. */
  overlapAnyPer100: number;
  overlap05Per100: number;
  overlap1Per100: number;
  /** ICSI only: expert turns ending on a DA labelled interrupted (%-), per 100. Null elsewhere. */
  interruptedDaPer100: number | null;
  /** Largest single speaker's share of all words (chair included). A leader proxy where no chair is marked. */
  topSpeakerWordShare: number;
  /** Expert turns per minute of meeting. */
  turnsPerMin: number;
}

export interface MeetingResult {
  id: string;
  corpus: string;
  kind: string;
  metrics: Metrics;
  extras: Extras;
  /** Expert turn word counts, for the pooled distribution. */
  wordCounts: number[];
}

const CHAIR_SENTINEL = 'Zzchairzz'; // speakers are anonymised: no names to address

/** Turn a meeting into the DebateInput that transcript-metrics.ts scores. */
export function toDebateInput(m: Meeting, turns: HumanTurn[], overlapMinSec = 0.5): DebateInput {
  const t: Turn[] = turns.map((x) => ({
    speaker: x.speaker,
    name: x.speaker,
    kind: x.speaker === m.chair ? 'marcus' : 'floor',
    text: x.text,
    cutOff: x.cutOff,
    overlap: x.overlapSec >= overlapMinSec && x.overlapSec > 0,
  }));
  return { id: m.id, title: m.id, turns: t, firstNames: [], chairFirstName: CHAIR_SENTINEL, founderFirstName: null, guards: null };
}

const r = (x: number, p = 3) => Math.round(x * 10 ** p) / 10 ** p;

/** Score a whole meeting. */
export function analyseMeeting(m: Meeting, opts: TurnOptions = {}): MeetingResult {
  return analyseTurns(m, m.id, buildTurns(m.units, opts), m.units, opts);
}

/**
 * Score a meeting in consecutive windows of `size` expert turns, dropping the
 * short remainder. Several metrics grow with length (a 3-word opener shared by
 * 3+ turns, recycled 4-grams, Gini over who happened to speak), and a human
 * meeting runs 100-900 expert turns against a debate's 20-80, so the windowed
 * figures are the like-for-like ones. Turns are built over the whole meeting
 * first, so overlap and cut-offs at a window's edge keep their context.
 */
export function analyseWindows(m: Meeting, size: number, opts: TurnOptions = {}): MeetingResult[] {
  const turns = buildTurns(m.units, opts);
  const out: MeetingResult[] = [];
  let from = 0, experts = 0;
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].speaker !== m.chair) experts++;
    if (experts < size) continue;
    const slice = turns.slice(from, i + 1);
    const lo = slice[0].start;
    const hi = i + 1 < turns.length ? turns[i + 1].start : Infinity;
    out.push(analyseTurns(m, `${m.id}#${out.length}`, slice, m.units.filter((u) => u.start >= lo && u.start < hi), opts));
    from = i + 1;
    experts = 0;
  }
  return out;
}

function analyseTurns(m: Meeting, id: string, turns: HumanTurn[], units: Unit[], opts: TurnOptions): MeetingResult {
  const minOv = opts.overlapMinSec ?? 0.5;
  const metrics = computeMetrics(toDebateInput({ ...m, id }, turns, minOv));
  const expert = turns.filter((t) => t.speaker !== m.chair);
  const n = expert.length;
  const per100 = (k: number) => (n ? r((100 * k) / n, 1) : 0);
  const words = new Map<string, number>();
  for (const u of units) words.set(u.speaker, (words.get(u.speaker) ?? 0) + u.words);
  const totalWords = [...words.values()].reduce((a, b) => a + b, 0);
  let start = Infinity, end = -Infinity;
  for (const u of units) { start = Math.min(start, u.start); end = Math.max(end, u.end); }
  const durationMin = units.length ? (end - start) / 60 : 0;
  const bc = units.filter((u) => u.backchannel).length;
  const extras: Extras = {
    speakers: words.size,
    durationMin: r(durationMin, 1),
    units: units.length,
    backchannelPer100: per100(bc),
    backchannelUnitShare: units.length ? r(bc / units.length) : 0,
    daQuestionShare: n ? r(expert.filter((t) => t.units.some((u) => u.question)).length / n) : 0,
    overlapAnyPer100: per100(expert.filter((t) => t.overlapSec > 0).length),
    overlap05Per100: per100(expert.filter((t) => t.overlapSec >= 0.5).length),
    overlap1Per100: per100(expert.filter((t) => t.overlapSec >= 1).length),
    interruptedDaPer100: m.corpus === 'icsi' ? per100(expert.filter((t) => t.units[t.units.length - 1].interruptedDa).length) : null,
    topSpeakerWordShare: totalWords ? r(Math.max(...words.values()) / totalWords) : 0,
    turnsPerMin: durationMin > 0 ? r(n / durationMin, 2) : 0,
  };
  return { id, corpus: m.corpus, kind: m.kind, metrics, extras, wordCounts: expert.map((t) => t.words) };
}

// ---------- corpus loaders ----------

const read = (f: string) => fs.readFileSync(f, 'latin1');

/** AMI: every meeting with dialogue acts (139 of 171 in release 1.6.2). The PM is the chair. */
export function loadAmi(dir: string): Meeting[] {
  const types = parseAmiDaTypes(read(path.join(dir, 'ontologies', 'da-types.xml')));
  const meta = read(path.join(dir, 'corpusResources', 'meetings.xml'));
  const info = new Map<string, { kind: string; chair: string | null }>();
  for (const mm of meta.matchAll(/<meeting\b([^>]*)>([\s\S]*?)<\/meeting>/g)) {
    const obs = attr(mm[1], 'observation');
    if (!obs) continue;
    let chair: string | null = null;
    for (const s of mm[2].matchAll(/<speaker\b([^>]*)\/>/g)) if (attr(s[1], 'role') === 'PM') chair = attr(s[1], 'nxt_agent') ?? null;
    info.set(obs, { kind: attr(mm[1], 'type') ?? 'unknown', chair });
  }
  const daDir = path.join(dir, 'dialogueActs');
  const byMeeting = new Map<string, string[]>();
  for (const f of fs.readdirSync(daDir).filter((f) => f.endsWith('.dialog-act.xml')).sort()) {
    const [id, spk] = f.split('.');
    byMeeting.set(id, [...(byMeeting.get(id) ?? []), spk]);
  }
  return [...byMeeting.entries()].map(([id, spks]) => {
    const units = spks.flatMap((spk) => {
      const toks = parseWords(read(path.join(dir, 'words', `${id}.${spk}.words.xml`)));
      return parseAmiDialogActs(read(path.join(daDir, `${id}.${spk}.dialog-act.xml`)), toks, spk, types);
    });
    const i = info.get(id);
    return { id, corpus: 'ami' as const, kind: i?.kind ?? 'unknown', units, chair: i?.chair ?? null };
  });
}

/** ICSI: all 75 meetings carry MRDA dialogue acts. No chair is annotated. */
export function loadIcsi(dir: string): Meeting[] {
  const daDir = path.join(dir, 'DialogueActs');
  const byMeeting = new Map<string, string[]>();
  for (const f of fs.readdirSync(daDir).filter((f) => f.endsWith('.dialogue-acts.xml')).sort()) {
    const [id, spk] = f.split('.');
    byMeeting.set(id, [...(byMeeting.get(id) ?? []), spk]);
  }
  return [...byMeeting.entries()].map(([id, spks]) => {
    const units = spks.flatMap((spk) => {
      const toks = parseWords(read(path.join(dir, 'Words', `${id}.${spk}.words.xml`)));
      return parseIcsiDialogActs(read(path.join(daDir, `${id}.${spk}.dialogue-acts.xml`)), toks, spk);
    });
    return { id, corpus: 'icsi' as const, kind: id.slice(0, 3), units, chair: null };
  });
}

// ---------- distributions ----------

export interface Dist { n: number; p10: number; q1: number; median: number; q3: number; p90: number; iqr: number; mean: number }

export function dist(xs: number[]): Dist {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  const q = (p: number) => {
    if (!v.length) return 0;
    const pos = (v.length - 1) * p;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return v[lo] + (v[hi] - v[lo]) * (pos - lo);
  };
  const mean = v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  return { n: v.length, p10: r(q(0.1)), q1: r(q(0.25)), median: r(q(0.5)), q3: r(q(0.75)), p90: r(q(0.9)), iqr: r(q(0.75) - q(0.25)), mean: r(mean) };
}

/** The per-meeting values that are calibrated. Keys match REALISM_TARGETS where a target exists. */
export const CALIBRATED: { key: string; get: (x: MeetingResult) => number | null }[] = [
  { key: 'wordsMean', get: (x) => x.metrics.words.mean },
  { key: 'wordsCv', get: (x) => x.metrics.words.cv },
  { key: 'wordsP10', get: (x) => x.metrics.words.p10 },
  { key: 'wordsP50', get: (x) => x.metrics.words.p50 },
  { key: 'wordsP90', get: (x) => x.metrics.words.p90 },
  { key: 'shortTurnShare', get: (x) => x.metrics.shortTurnShare },
  { key: 'memoTurnShare', get: (x) => x.metrics.memoTurnShare },
  { key: 'interruptionRate', get: (x) => x.metrics.interruptionRate },
  { key: 'overlapRate', get: (x) => x.metrics.overlapRate },
  { key: 'overlapAnyPer100', get: (x) => x.extras.overlapAnyPer100 },
  { key: 'overlap1Per100', get: (x) => x.extras.overlap1Per100 },
  { key: 'interruptedDaPer100', get: (x) => x.extras.interruptedDaPer100 },
  { key: 'pingPongRate', get: (x) => x.metrics.pingPongRate },
  { key: 'questionShare', get: (x) => x.metrics.questionShare },
  { key: 'daQuestionShare', get: (x) => x.extras.daQuestionShare },
  { key: 'concessionPer100', get: (x) => x.metrics.concessionPer100 },
  { key: 'positionChangePer100', get: (x) => x.metrics.positionChangePer100 },
  { key: 'fillerTurnShare', get: (x) => x.metrics.fillerTurnShare },
  { key: 'summaryEndingShare', get: (x) => x.metrics.summaryEndingShare },
  { key: 'openerRepeatShare', get: (x) => x.metrics.openerRepeatShare },
  { key: 'recycled4gramShare', get: (x) => x.metrics.recycled4gramShare },
  { key: 'giniTurns', get: (x) => x.metrics.giniTurns },
  { key: 'giniWords', get: (x) => x.metrics.giniWords },
  { key: 'chairWordShare', get: (x) => (x.metrics.chairTurns ? x.metrics.chairWordShare : null) },
  { key: 'topSpeakerWordShare', get: (x) => x.extras.topSpeakerWordShare },
  { key: 'backchannelPer100', get: (x) => x.extras.backchannelPer100 },
  { key: 'backchannelUnitShare', get: (x) => x.extras.backchannelUnitShare },
  { key: 'experts', get: (x) => x.metrics.experts },
  { key: 'expertTurns', get: (x) => x.metrics.expertTurns },
  { key: 'turnsPerMin', get: (x) => x.extras.turnsPerMin },
  { key: 'realismIndex', get: (x) => x.metrics.realismIndex },
];

export function summarise(results: MeetingResult[]) {
  const perMeeting: Record<string, Dist> = {};
  for (const c of CALIBRATED) {
    const xs = results.map(c.get).filter((v): v is number => v !== null);
    if (xs.length) perMeeting[c.key] = dist(xs);
  }
  // Turn lengths pooled over every expert turn of every meeting.
  const all = results.flatMap((x) => x.wordCounts);
  const d = dist(all);
  const sd = all.length > 1 ? Math.sqrt(all.reduce((a, b) => a + (b - d.mean) ** 2, 0) / (all.length - 1)) : 0;
  const pooledTurns = {
    turns: all.length,
    ...d,
    cv: d.mean ? r(sd / d.mean) : 0,
    shortTurnShare: all.length ? r(all.filter((x) => x < 40).length / all.length) : 0,
    memoTurnShare: all.length ? r(all.filter((x) => x > 150).length / all.length) : 0,
  };
  // How a human meeting scores on each part of the current index.
  const parts: Record<string, Dist> = {};
  for (const t of REALISM_TARGETS) parts[t.key] = dist(results.map((x) => x.metrics.realismParts[t.key] ?? 0));
  return { meetings: results.length, perMeeting, pooledTurns, currentIndexParts: parts };
}

// ---------- proposed bands ----------

export interface BandFile { bands: Record<string, { lo: number | null; hi: number | null; scale?: number; weight?: number }> }

/**
 * Score a meeting against a proposed band file, with the same arithmetic as
 * realismIndex(). Keys missing from the file keep the current band. A null
 * bound is open (-Infinity / Infinity). This does NOT touch REALISM_TARGETS.
 */
export function scoreWithBands(m: Metrics, file: BandFile): number {
  let sum = 0, weights = 0;
  for (const t of REALISM_TARGETS) {
    const b = file.bands[t.key];
    const cur = bandOf(t, m);
    const lo = b ? b.lo ?? -Infinity : cur.lo;
    const hi = b ? b.hi ?? Infinity : cur.hi;
    const scale = b?.scale ?? t.scale;
    const weight = b?.weight ?? t.weight;
    const v = t.get(m);
    const d = v < lo ? lo - v : v > hi ? v - hi : 0;
    sum += Math.max(0, 1 - d / scale) * weight;
    weights += weight;
  }
  return Math.round((1000 * sum) / weights) / 10;
}

// ---------- CLI ----------

function main() {
  const args = process.argv.slice(2);
  const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  const corpus = val('--corpus');
  const dir = val('--dir');
  if ((corpus !== 'ami' && corpus !== 'icsi') || !dir) {
    console.error('Usage: tsx scripts/calibrate-human.ts --corpus ami|icsi --dir <corpus dir> [--json out.json] [--bands file] [--min-turns 20] [--overlap-min 0.5] [--with-backchannels]');
    process.exit(2);
  }
  const opts: TurnOptions = { withBackchannels: args.includes('--with-backchannels'), overlapMinSec: Number(val('--overlap-min') ?? 0.5) };
  const minTurns = Number(val('--min-turns') ?? 20);
  const window = val('--window') ? Number(val('--window')) : null;
  const meetings = corpus === 'ami' ? loadAmi(dir) : loadIcsi(dir);
  const all = window ? meetings.flatMap((m) => analyseWindows(m, window, opts)) : meetings.map((m) => analyseMeeting(m, opts));
  const kept = all.filter((x) => x.metrics.expertTurns >= minTurns);
  const bandsFile = val('--bands');
  const bands = bandsFile ? (JSON.parse(fs.readFileSync(bandsFile, 'utf8')) as BandFile) : null;
  const summary = summarise(kept);
  const proposedIndex = bands ? dist(kept.map((x) => scoreWithBands(x.metrics, bands))) : null;

  const out = {
    corpus, options: { ...opts, minTurns, window }, meetings: meetings.length, samplesScored: all.length, samplesKept: kept.length,
    kinds: Object.fromEntries([...new Set(kept.map((x) => x.kind))].map((k) => [k, kept.filter((x) => x.kind === k).length])),
    summary, proposedIndex,
    perMeeting: kept.map((x) => ({ id: x.id, kind: x.kind, extras: x.extras, metrics: { ...x.metrics, title: undefined, topOpeners: undefined, topRepeated4grams: undefined } })),
  };
  const jsonOut = val('--json');
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(out, null, 2));

  const unit = window ? `windows of ${window} expert turns from ${meetings.length} meetings` : 'meetings';
  console.log(`## ${corpus.toUpperCase()}: ${kept.length} ${unit} kept of ${all.length} (>= ${minTurns} expert turns; overlap >= ${opts.overlapMinSec}s; backchannels ${opts.withBackchannels ? 'as turns' : 'excluded'})\n`);
  console.log('| metric | n | p10 | q1 | median | q3 | p90 |\n|---|---|---|---|---|---|---|');
  for (const [k, d] of Object.entries(summary.perMeeting)) console.log(`| ${k} | ${d.n} | ${d.p10} | ${d.q1} | ${d.median} | ${d.q3} | ${d.p90} |`);
  const p = summary.pooledTurns;
  console.log(`\nPooled turns: ${p.turns}; words mean ${p.mean}, cv ${p.cv}, p10 ${p.p10}, median ${p.median}, p90 ${p.p90}; <40 words ${p.shortTurnShare}; >150 words ${p.memoTurnShare}`);
  console.log('\n| current index part | p10 | median | p90 |\n|---|---|---|---|');
  for (const [k, d] of Object.entries(summary.currentIndexParts)) console.log(`| ${k} | ${d.p10} | ${d.median} | ${d.p90} |`);
  if (proposedIndex) console.log(`\nIndex under ${bandsFile}: p10 ${proposedIndex.p10}, median ${proposedIndex.median}, p90 ${proposedIndex.p90}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename ?? '')) main();
