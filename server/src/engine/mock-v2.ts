/**
 * Mock engine v2 (docs/PHASE2-PLAN.md, 5.2): a scripted session that shows
 * every realism behaviour with zero model calls.
 *
 * Two halves. `compileScenario` is PURE: scenario + seed + provider in, a flat
 * list of steps out, so a replay with the same seed is byte-identical and a
 * test can inspect the whole session without running a clock. It runs the real
 * FloorDirector (interruption decision, cut point, floor fight, heat, owed
 * answers, chair triggers), so the mock exercises the code the engine will.
 * `playSteps` is the only part that sleeps, publishes and touches the database.
 *
 * The words are scripted and the cut points are not: the author writes the
 * full text of a turn and the director decides where it is cut.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CFG, debateDir } from '../config.ts';
import { Debates, Events, type DebateRow } from '../db.ts';
import { Hub } from '../sse.ts';
import { MARCUS } from '../agents/prompts.ts';
import { appendTranscriptFile, founderLine, initTranscriptFile } from './transcript.ts';
import {
  chairTrigger, decideInterruption, floorFight, newFloor, pressOwed, rand, recordInterruption, recordTurn, raiseHeat,
  type DirectorSeat,
} from './director.ts';
import { budgetSnapshot, profileOf } from '../budget.ts';
import { claudeEngine, modelFor, providerOfConfig, PROVIDER_LABEL, SEAT_TIER, type Provider, type Seat } from '../../../shared/models.ts';
import type {
  Belief, Citation, Concession, Confidence, DebateEvent, DebateStatus, Decision, Persona, Plan, ResearchResult,
  Stakes, Stance, TurnShape,
} from '../../../shared/types.ts';

// ---------- scenario shape (the content lives in mock-scenarios.ts) ----------

export interface MockExpert {
  persona: Persona;
  temperament: NonNullable<DirectorSeat['temperament']>;
  /** Where they walk in. */
  belief: { stance: Stance; confidence: Confidence; crux: string; reasons: string[] };
}

type Claim = { text: string; grade: 'measured' | 'observed' | 'assumed' | 'mixed' };
interface Line { id: string; text: string; shape: TurnShape }

export type Beat =
  /** The chair speaks. `expect` asserts a director chair trigger is live (a scenario bug otherwise). */
  | { t: 'chair'; text: string; expect?: 'dodge' | 'heat' | 'unexplained' }
  | { t: 'say'; id: string; who: string; shape: 'set_piece' | 'reply'; text: string; to?: string[]; question?: string; dodge?: boolean; claims?: Claim[] }
  /** A short reaction, no overlap. `question` re-presses an owed answer. */
  | { t: 'react'; id: string; who: string; text: string; to?: string[]; question?: string }
  /**
   * A turn the director may cut. If it declines (not hot enough), the full
   * text is simply spoken. After a cut, a floor fight decides which of
   * `resume` / `takes` follows.
   */
  | {
      t: 'cut'; id: string; who: string; shape: 'set_piece' | 'reply'; text: string; to?: string[]; dodge?: boolean;
      by: string; cutIn: string; cutId: string; intensity: number; atSentence: number; pauseMs: number;
      resume: Line; takes: Line;
    }
  | { t: 'aside'; from: string; to: string; text: string }
  | { t: 'pause'; ms: number; reason: 'after_concession' | 'unanswered' | 'tension' | 'chair' }
  | { t: 'heat'; who: string; times: number }
  | { t: 'press'; from: string }
  | { t: 'research'; question: string; thinking: string }
  | {
      t: 'concede'; expert: string; to: { stance: Stance; confidence: Confidence }; kind: Concession['kind'];
      movedBy: Concession['movedBy']; cost: string;
    }
  | { t: 'round'; round: number; fresh: number; rung: number; rungName: string; note?: string }
  | { t: 'ask_founder'; question: string; context: string; options: { label: string; description: string }[]; assumed: string }
  | { t: 'limit_pause'; ms: number };

export interface Scenario {
  key: string;
  title: string;
  topic: string;
  goal: string;
  /** The assumed founder name when FOUNDER_NAME is not set. */
  founder: string;
  stakes: Stakes;
  clarify: { question: string; options: string[] }[];
  contextBrief: string;
  scopeRationale: string;
  experts: MockExpert[];
  panelRationale: string;
  motion: { id: string; title: string; motion: string };
  plan: Plan;
  /** Fictional sources, built per provider so each door's citation shape shows. */
  sources: SourceSpec[];
  findings: { claim: string; figure?: { value: string; unit?: string; asOf?: string }; source: number; confidence: 'high' | 'medium' | 'low' }[];
  researchSummary: string;
  researchSpoken: string;
  beats: Beat[];
  decision: Decision;
  closings: { who: string; text: string }[];
  audit?: { checked: number; summary: string; findings: { figure: string; verdict: 'holds' | 'wrong' | 'uncheckable'; recomputed: string; impact: string }[] };
  /** Dollars the fake ledger adds per spoken turn; tuned so the meter crosses 80% near the end. */
  spend: { perSpoken: number; perReaction: number };
}

export interface SourceSpec {
  url: string;
  title: string;
  publisher: string;
  publishedAt: string;
  quote: string;
}

// ---------- steps ----------

export type Step =
  | { k: 'sleep'; ms: number }
  | { k: 'boundary' }
  | { k: 'pub'; ev: any; msgRef?: string }
  | { k: 'delta'; messageId: string; speaker: string; kind: string; textDelta: string }
  | { k: 'speaking'; speaker: string | null; phase: 'thinking' | 'talking' | null }
  | { k: 'transcript'; line: string }
  | { k: 'think'; actor: 'marcus' | 'research'; label: string; detail: string; reasoning: string; ms: number }
  | { k: 'spend'; spoken: boolean; reaction: boolean; usd: number }
  | { k: 'belief'; motionId: string; beliefs: Belief[]; sinceRef: string | null }
  | { k: 'limit_pause'; ms: number }
  | { k: 'ask_founder'; question: string; context: string; options: { label: string; description: string }[]; assumed: string };

export interface CompileOpts {
  seed: string | number;
  provider: Provider;
  founder: string;
}

export interface Compiled {
  steps: Step[];
  /** Cuts the director declined, by message id. A scenario should have none. */
  declinedCuts: string[];
  /** The beat that fixes the floor fight, per cut. */
  fights: Record<string, 'speaker_resumes' | 'interrupter_takes' | 'declined'>;
}

const WPS = 2.6;   // meeting-clock speaking pace, words a second
const nWords = (s: string) => s.split(/\s+/).filter(Boolean).length;
const round2 = (x: number) => Math.round(x * 100) / 100;

export const citationId = (url: string) => 'c_' + crypto.createHash('sha1').update(url.toLowerCase().replace(/\/+$/, '')).digest('hex').slice(0, 4);

/**
 * The same fictional sources in each door's shape (docs/PHASE2-PLAN.md, 3.2):
 * Claude fetches pages and quotes only from search snippets; OpenAI cites
 * search results with no quote; Codex can only report sources from the model.
 */
export function buildResearch(scn: Scenario, provider: Provider, requestId: string): ResearchResult {
  const citations: Citation[] = scn.sources.map((s, i) => {
    const base = { id: citationId(s.url), url: s.url, title: s.title, publisher: s.publisher, publishedAt: s.publishedAt, retrievedAt: 1_760_000_000_000 + i * 1000, provider };
    if (claudeEngine(provider)) {
      // Claude Code's WebFetch returns a summary, so `fetched` attests the URL was read; the quote comes from the search snippet.
      return i === 0 ? { ...base, provenance: 'fetched' as const, quote: s.quote } : { ...base, provenance: 'search_result' as const, quote: s.quote };
    }
    if (provider === 'openai') return { ...base, provenance: 'search_result' as const };
    return { ...base, provenance: 'model_reported' as const };
  });
  const mark = (n: number) => `[${citations[n].id}]`;
  const withMarkers = (s: string) => s.replace(/\{(\d)\}/g, (_m, d) => mark(Number(d)));
  return {
    requestId,
    status: 'ok',
    summary: withMarkers(scn.researchSummary),
    spoken: withMarkers(scn.researchSpoken),
    findings: scn.findings.map((f) => ({ claim: f.claim, figure: f.figure, citationIds: [citations[f.source].id], confidence: f.confidence })),
    citations,
    searches: claudeEngine(provider) ? 5 : 4,
    durationMs: 41_000,
    costUsd: claudeEngine(provider) ? 0.31 : 0.38,
    provider,
    model: modelFor(provider, 'research'),
  };
}

// ---------- compile ----------

export function compileScenario(scn: Scenario, opts: CompileOpts): Compiled {
  const steps: Step[] = [];
  const declinedCuts: string[] = [];
  const fights: Compiled['fights'] = {};
  const seats: DirectorSeat[] = scn.experts.map((e) => ({ id: e.persona.id, temperament: e.temperament }));
  const floor = newFloor(scn.motion.id, seats, `${opts.seed}:${scn.key}`);
  const names = new Map<string, string>([['marcus', MARCUS.name], ['research', 'RESEARCH DESK'], ...scn.experts.map((e) => [e.persona.id, e.persona.name] as [string, string])]);
  const nameOf = (id: string) => names.get(id) ?? id;
  const upper = (id: string) => nameOf(id).toUpperCase();
  const beliefs = new Map<string, Belief>();
  for (const e of scn.experts) {
    beliefs.set(e.persona.id, { expert: e.persona.id, motionId: scn.motion.id, stance: e.belief.stance, confidence: e.belief.confidence, crux: e.belief.crux, reasons: e.belief.reasons, sinceSeq: 0 });
  }
  let taskN = 0;
  let lastMsg = '';
  let lastSpokenId: string | null = null;
  let unexplainedOpen = false;
  let research: ResearchResult | null = null;

  const sleep = (ms: number) => steps.push({ k: 'sleep', ms: Math.round(ms) });
  const pub = (ev: any, msgRef?: string) => steps.push({ k: 'pub', ev, msgRef });
  const jitter = (lo: number, hi: number) => lo + (hi - lo) * rand(floor);

  /** Words in small groups, the way a stream arrives. */
  function chunk(text: string): string[] {
    const words = text.split(' ');
    const out: string[] = [];
    for (let i = 0; i < words.length;) {
      const n = 2 + Math.floor(rand(floor) * 2);
      out.push((i ? ' ' : '') + words.slice(i, i + n).join(' '));
      i += n;
    }
    return out;
  }

  function checkpointFloor() {
    const handsUp = seats
      .filter((s) => (floor.heat[s.id] ?? 0) >= (s.temperament?.interruptThreshold ?? 0.75) - 0.15)
      .map((s) => s.id);
    const heat: Record<string, number> = {};
    for (const [k, v] of Object.entries(floor.heat)) heat[k] = round2(v);
    pub({ type: 'floor', motionId: scn.motion.id, heat, handsUp, clock: { elapsedSec: Math.round(floor.clock.elapsedSec), slotSec: floor.clock.slotSec } });
  }

  function advanceClock(words: number, pauseMs = 0) {
    floor.clock.elapsedSec += words / WPS + pauseMs / 1000;
  }

  function tx(line: string) { steps.push({ k: 'transcript', line }); }

  /** A whole message, streamed alone. */
  function speak(args: {
    id: string; who: string; kind: 'floor' | 'interjection' | 'marcus' | 'research' | 'closing' | 'reaction'; shape: TurnShape;
    text: string; to?: string[]; replyTo?: string; claims?: Claim[]; question?: string; keep?: 'dodge'; label?: string;
  }) {
    const quick = args.shape === 'reaction';
    args = { ...args, text: args.text.replace(/\{founder\}/g, opts.founder) };
    steps.push({ k: 'boundary' });
    steps.push({ k: 'speaking', speaker: args.who, phase: 'thinking' });
    sleep(quick ? jitter(350, 600) : jitter(900, 1600));
    steps.push({ k: 'speaking', speaker: args.who, phase: 'talking' });
    for (const c of chunk(args.text)) {
      steps.push({ k: 'delta', messageId: args.id, speaker: args.who, kind: args.kind, textDelta: c });
      sleep(jitter(150, 250));
    }
    const ev: any = { type: 'message', id: args.id, speaker: args.who, kind: args.kind, shape: args.shape, text: args.text };
    if (args.to) ev.to = args.to;
    if (args.replyTo) ev.replyTo = args.replyTo;
    if (args.claims) ev.claims = args.claims;
    pub(ev, args.id);
    tx(`**${args.label ?? nameOf(args.who)}${args.kind === 'closing' ? ' (closing)' : ''}:** ${args.text}`);
    steps.push({ k: 'speaking', speaker: null, phase: null });
    book(args);
    lastMsg = args.id;
    lastSpokenId = args.id;
  }

  function book(args: { who: string; to?: string[]; question?: string; id: string; shape: TurnShape; keep?: 'dodge'; text: string }) {
    steps.push({ k: 'spend', spoken: args.shape !== 'reaction' && args.shape !== 'chair', reaction: args.shape === 'reaction', usd: args.shape === 'reaction' ? scn.spend.perReaction : scn.spend.perSpoken });
    if (args.who !== 'marcus' && args.who !== 'research') {
      const owedBefore = floor.owed.filter((o) => o.from === args.who).map((o) => ({ ...o }));
      recordTurn(floor, seats, { speaker: args.who, to: args.to, question: args.question, messageId: args.id });
      // A dodge: they spoke, but the question they owe is still standing, and it has been pressed once more.
      if (args.keep === 'dodge') for (const o of owedBefore) floor.owed.push({ ...o, presses: o.presses + 1 });
      // Being asked a pointed question, or squirming under one, raises the temperature.
      if (args.question) for (const t of args.to ?? []) raiseHeat(floor, seats, t, 1);
      if (args.keep === 'dodge') raiseHeat(floor, seats, args.who, 0.5);
    }
    advanceClock(nWords(args.text));
    checkpointFloor();
  }

  function concede(b: Extract<Beat, { t: 'concede' }>) {
    const cur = beliefs.get(b.expert)!;
    const concession: Concession = {
      motionId: scn.motion.id, expert: b.expert,
      from: { stance: cur.stance, confidence: cur.confidence }, to: b.to, kind: b.kind, movedBy: b.movedBy, cost: b.cost, messageId: lastSpokenId ?? '',
    };
    beliefs.set(b.expert, { ...cur, stance: b.to.stance, confidence: b.to.confidence, sinceSeq: 0 });
    pub({ type: 'concession', concession });
    steps.push({ k: 'belief', motionId: scn.motion.id, beliefs: [...beliefs.values()].map((x) => ({ ...x })), sinceRef: lastSpokenId });
    if (b.movedBy.kind === 'unexplained') unexplainedOpen = true;
  }

  // ---- the meeting ----
  pub({ type: 'motion_open', motionId: scn.motion.id, index: 0, total: 1, title: scn.motion.title, motion: scn.motion.motion });
  steps.push({ k: 'belief', motionId: scn.motion.id, beliefs: [...beliefs.values()].map((x) => ({ ...x })), sinceRef: null });
  checkpointFloor();

  for (const b of scn.beats) {
    if (unexplainedOpen && b.t !== 'chair' && b.t !== 'pause') {
      throw new Error(`scenario ${scn.key}: an unexplained concession must be followed by the chair, not ${b.t}`);
    }
    switch (b.t) {
      case 'chair': {
        if (b.expect === 'unexplained') {
          if (!unexplainedOpen) throw new Error(`scenario ${scn.key}: chair expected an unexplained move`);
          unexplainedOpen = false;
        } else if (b.expect) {
          const trig = chairTrigger(floor);
          if (!trig || trig.kind !== b.expect) throw new Error(`scenario ${scn.key}: chair expected a ${b.expect} trigger, director has ${trig?.kind ?? 'none'}`);
          // The chair names it; the press is spent.
          if (trig.kind === 'dodge') floor.owed = floor.owed.filter((o) => o.from !== trig.who);
        }
        const id = `m_${scn.key}_${++taskN}`;
        speak({ id, who: 'marcus', kind: 'marcus', shape: 'chair', text: b.text.replace(/\{founder\}/g, opts.founder) });
        if (b.expect) { const ms = b.expect === 'dodge' ? 1800 : 1400; pub({ type: 'pause', ms, reason: b.expect === 'dodge' ? 'unanswered' : 'chair' }); sleep(ms); advanceClock(0, ms); }
        break;
      }
      case 'say': {
        speak({ id: b.id, who: b.who, kind: 'floor', shape: b.shape, text: b.text, to: b.to, replyTo: lastMsg || undefined, claims: b.claims, question: b.question, keep: b.dodge ? 'dodge' : undefined });
        break;
      }
      case 'react': {
        speak({ id: b.id, who: b.who, kind: 'reaction', shape: 'reaction', text: b.text, to: b.to, replyTo: lastMsg || undefined, question: b.question });
        break;
      }
      case 'cut': {
        const reactions = [{ listener: b.by, intensity: b.intensity, atSentence: b.atSentence, cutIn: b.cutIn }];
        const cut = decideInterruption(floor, seats, b.who, b.text, reactions);
        if (!cut) {
          declinedCuts.push(b.id);
          fights[b.id] = 'declined';
          speak({ id: b.id, who: b.who, kind: 'floor', shape: b.shape, text: b.text, to: b.to, replyTo: lastMsg || undefined });
          break;
        }
        const spoken = b.text.slice(0, cut.atChar);
        const sWords = spoken.split(' ');
        const cWords = b.cutIn.split(' ');
        const tail = Math.min(3, Math.max(1, sWords.length - 1));
        const overlapFrom = sWords.length - tail;
        const fromChar = sWords.slice(0, overlapFrom).join(' ').length;
        const fight = floorFight(floor, seats, b.who, b.by);
        fights[b.id] = fight;
        const follow: Line = fight === 'speaker_resumes' ? b.resume : b.takes;

        steps.push({ k: 'boundary' });
        steps.push({ k: 'speaking', speaker: b.who, phase: 'thinking' });
        sleep(jitter(900, 1400));
        steps.push({ k: 'speaking', speaker: b.who, phase: 'talking' });
        const kindOf = 'floor';
        const del = (id: string, speaker: string, kind: string, textDelta: string) => steps.push({ k: 'delta', messageId: id, speaker, kind, textDelta });
        const sWordChunks = sWords.map((w, i) => (i ? ' ' : '') + w);
        const cWordChunks = cWords.map((w, i) => (i ? ' ' : '') + w);
        // The speaker alone, then the cut-in starts over the last words.
        for (let i = 0; i < overlapFrom; i++) { del(b.id, b.who, kindOf, sWordChunks[i]); sleep(jitter(110, 170)); }
        let ci = 0;
        for (let i = overlapFrom; i < sWords.length; i++) {
          del(b.id, b.who, kindOf, sWordChunks[i]);
          if (ci < cWords.length) del(b.cutId, b.by, 'reaction', cWordChunks[ci++]);
          sleep(jitter(130, 190));
        }
        // Both turns are open here: the window a refresh has to rebuild.
        sleep(2600);
        pub({ type: 'message', id: b.id, speaker: b.who, kind: 'floor', shape: b.shape, text: spoken, to: b.to, replyTo: lastMsg || undefined, cutOff: { atChar: cut.atChar, by: b.by, resumedBy: fight === 'speaker_resumes' ? follow.id : undefined } }, b.id);
        tx(`**${nameOf(b.who)}:** ${spoken}— [cut off by ${upper(b.by)}]`);
        while (ci < cWords.length) { del(b.cutId, b.by, 'reaction', cWordChunks[ci++]); sleep(jitter(90, 130)); }
        pub({ type: 'message', id: b.cutId, speaker: b.by, kind: 'reaction', shape: 'reaction', to: [b.who], replyTo: b.id, text: b.cutIn, overlap: { with: b.id, fromChar } }, b.cutId);
        tx(`**${nameOf(b.by)} (over ${upper(b.who)}):** ${b.cutIn}`);
        steps.push({ k: 'speaking', speaker: null, phase: null });
        recordInterruption(floor, seats, b.by, b.who);
        // Book the cut turn (a partial counts as the speaker's turn) and the cut-in.
        book({ who: b.who, to: b.to, id: b.id, shape: b.shape, text: spoken, keep: b.dodge ? 'dodge' : undefined });
        book({ who: b.by, to: [b.who], id: b.cutId, shape: 'reaction', text: b.cutIn });
        lastMsg = b.cutId;
        lastSpokenId = b.cutId;
        pub({ type: 'pause', ms: b.pauseMs, reason: 'tension' });
        sleep(b.pauseMs);
        advanceClock(0, b.pauseMs);
        const winner = fight === 'speaker_resumes' ? b.who : b.by;
        speak({ id: follow.id, who: winner, kind: 'floor', shape: follow.shape, text: follow.text, to: [fight === 'speaker_resumes' ? b.by : b.who], replyTo: b.cutId, keep: b.dodge && winner === b.who ? 'dodge' : undefined });
        break;
      }
      case 'aside': {
        steps.push({ k: 'boundary' });
        pub({ type: 'aside', id: `as_${scn.key}_${++taskN}`, from: b.from, to: b.to, text: b.text });
        sleep(1600);
        break;
      }
      case 'pause': {
        pub({ type: 'pause', ms: b.ms, reason: b.reason });
        sleep(b.ms);
        advanceClock(0, b.ms);
        break;
      }
      case 'heat': {
        raiseHeat(floor, seats, b.who, b.times);
        checkpointFloor();
        break;
      }
      case 'press': {
        pressOwed(floor, b.from);
        break;
      }
      case 'research': {
        const rid = `r_${scn.key}_${++taskN}`;
        steps.push({ k: 'boundary' });
        pub({ type: 'research_started', taskId: rid, question: b.question });
        steps.push({ k: 'think', actor: 'research', label: 'The research desk is searching', detail: b.question, reasoning: b.thinking, ms: 6500 });
        research = buildResearch(scn, opts.provider, rid);
        pub({ type: 'research_done', taskId: rid, summary: research.summary, result: research });
        advanceClock(0, 45_000);
        speak({ id: `m_${scn.key}_${++taskN}`, who: 'research', kind: 'research', shape: 'reply', text: research.spoken, label: 'RESEARCH DESK' });
        break;
      }
      case 'concede': {
        concede(b);
        if (b.movedBy.kind !== 'unexplained') { pub({ type: 'pause', ms: 2200, reason: 'after_concession' }); sleep(2200); advanceClock(0, 2200); }
        break;
      }
      case 'round': {
        pub({ type: 'round', motionId: scn.motion.id, round: b.round, freshArguments: b.fresh, rung: b.rung, rungName: b.rungName, note: b.note });
        break;
      }
      case 'ask_founder': {
        steps.push({ k: 'boundary' });
        steps.push({ k: 'ask_founder', question: b.question, context: b.context, options: b.options, assumed: b.assumed });
        break;
      }
      case 'limit_pause': {
        steps.push({ k: 'boundary' });
        steps.push({ k: 'limit_pause', ms: b.ms });
        break;
      }
    }
  }
  if (unexplainedOpen) throw new Error(`scenario ${scn.key}: ends on an unexplained concession`);

  // The ruling.
  steps.push({ k: 'boundary' });
  pub({ type: 'decision', decision: { ...scn.decision, owner: scn.decision.owner.replace(/\{founder\}/g, opts.founder) } });
  pub({ type: 'motion_closed', motionId: scn.motion.id, rounds: scn.beats.filter((x) => x.t === 'round').length, messages: 0 });
  void lastMsg;
  void research;
  return { steps, declinedCuts, fights };
}

// ---------- play ----------

/** What the player needs from MockRun. */
export interface MockHost {
  readonly id: string;
  row: DebateRow;
  killed: boolean;
  pausedFlag: boolean;
  endedFlag: boolean;
  pub(ev: any): DebateEvent | undefined;
  live(f: any): void;
  setStatus(s: DebateStatus): void;
  gate(stage: 'goal' | 'panel' | 'plan'): Promise<void>;
  wait(): Promise<any>;
  meta(): DebateRow['meta'];
  saveMeta(): void;
}

export const rid = (p: string) => `${p}_${crypto.randomBytes(6).toString('base64url')}`;

export function mockSpeed(): number {
  const v = (process.env.MOCK_SPEED ?? '1').trim();
  if (v === 'max') return Infinity;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export async function playScenario(host: MockHost, scn: Scenario, env: { seed?: string; speed?: number } = {}): Promise<void> {
  const speed = env.speed ?? mockSpeed();
  const nap = (ms: number) => (speed === Infinity ? Promise.resolve() : new Promise<void>((r) => setTimeout(r, ms / speed)));
  const provider = providerOfConfig(host.row.config);
  const founder = CFG.founderName || scn.founder;
  const seed = env.seed ?? process.env.MOCK_SEED ?? 'mockv2';
  const meta = () => host.meta();

  // ---- intake ----
  if (meta().contextFiles > 0) {
    host.pub({ type: 'system', text: `Dossier analyst reading your uploaded context (${meta().contextFiles} files).` });
    await nap(1500);
    host.pub({ type: 'context_brief', files: meta().contextFiles, brief: scn.contextBrief });
  }
  host.pub({ type: 'system', text: 'Intake analysis running. Assessing whether the mission is clear enough to brief a panel.' });
  await nap(1200);
  const qids = scn.clarify.map(() => rid('q'));
  scn.clarify.forEach((c, i) => host.pub({ type: 'clarify', questionId: qids[i], question: c.question, options: c.options, allowCustom: true }));
  meta().pendingClarify = qids;
  host.saveMeta();
  host.setStatus('clarifying');
  await host.wait();

  host.setStatus('intake');
  await nap(900);
  Debates.patch(host.id, { title: scn.title, goal: scn.goal });
  host.row = Debates.get(host.id)!;
  host.pub({ type: 'goal', title: scn.title, goal: scn.goal });
  host.pub({ type: 'system', text: stakesBlock(scn.stakes, founder) });
  // Information only, as in the real engine: a profile and the founder's own ceiling, never caps.
  const profile = profileOf(host.row.config);
  const ceilingUsd = host.row.config.ceilingUsd ?? CFG.budgetCeilingUsd;
  host.pub({
    type: 'scope',
    scope: {
      experts: scn.experts.length, motions: 1, roundsPerMotion: 4, depth: 'standard', rationale: scn.scopeRationale,
      estimate: { turns: 34, lowUsd: 2.1, highUsd: 4.2, basis: '34 agent turns, priced from completed sessions (mock figures).', ...(profile ? { profile } : {}), ceilingUsd },
    },
  });
  host.setStatus('goal_approval');
  await host.gate('goal');

  host.setStatus('panel_design');
  host.pub({ type: 'system', text: 'Panel architect at work. Reading the stakes and designing the roster.' });
  await nap(1800);
  const roster = [MARCUS, ...scn.experts.map((e) => e.persona)];
  Debates.patch(host.id, { personas: roster });
  host.row.personas = roster;
  host.pub({ type: 'panel', personas: roster, rationale: scn.panelRationale });
  host.setStatus('panel_approval');
  await host.gate('panel');

  host.setStatus('planning');
  Debates.patch(host.id, { plan: scn.plan });
  host.row.plan = scn.plan;
  host.pub({ type: 'plan', plan: scn.plan });
  host.setStatus('plan_approval');
  await host.gate('plan');

  const seats: Seat[] = ['chair', 'floor', 'ruling', 'referee', 'report', 'quant', 'summon', 'research', 'dossier', 'lint'];
  host.pub({
    type: 'casting',
    casting: {
      chair: modelFor(provider, 'chair'), revision: 1,
      strategy: `${PROVIDER_LABEL[provider]} session (mock v2). Seats are cast by the product, not chosen per debate.`,
      entries: seats.map((role) => ({ role, model: modelFor(provider, role), why: `Runs on the ${SEAT_TIER[role]} tier.` })),
    },
  });

  // ---- meeting ----
  host.setStatus('meeting');
  initTranscriptFile(host.row, Events.since(host.id, 0), CFG.founderName);
  const { steps } = compileScenario(scn, { seed, provider, founder });
  const ledger = { usd: 0, output: 0, flagshipCalls: 0, calls: 0, turns: 0 };
  const seqOfMsg = new Map<string, number>();

  /** The meter is information only: nothing in the room reads it. */
  const meter = (persist: boolean) => {
    if (!profile) return;
    const snap = budgetSnapshot(profile, provider, ledger, { expectedTurns: 30, estimate: { lowUsd: 2.1, highUsd: 4.2 }, ceilingUsd });
    host.live({ type: 'budget', budget: snap });
    if (persist) host.pub({ type: 'budget', budget: snap });
  };

  for (const st of steps) {
    if (host.killed || host.endedFlag) break;
    switch (st.k) {
      case 'sleep': await nap(st.ms); break;
      case 'boundary':
        while (host.pausedFlag && !host.killed && !host.endedFlag) await host.wait();
        break;
      case 'pub': {
        const full = host.pub(st.ev);
        if (st.msgRef && full) seqOfMsg.set(st.msgRef, full.seq);
        if (st.ev.type === 'message') { meta().floorCount++; host.saveMeta(); }
        break;
      }
      case 'delta': host.live({ type: 'delta', messageId: st.messageId, speaker: st.speaker, kind: st.kind, textDelta: st.textDelta }); break;
      case 'speaking': host.live({ type: 'speaking', speaker: st.speaker, phase: st.phase }); break;
      case 'transcript': appendTranscriptFile(host.id, st.line); break;
      case 'think': {
        const stage = Hub.stage(host.id, st.actor, st.label, st.detail);
        const words = st.reasoning.split(' ');
        const per = Math.max(1, Math.ceil(words.length / Math.max(1, st.ms / 550)));
        for (let i = 0; i < words.length && !host.killed; i += per) {
          stage.think((i ? ' ' : '') + words.slice(i, i + per).join(' '));
          await nap(550);
        }
        stage.close();
        break;
      }
      case 'spend':
        ledger.calls += 1;
        ledger.usd += st.usd;
        ledger.output += st.reaction ? 60 : 900;
        if (!st.reaction) ledger.flagshipCalls += 1;
        if (st.spoken) ledger.turns += 1;
        meter(false);
        break;
      case 'belief': {
        const sinceSeq = st.sinceRef ? seqOfMsg.get(st.sinceRef) ?? 0 : 0;
        host.pub({ type: 'belief', motionId: st.motionId, beliefs: st.beliefs.map((b) => ({ ...b, sinceSeq })) });
        break;
      }
      case 'limit_pause': {
        // The same shape the real engine parks in (runner.parkForLimit), at a made-up reset.
        const resetAt = Date.now() + st.ms;
        meta().limitPause = { since: Date.now(), resetAt, kind: 'session', attempts: 1, nextTryAt: resetAt, resumeTo: 'meeting' };
        host.saveMeta();
        host.setStatus('paused');
        host.pub({ type: 'quota', pause: { resumesAt: resetAt, kind: 'session', stated: true } });
        host.pub({ type: 'system', text: `Your ${provider === 'claude' ? '5-hour Claude' : `${PROVIDER_LABEL[provider]}`} limit is spent. Nothing is lost: the session is paused here and resumes on its own around ${new Date(resetAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}. (Simulated by the mock engine.)` });
        await nap(st.ms);
        if (host.killed) break;
        meta().limitPause = null;
        host.saveMeta();
        host.pub({ type: 'quota', pause: null });
        host.pub({ type: 'system', text: 'Trying again: the limit should have reset.' });
        host.setStatus('meeting');
        host.pausedFlag = false;
        break;
      }
      case 'ask_founder': {
        const uq = rid('uq');
        host.pub({ type: 'question', questionId: uq, question: st.question, context: st.context, options: st.options, allowCustom: true });
        appendTranscriptFile(host.id, `**Marcus asks the founder:** ${st.question}`);
        meta().pendingQuestionId = uq;
        host.saveMeta();
        if (host.row.config.autonomy === 'autonomous') {
          await nap(1500);
          meta().pendingQuestionId = null;
          host.saveMeta();
          host.pub({ type: 'assumption', text: st.assumed });
          appendTranscriptFile(host.id, `**Marcus, deciding for the founder:** ${st.assumed}`);
        } else {
          await host.wait();
        }
        break;
      }
    }
  }
  if (host.killed || host.endedFlag) return;

  // ---- wrapup, report ----
  meter(true);
  host.pub({ type: 'convergence', verdict: 'converged', note: 'Key questions answered; dissent recorded with a tripwire.' });
  host.setStatus('wrapup');
  for (const c of scn.closings) {
    if (host.killed) return;
    const id = `m_${scn.key}_c_${c.who}`;
    host.live({ type: 'speaking', speaker: c.who, phase: 'talking' });
    const words = c.text.split(' ');
    for (let i = 0; i < words.length; i += 3) {
      host.live({ type: 'delta', messageId: id, speaker: c.who, kind: 'closing', textDelta: (i ? ' ' : '') + words.slice(i, i + 3).join(' ') });
      await nap(85);
    }
    host.pub({ type: 'message', id, speaker: c.who, kind: 'closing', shape: 'set_piece', text: c.text });
    appendTranscriptFile(host.id, `**${scn.experts.find((e) => e.persona.id === c.who)?.persona.name ?? c.who} (closing):** ${c.text}`);
    host.live({ type: 'speaking', speaker: null, phase: null });
    meta().floorCount++;
    host.saveMeta();
    await nap(400);
  }

  host.setStatus('reporting');
  if (scn.audit) host.pub({ type: 'audit', ...scn.audit });
  await nap(2000);
  fs.writeFileSync(
    path.join(debateDir(host.id), 'report.html'),
    `<!doctype html><html><head><meta charset="utf-8"><title>Mock Report</title><style>body{background:#060a12;color:#dbe7f3;font:16px/1.6 system-ui;max-width:800px;margin:40px auto;padding:0 20px}h1{color:#22d3ee}</style></head><body><h1>${scn.title}</h1><p>Mock report placeholder (scenario ${scn.key}). The real engine renders the full interactive report here.</p></body></html>`,
  );
  host.pub({ type: 'report_ready', path: `/api/debates/${host.id}/report` });
  host.setStatus('complete');
}

/** The stakes, printed plainly, with where they came from. */
export function stakesBlock(s: Stakes, founder: string): string {
  const risk = Object.entries(s.atRisk).map(([k, v]) => `${k}: ${v}`).join('; ');
  const owner = s.decisionOwner.name === 'FOUNDER' ? founder : s.decisionOwner.name;
  return [
    'STAKES',
    `Decision owner: ${owner}, ${s.decisionOwner.role}. Decide by: ${s.decideBy}.`,
    `At risk: ${risk}.`,
    `If we say yes and are wrong: ${s.ifWrong.yes}`,
    `If we say no and are wrong: ${s.ifWrong.no}`,
    `Reversibility: ${s.reversibility}. Source: ${s.source === 'assumed' ? 'ASSUMED by the mock engine, not stated by the founder' : s.source}.`,
  ].join('\n');
}

export { founderLine };
