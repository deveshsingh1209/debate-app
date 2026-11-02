/**
 * Evidence honesty (docs/PROGRESS.md P1).
 *
 * The experts are invented characters. In the 2026-10-28 real run they tagged
 * their own backstory as observed fact ("[observed] My head baker quit after
 * eight weeks of covering Sunday bakes", "[observed] my busiest Bristol counter
 * never sees anywhere near 360 Saturday asks"), and the referee, the ruling and
 * the report then treated those lines as evidence about the founder's bakery.
 * A fictional person's memory is not evidence about anyone's business.
 *
 * So the grades mean:
 *   measured  the quant desk computed it from the founder's files
 *   observed  a fact the founder supplied (brief, answers, uploads) or a
 *             research finding cited by id
 *   persona   a panelist's own career or backstory: illustrative only
 *   assumed   reasoning, benchmarks, judgement
 *
 * The prompts ask for that, and this module checks it, deterministically,
 * because a speaker's own grade is the thing that failed:
 *   - `regradeClaims` regrades an `observed` claim that cannot be traced to the
 *     founder's input or a known citation id (persona if it is the speaker's
 *     own story, assumed otherwise), and a `measured` claim in a session where
 *     nothing was computed;
 *   - `anecdotes` finds first-person anecdote spoken as fact, for the lint;
 *   - `personaClaims` and `labelPersonaDerived` carry the persona grade into
 *     the report: the decision trails and the numbers audit print a figure
 *     that came from a panelist's backstory as an assumption.
 *
 * Pure: no engine, no I/O. Tested in evidence.selftest.ts with fixtures from
 * the real transcript.
 */
import type { ClaimRecord, EvidenceGrade } from '../../../shared/types.ts';
import type { ReportData } from '../../../shared/report-types.ts';

// ---------- what counts as a trace ----------

/** What the server knows came from outside the panel's imagination. */
export interface Provenance {
  /** Everything the founder supplied himself: the brief, his answers, the dossier brief of his uploads. */
  founder: string[];
  /** Citation ids the research desk actually returned this session. */
  citations: Iterable<string>;
  /** Whether the quant desk computed anything this session. */
  measured: boolean;
  /** The experts' names (full or first), so "Marisol's shop" reads as a panelist's story. */
  panel: string[];
  /** Claims already graded persona this session: a colleague repeating one is still repeating a story. */
  personaSoFar?: string[];
}

const STOP = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'but', 'not', 'that', 'this', 'with', 'from', 'into', 'than', 'then',
  'they', 'them', 'their', 'there', 'have', 'has', 'had', 'its', 'any', 'all', 'can', 'could', 'would', 'should',
  'will', 'about', 'around', 'only', 'also', 'just', 'more', 'most', 'less', 'very', 'much', 'many', 'what', 'which',
  'who', 'whom', 'when', 'where', 'why', 'how', 'each', 'per', 'out', 'over', 'under', 'off', 'does', 'did', 'doe',
  'been', 'being', 'his', 'her', 'she', 'him', 'one', 'our', 'your', 'you', 'yet', 'still', 'even', 'like', 'some',
  'such', 'own', 'same', 'other', 'another', 'because', 'before', 'after', 'while', 'already', 'roughly', 'typically',
  'nearly', 'near', 'anywhere', 'never', 'always', 'every', 'least', 'week', 'day', 'year', 'month',
]);

const NUM_WORDS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17',
  eighteen: '18', nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50', sixty: '60', seventy: '70',
  eighty: '80', ninety: '90', hundred: '100', thousand: '1000', grand: '1000',
};

function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** Lowercased word tokens, number words as digits, "£1,070" as "1070", "4am" kept whole. */
export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/(\d),(\d{3})\b/g, '$1$2')
    .replace(/'s\b/g, '')
    .split(/[^a-z0-9.%]+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ''))
    .filter(Boolean)
    .map((w) => NUM_WORDS[w] ?? stem(w));
}

const isNum = (w: string) => /^\d/.test(w);

/** Words that carry meaning: no stopwords, nothing under three letters, no numbers. */
export function contentWords(text: string): string[] {
  return tokens(text).filter((w) => !isNum(w) && w.length >= 3 && !STOP.has(w));
}

export function figures(text: string): string[] {
  return tokens(text).filter(isNum);
}

/** First person: the speaker talking about themselves. "We" is left out: in a meeting it is usually the room. */
const FIRST_PERSON = /\b(i|i'm|i've|i'd|i'll|me|my|mine|myself|our|ours|ourselves|we've)\b/i;

const CITATION_ID = /\bc_[A-Za-z0-9]{4,}\b/g;

/**
 * First-person anecdote spoken as fact: the speaker's own shop, staff or
 * career offered as what happens. Each pattern was drawn from the real run.
 */
const ANECDOTE: RegExp[] = [
  // "My head baker quit", "my busiest Bristol counter never sees", "my Bristol shop"
  /\bmy (?:[a-z'-]+ ){0,3}?(?:shops?|bakery|bakeries|stores?|counters?|business(?:es)?|company|firm|team|staff|kitchens?|restaurants?|caf[eé]s?|sites?|clients?|customers?|tills?|branch(?:es)?|crew|bakers?|managers?|employees?|hires?|rota|venues?|places?|career|old job|last job)\b/i,
  // "my good Sunday", "my failed launch"; not "my last point"
  /\bmy (?:good|bad|successful|failed|best|worst|first|last|old|previous) (?!(?:point|question|answer|numbers?|turn|word|offer|case|figure|guess|estimate)\b)[a-z]+\b/i,
  // "at my last shop", "in our old place"
  /\b(?:at|in|from) (?:my|our) (?:last|old|previous|former|first|own)\b/i,
  // "I ran", "we've hired", "I watched"; not "I ran the numbers"
  /\b(?:i|we)(?:'ve| have)? (?:ran|run|owned|managed|opened|closed|hired|lost|watched|saw|seen|tried|built|launched|sold|worked|had)\b(?! (?:the |those |these |your |his |her )?(?:numbers|maths?|figures|sums|it|that|this|a look|no)\b)/i,
  // "in shops I've run", "in every bakery I've worked"
  /\bin (?:the |every |all |most )?(?:[a-z-]+ )?(?:shops|places|businesses|companies|kitchens|firms|bakeries|stores|sites|teams) (?:i|we)(?:'ve| have)? (?:run|ran|worked|managed|owned|seen|opened)\b/i,
  /\bin my (?:experience|career|day|time)\b/i,
  /\bwhen i (?:ran|was running|owned|managed|worked|had)\b/i,
];

const sentencesOf = (t: string) => t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);

/** Every sentence of a turn that tells a first-person anecdote as fact. */
export function anecdotes(text: string): string[] {
  return sentencesOf(text).filter((s) => ANECDOTE.some((re) => re.test(s)));
}

function mentions(text: string, names: string[]): boolean {
  const t = text.toLowerCase();
  return names.some((n) => {
    const first = n.trim().split(/\s+/)[0]?.toLowerCase();
    return !!first && first.length > 1 && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t);
  });
}

/** The founder's own words as a bag of content words and figures. */
export interface FounderIndex { words: Set<string>; figures: Set<string>; citations: Set<string> }

export function indexProvenance(p: Provenance): FounderIndex {
  const all = p.founder.filter(Boolean).join('\n');
  return { words: new Set(contentWords(all)), figures: new Set(figures(all)), citations: new Set(p.citations) };
}

/** Share of a claim's content words the founder used, and whether every figure in it is his. */
export function tracesToFounder(claim: string, ix: FounderIndex): boolean {
  const words = contentWords(claim);
  if (words.length < 2) return false;
  const hit = words.filter((w) => ix.words.has(w)).length;
  return hit / words.length >= 0.6 && figures(claim).every((f) => ix.figures.has(f));
}

export function citesKnownSource(claim: string, ix: FounderIndex): boolean {
  return (claim.match(CITATION_ID) ?? []).some((id) => ix.citations.has(id));
}

/** Why the check moved a claim, in words for the eval report. Empty when it stands. */
export type RegradeReason = '' | 'persona_backstory' | 'echoes_persona' | 'untraced' | 'nothing_computed';

/** Most of an earlier persona claim, restated. */
function echoes(claim: string, earlier: string[] | undefined): boolean {
  const cw = new Set(contentWords(claim));
  return (earlier ?? []).some((e) => {
    const ew = [...new Set(contentWords(e))];
    const shared = ew.filter((w) => cw.has(w)).length;
    return ew.length >= 3 && shared >= 3 && shared / ew.length >= 0.5;
  });
}

export function regradeClaim(c: ClaimRecord, p: Provenance, ix: FounderIndex = indexProvenance(p)): { claim: ClaimRecord; reason: RegradeReason } {
  const own = FIRST_PERSON.test(c.text) || mentions(c.text, p.panel) || ANECDOTE.some((re) => re.test(c.text));
  const moved = (grade: EvidenceGrade, reason: RegradeReason) => ({ claim: { ...c, grade, said: c.said ?? c.grade }, reason });
  if (c.grade === 'observed') {
    if (citesKnownSource(c.text, ix)) return { claim: c, reason: '' };
    if (!own && tracesToFounder(c.text, ix)) return { claim: c, reason: '' };
    if (own) return moved('persona', 'persona_backstory');
    return echoes(c.text, p.personaSoFar) ? moved('persona', 'echoes_persona') : moved('assumed', 'untraced');
  }
  if (c.grade === 'measured') {
    if (!p.measured) return moved(own ? 'persona' : 'assumed', 'nothing_computed');
    if (own && !citesKnownSource(c.text, ix)) return moved('persona', 'persona_backstory');
  }
  return { claim: c, reason: '' };
}

/** The deterministic post-check every expert turn's claims go through before they are published. */
export function regradeClaims(claims: ClaimRecord[] | undefined, p: Provenance): ClaimRecord[] | undefined {
  if (!claims?.length) return claims;
  const ix = indexProvenance(p);
  return claims.map((c) => regradeClaim(c, p, ix).claim);
}

/** The persona-graded claims in a record so far, for `Provenance.personaSoFar`. */
export function personaTexts(events: any[]): string[] {
  return events.flatMap((ev) => (ev?.type === 'message' ? ((ev.claims ?? []) as ClaimRecord[]).filter((c) => c.grade === 'persona').map((c) => c.text) : []));
}

export interface Regraded { speaker: string; messageId: string; before: ClaimRecord; after: ClaimRecord; reason: RegradeReason }

/**
 * Re-run the check over a whole recorded session, in order, as the engine
 * would have run it turn by turn. The speaker's grade is `said` where the log
 * already carries one. For the eval kit's before/after counts.
 */
export function regradeLog(events: any[], p: Provenance): Regraded[] {
  const out: Regraded[] = [];
  const persona: string[] = [];
  const ix = indexProvenance(p);
  for (const ev of events) {
    if (ev?.type !== 'message' || !ev.claims?.length) continue;
    for (const raw of ev.claims as ClaimRecord[]) {
      const before: ClaimRecord = { text: raw.text, grade: raw.said ?? raw.grade };
      const { claim, reason } = regradeClaim(before, { ...p, personaSoFar: persona }, ix);
      out.push({ speaker: ev.speaker, messageId: ev.id, before, after: claim, reason });
    }
    for (const r of out) if (r.messageId === ev.id && r.after.grade === 'persona') persona.push(r.after.text);
  }
  return out;
}

/**
 * The grade a ruling may carry. A ruling graded observed must have something
 * observed under it: a claim that survived the check above, or the founder's
 * own word during the motion. A ruling graded measured needs a computation.
 */
export function rulingGrade(evidence: EvidenceGrade, motionClaims: ClaimRecord[], founderSpoke: boolean, measured: boolean): EvidenceGrade {
  if (evidence === 'persona') return 'assumed';
  if (evidence === 'observed' && !founderSpoke && !motionClaims.some((c) => c.grade === 'observed')) return 'assumed';
  if (evidence === 'measured' && !measured) return 'assumed';
  return evidence;
}

/** How a claim reads in a record or prompt: "[persona; the speaker said observed] ...". */
export function claimTag(c: ClaimRecord): string {
  return c.said && c.said !== c.grade ? `[${c.grade}; the speaker said ${c.said}]` : `[${c.grade}]`;
}

// ---------- into the report ----------

export interface PersonaClaim { expert: string; claim: string; figures: string[] }

/** Every claim graded persona in the record, once each, with who said it. */
export function personaClaims(events: any[], nameOf: (id: string) => string): PersonaClaim[] {
  const out: PersonaClaim[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    if (ev?.type !== 'message') continue;
    for (const c of (ev.claims ?? []) as ClaimRecord[]) {
      if (c.grade !== 'persona') continue;
      const words = [...new Set(contentWords(c.text))];
      if (!words.length) continue;
      // The same story told again, near enough word for word, is listed once.
      const again = [...seen].some((k) => {
        const prev = k.split(' ');
        const shared = prev.filter((w) => words.includes(w)).length;
        return shared / Math.max(prev.length, words.length) >= 0.7;
      });
      if (again) continue;
      seen.add(words.join(' '));
      out.push({ expert: nameOf(ev.speaker), claim: c.text, figures: figures(c.text) });
    }
  }
  return out;
}

/**
 * Does this sentence rest on that persona claim? It repeats a figure only the
 * persona supplied (not the founder's, not research's) next to a word of the
 * claim or the persona's name; or it names the persona alongside the story
 * ("a repeat of Marisol's head baker walking out"); or it restates nearly all
 * of the claim. Talking about the same subject is not enough: a plan to count
 * Saturday asks at the counter does not rest on a panelist's counter.
 */
export function restsOn(sentence: string, pc: PersonaClaim, ix: FounderIndex): boolean {
  const sw = new Set(contentWords(sentence));
  const sf = new Set(figures(sentence));
  const cw = [...new Set(contentWords(pc.claim))];
  const shared = cw.filter((w) => sw.has(w)).length;
  // Words of the story itself, not of the founder's topic ("head", "baker", "quit"; not "Sunday").
  const own = cw.filter((w) => sw.has(w) && !ix.words.has(w)).length;
  const named = mentions(sentence, [pc.expert]);
  const ownFigure = pc.figures.some((f) => !ix.figures.has(f) && sf.has(f));
  if (ownFigure && (shared >= 1 || named)) return true;
  if (named && own >= 1 && shared >= 2) return true;
  return cw.length >= 3 && own >= 2 && shared >= 3 && shared / cw.length >= 0.75;
}

export const PERSONA_LABEL = "Assumption, not evidence (a panelist's illustrative experience, not your business)";

/**
 * Label what the report built on persona claims. Decision trails gain a
 * dependsOn line for each persona claim their text rests on; a numbers-audit
 * finding whose figure came from one says it is an assumption. The persona
 * claims themselves ride on the report so the renderer can list them.
 * `ix` should index the founder's input AND the research briefs: a figure
 * research also gave is not persona-only.
 */
export function labelPersonaDerived(data: ReportData, claims: PersonaClaim[], ix: FounderIndex): ReportData {
  if (!claims.length) return data;
  const label = (pc: PersonaClaim) => `${PERSONA_LABEL}: ${pc.expert}, "${pc.claim}"`;
  const decisions = (data.decisions ?? []).map((t) => {
    const text = [t.conclusion, t.resolution, ...(t.supportedBy ?? []).map((s) => s.argument), ...(t.challengedBy ?? []).map((c) => c.objection)]
      .filter(Boolean).join(' ');
    const hits = claims.filter((pc) => sentencesOf(text).some((s) => restsOn(s, pc, ix)));
    if (!hits.length) return t;
    const deps = [...(t.dependsOn ?? [])];
    for (const pc of hits) if (!deps.includes(label(pc))) deps.push(label(pc));
    return { ...t, dependsOn: deps };
  });
  const audit = data.numbersAudit
    ? {
        ...data.numbersAudit,
        findings: data.numbersAudit.findings.map((f) => {
          if (f.origin === 'persona' || !claims.some((pc) => restsOn(f.figure, pc, ix))) return f;
          return { ...f, origin: 'persona' as const, impact: `${PERSONA_LABEL}. ${f.impact}`.trim() };
        }),
      }
    : undefined;
  return { ...data, decisions, ...(audit ? { numbersAudit: audit } : {}), personaClaims: claims };
}
