import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CFG, debateDir } from '../config.ts';
import { Debates, Events, type DebateRow } from '../db.ts';
import { Hub } from '../sse.ts';
import { agentsAreFake, runAgent, runJsonAgent, Usage, SearchSeen, abortDebate, abortedByUser, isTurnTimeout, asUsageLimit, AgentAuth, debateProvider, CredentialError, LimitLatch, throwIfLimited, type UsageLimitError } from '../agents/sdk.ts';
import {
  MARCUS, PALETTE,
  floorSuffix, closingSuffix, interjectSuffix, deskAnswerDirection,
  marcusSystem, marcusPlanPrompt, marcusClosingSay,
  intakeSystem, intakePrompt, intakeAnswersPrompt, intakeRevisePrompt,
  architectSystem, architectPrompt, architectRevisePrompt, architectScoutQuestion,
  cruxMatchSystem, cruxMatchPrompt, fenceUntrusted,
  summonSystem, summonPrompt,
  reportSystem, reportPrompt,
  positionCardSystem, positionCardPrompt, cardConsensusSystem, cardConsensusPrompt, contrarianAddendum,
  redTeamSystem, redTeamRulingPrompt, redTeamReportPrompt,
  personaSystem, personaPrompt, relationshipsSystem, relationshipsPrompt, stanceClerkSystem, stanceClerkPrompt,
  reactionSystem, reactionPrompt, chairLinePrompt, marcusVoice,
  type TurnSpec,
} from '../agents/prompts.ts';
import { checkDiversity, parseDossier, voiceCard, type PanelEntry } from '../realism/dossier.ts';
import { checkRealitySeat, costOfBeingWrong, resolveStakes, rulingOwner, stakesBlock, type StakesDraft } from '../realism/stakes.ts';
import { ledgerChairTriggers, newLedger, ownBelief, reduceLedger, STANCE_LABEL, type LedgerEmit, type LedgerInput } from '../realism/ledger.ts';
import { ruleTics } from '../realism/lint-rules.ts';
import { claimTag, indexProvenance, labelPersonaDerived, personaClaims, personaTexts, regradeClaims, type Provenance } from '../realism/evidence.ts';
import { dissentRecord, diversityFlag, mindChangeSections, realismMaterial, reputations, stakesLines, stanceReport, triggerLine } from './minds.ts';
import { plannedEvents, runFloor, windDown, type FloorHost, type GenerateRequest, type GeneratedTurn, type PerformPlan } from './floor.ts';
import { DIRECTOR_RULES, newFloor as newDirectorFloor, splitSentences, type DirectorSeat, type Reaction } from './director.ts';
import { clockLine, slotSecFor } from '../realism/stakes.ts';
import { founderLine, buildRoomBlocks, claimsRecord, computeStats, numericClaims, reportMaterial, sessionSources, appendTranscriptFile, initTranscriptFile, writeAgentsFile } from './transcript.ts';
import { splitTrailer, TrailerStreamFilter } from './trailer.ts';
import { lintAndRewrite, WORD_BUDGET, type LintContext, type LintShape, type Rewriter } from './lint.ts';
import { ANTITHESIS_ALL } from '../../../shared/lexicon.ts';
import { forgetResearch, runResearch } from '../research/index.ts';
import { gateQuestion, scrubForWeb } from '../research/gate.ts';
import { RESEARCH_LIMITS, ResearchMeter } from '../research/meter.ts';
import type { KnownBrief, ResearchRequest } from '../research/types.ts';
import type { Citation, ResearchResult } from '../../../shared/research.ts';
import { analyzeContext, saveContextFiles, countContextFiles, runQuant, runAudit, computeTools, contextDir, workDir, type AuditResult } from '../context.ts';
import { projectTurns, scopeFrom } from '../scope.ts';
import { budgetSnapshot, billingOf, ceilingOf, ceilingQuestion, CEILING_STOP, nextLimitTry, pickProfile, profileOf } from '../budget.ts';
import { BUDGET_PROFILES, QUOTA, motionAllowance, type LengthSpec } from '../../../shared/budget.ts';
import { isWasteGuard } from '../agents/waste.ts';
import { runMotion, type MotionHost, type MotionState, type Defeater } from './motions.ts';
import { DEPTH, SCOPE_LIMITS, type AgendaItem, type Decision } from '../../../shared/types.ts';
import { type BudgetProfile, type BudgetSnapshot, type UsageTotals, type Casting, type ComplexityRead, type DebateConfig, type DebateEvent, type DebateStatus, type Dossier, type FloorState, type Persona, type Plan, type PositionCard, type SessionScope, type Stance } from '../../../shared/types.ts';
import { modelFor, modelName, providerOfConfig, PROVIDER_LABEL, SEAT_TIER, type Provider, type Seat } from '../../../shared/models.ts';
import type { ReportData } from '../../../shared/report-types.ts';
import { friendlyError } from '../friendly.ts';

const rid = (p: string) => `${p}_${crypto.randomBytes(6).toString('base64url')}`;

/**
 * Speaker ids the transcript already means something by. A persona minted with
 * one of these is not merely confusing: the client drops every message from
 * 'quant' on the floor, because the desk renders as a computation card instead
 * of a bubble, so an expert who happened to be called that would go completely
 * silent in the UI while still costing a turn.
 */
const RESERVED_IDS = new Set(['marcus', 'user', 'research', 'quant']);

/**
 * How many desk calls the floor may make in one round, on top of the chair's.
 *
 * Not a cost guard, a pacing one: the room stops and waits for every one of
 * them, and a round in which four people each halt the meeting to compute
 * something stops being an argument. Two is enough for a contested figure and
 * its rebuttal.
 */
const DESK_CALLS_PER_ROUND = 2;
/** How many times one clarify answer may be amended before the batch closes. */
const AMEND_LIMIT = 20;
/** Research on the Codex door holds the credential's queue, and with it the floor; it gets a shorter leash. */
const CODEX_RESEARCH_MS = 4 * 60_000;
/** How long a motion waits for research on it before it is ruled with the evidence marked pending. */
const RULING_WAITS_FOR_RESEARCH_MS = 150_000;

/**
 * What a session looked like before the founder could size one: a panel the
 * architect chose freely, eight motions, and a motion that ran until the
 * referee ran out of things to say. Applied only to debates that started under
 * those rules, so nothing in flight changes shape underneath its own run.
 */
/** Coerce the analyst's complexity read into something the sizer can trust. */
function sanitizeComplexity(raw: any): ComplexityRead {
  const depth = ['quick', 'standard', 'exhaustive'].includes(raw?.depth) ? raw.depth : 'standard';
  return {
    decisions: Math.max(1, Math.min(10, Math.round(Number(raw?.decisions) || 2))),
    disciplines: Math.max(3, Math.min(14, Math.round(Number(raw?.disciplines) || 5))),
    depth,
    rationale: String(raw?.rationale ?? '').slice(0, 600),
  };
}

/**
 * Coerce one expert's position card into something safe to freeze into their
 * prompt for the rest of the session.
 *
 * A card with no thesis or no falsifier is worse than no card at all: the
 * concession rule that rides with it says an expert may only give ground by
 * naming their falsifier, so an empty falsifier would leave that seat unable to
 * lose an argument at all. Those are dropped and the expert simply speaks
 * without a card, which is exactly how the room worked before this existed.
 */
function sanitizePositionCard(raw: any): PositionCard | null {
  const str = (v: any, cap: number) => String(v ?? '').trim().slice(0, cap);
  const thesis = str(raw?.thesis, 600);
  const falsifier = str(raw?.falsifier, 600);
  if (!thesis || !falsifier) return null;
  return {
    thesis,
    loadBearingClaims: (Array.isArray(raw?.load_bearing_claims) ? raw.load_bearing_claims : [])
      .map((c: any) => str(c, 400))
      .filter(Boolean)
      .slice(0, 5),
    redLine: str(raw?.red_line, 500),
    falsifier,
    expectWrong: str(raw?.who_i_expect_to_be_wrong, 400),
  };
}

const LEGACY_SCOPE: SessionScope = {
  experts: 12,
  motions: 8,
  roundsPerMotion: 3,
  depth: 'standard',
  rationale: 'Started before sessions were sized; running on the original fixed shape.',
  estimate: { turns: 0, lowUsd: 0, highUsd: 0, basis: 'not estimated' },
};

/** What a parked debate tells the room when its provider has no credential. */
const CREDENTIAL_MISSING: Record<Provider, string> = {
  claude: 'PAUSED. The Claude CLI is not signed in. Run `claude` once to sign in, then reopen this debate; it resumes where it stopped.',
  anthropic: 'PAUSED. This debate runs on a Claude API key and no ANTHROPIC_API_KEY is configured. Add it to .env, press Re-check on the Connect screen, and reopen this debate; it resumes where it stopped.',
  openai: 'PAUSED. This debate runs on the OpenAI API and no OPENAI_API_KEY is configured. Add it to .env, press Re-check on the Connect screen, and reopen this debate; it resumes where it stopped.',
  codex: 'PAUSED. This debate runs on your Codex login and none was found. Run `codex login`, then reopen this debate; it resumes where it stopped.',
};

/**
 * Why each seat runs on its tier, for the casting sheet shown in the room.
 */
const SEAT_WHY: Record<Seat, string> = {
  chair: 'Marcus chairs on the flagship model, always.',
  floor: 'Every expert speaking turn is where the thinking happens, so it gets the flagship model.',
  ruling: 'The rulings are the deliverable; they get the flagship model.',
  referee: 'The referee decides whether each argument is settled, so it reasons at full depth.',
  report: 'The founder acts on this document.',
  quant: 'Computing figures from your files, and auditing them, needs the deepest reasoning.',
  summon: 'Designing an expert to seat mid-session is chair-level judgement.',
  research: 'Fact-finding needs care but not frontier reasoning.',
  dossier: 'Reading and distilling the uploaded files rewards care over raw depth.',
  repair: 'Copy-fitting a report that overflowed the page is bounded work.',
  react: 'How the listeners react to a turn is a quick read, not an argument, so it runs on the fast model.',
  lint: 'Rewriting the form of a turn that reads like a memo changes no substance, so it runs on the fast model and is checked by code.',
  clerk: 'Reading starting stances off the position cards and matching research findings to the experts\' cruxes is classification, not argument, so it runs on the fast model.',
  persona: 'Writing each expert\'s history, stakes and voice is careful writing done once per session, so it runs on the balanced model.',
};

/**
 * Mend a report the print gate measured as broken.
 *
 * The founder's standing rule is that a layout fault must never reach him:
 * "we can never have them". The gate already SEES every fault; what was
 * missing was the hand that fixes one. Faults are almost never the template
 * being wrong in the abstract — they are a value the writer chose that the
 * page cannot hold, so the repair edits the DATA and leaves the template
 * alone. The balanced tier, low thinking, one turn: this is a copy-fitting job, not an
 * analysis. Returns null rather than throwing, because a failed repair must
 * cost the founder nothing but the fault he already had.
 */
/**
 * What actually happened to the numbers audit — three states, because the old
 * two (result | null) collapsed "nothing to audit" and "the checker crashed"
 * into the same silent null, and the report rendered identically for both.
 */
type AuditOutcome =
  | { kind: 'ok'; audit: AuditResult }
  | { kind: 'skipped' }
  | { kind: 'failed'; reason: string };

async function repairReportData(model: string, data: ReportData, faults: string, debateId: string): Promise<ReportData | null> {
  try {
    const { value } = await runJsonAgent<ReportData>({
      model,
      system: [
        'You repair the DATA of a business report so it fits a printed A4 page. You never change what the report says.',
        '',
        'A layout probe measured the rendered document and found faults. Fix them by shortening or restructuring the offending VALUES.',
        '',
        'Rules:',
        '- Meaning is sacred. Never change a number, a verdict, a name, or the substance of a sentence.',
        '- "overflow" or "svg-escape" on chart text means a label or unit is too long for its box. A chart `unit` must be a SYMBOL ("$", "%", "INR"), at most 3 characters. If the writer put a phrase there ("USD per complete lead"), move it into `xLabel`/`yLabel` and leave `unit` as the bare symbol.',
        '- A point/series `label` longer than about 24 characters must be shortened to its distinguishing words.',
        '- A table cell or column header that overflows is shortened; the full text may move into the table `note`.',
        '- "overlap" or "illegible" usually means too many series or points. Keep the most significant and say what was dropped in the chart `insight`.',
        '- Change nothing that was not named in the faults.',
        '',
        'Return the COMPLETE repaired report object as strict JSON, same schema, every field present.',
      ].join('\n'),
      prompt: `LAYOUT FAULTS MEASURED IN THE RENDERED DOCUMENT:\n${faults}\n\nTHE REPORT DATA TO REPAIR:\n${JSON.stringify(data)}`,
      thinking: 2_000,
      maxTurns: 4,
      timeoutMs: 5 * 60_000,
      debateId,
      label: 'report:repair',
    });
    // A repair that lost the report is not a repair.
    if (!value || typeof value !== 'object' || !value.title || !Array.isArray(value.decisions)) return null;
    return value;
  } catch (err) {
    console.error('[report] repair pass failed:', err);
    return null;
  }
}

/** The audit, phrased as an instruction to the report writer. */
function auditBrief(a: AuditResult): string {
  const wrong = a.findings.filter((f) => f.verdict === 'wrong');
  return [
    "NUMBERS AUDIT. Every figure the panel committed to was recomputed from the founder's source files after the room closed, and every claim the room derived from one was re-derived. This is not another opinion from the table; it is arithmetic, and it outranks anything in the transcript.",
    `Checked: ${a.checked}. Wrong: ${wrong.length}.`,
    a.summary,
    ...a.findings.map((f) => `- [${f.verdict.toUpperCase()}] ${f.figure} -> ${f.recomputed}${f.impact ? ` (${f.impact})` : ''}`),
    /**
     * "Do not correct it silently" is the load-bearing sentence. A corrected
     * figure that appears without its correction reads to the founder as
     * something his panel got right, and he will cite it as such.
     */
    wrong.length
      ? "Where an audited figure differs from the panel's, use the audited one, and say plainly in the report that the panel had it wrong and what that changes. This applies to a wrong DERIVATION exactly as it applies to a wrong input: if the room's arithmetic was consistent but the step was not — a rate on the wrong base, a payback struck before costs later in the chain — print the corrected figure, name the step, and carry the correction through every conclusion that leaned on it. Do not correct it silently: the founder needs to know which of his panel's conclusions rested on a bad number."
      : "The panel's figures survived recomputation and its derivations survived re-derivation. Say so where it matters; a spine that was checked is worth more than one that was merely argued.",
  ].join('\n');
}

type UserSignal =
  | { kind: 'answer'; questionId: string; answer: string }
  | { kind: 'approve'; stage: 'goal' | 'panel' | 'plan'; action: 'approve' | 'revise'; feedback?: string }
  | { kind: 'end' }
  | { kind: 'resume' };

const TERMINAL: DebateStatus[] = ['complete', 'error', 'cancelled'];
/** Before the meeting: ending here cancels rather than writing a report about nothing. */
const SETUP: DebateStatus[] = ['intake', 'clarifying', 'goal_approval', 'panel_design', 'panel_approval', 'planning', 'plan_approval'];

export class DebateRun {
  readonly id: string;
  row: DebateRow;
  private waiter: ((s: UserSignal) => void) | null = null;
  private driving = false;
  private killed = false;
  /** Research running in this process, by request id; the persisted list is meta.researchInflight. */
  private researchRuns = new Map<string, Promise<void>>();
  /** Cancels every research run when the debate is killed. */
  private researchAbort = new AbortController();
  private researchResumed = false;
  /** The motion currently on the floor, so a speaker's context can be scoped to it. */
  private activeMotionId: string | null = null;
  /** Seq where wrapup began: the boundary for closing-statement context. */
  private wrapStartSeq: number | null = null;
  /** Pending auto-resume after a usage limit; cleared on resume or stop. */
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set when this debate must not run because its credential cannot be produced. */
  private credentialError: string | null = null;
  private computeInflight = 0;
  /** Desk calls the floor has made in the current motion round; see DESK_CALLS_PER_ROUND. */
  private deskCalls: { key: string; used: number } = { key: '', used: 0 };

  constructor(id: string) {
    this.id = id;
    this.row = Debates.get(id)!;
    this.bindCredential();
    // Token ledger: restore after restart, stream every turn's totals live,
    // and checkpoint to meta so nothing is lost if the process dies.
    Usage.seed(id, this.row.meta.usage);
    // A limit pause outlives the process that started it.
    if (this.row.meta.limitPause && this.row.status === 'paused') this.scheduleLimitResume();
    Usage.seedRoles(id, this.row.meta.spendByRole ?? {});
    Usage.subscribe(id, (usage) => {
      this.live({ type: 'usage', usage });
      this.row.meta.usage = usage;
      this.row.meta.spendByRole = Usage.byRole(id);
      // A turn landed, so whatever allowance we were waiting on has cleared.
      if (this.row.meta.limitPause && this.row.status !== 'paused') this.clearLimitPause();
      if (usage.turns % 5 === 0) this.saveMeta();
      this.budgetTick(usage);
    });
  }

  /**
   * Bind this debate to its provider before a single turn is spawned. If the
   * provider's credential is not available on this machine (no
   * OPENAI_API_KEY, no `codex login`), the debate parks with an explanation
   * instead of failing mid-turn; retryCredential() picks it up again.
   *
   * This runs in the constructor, which runs for every unfinished debate at
   * boot, so it must never throw.
   */
  private bindCredential() {
    // Scripted models (MOCK=1, the engine test) need no credential on any door.
    const ok = AgentAuth.bind(this.id, this.provider) || agentsAreFake();
    this.credentialError = ok ? null : CREDENTIAL_MISSING[this.provider];
    if (!ok) console.log(`[debate ${this.id}] parked: ${this.provider} credential not available`);
  }

  /**
   * Re-check a parked debate's credential (called when the debate is opened).
   * True only when this call actually unparked the debate.
   */
  retryCredential(): boolean {
    if (!this.credentialError) return false;
    this.bindCredential();
    if (this.credentialError) return false;
    this.system('Credential found. The session resumes.');
    void this.drive();
    return true;
  }

  // ---------- persistence helpers ----------

  private refresh() {
    this.row = Debates.get(this.id)!;
  }
  private saveMeta() {
    Debates.patch(this.id, { meta: this.row.meta });
  }
  private setStatus(status: DebateStatus) {
    /**
     * The founder has paused (P4). Whatever step was running has finished its
     * in-flight work; where it would go next is where Resume goes, and the
     * room stays paused until then. An error is still an error.
     */
    const fp = this.row.meta.founderPause;
    if (fp && this.row.status === 'paused' && status !== 'paused' && status !== 'error') {
      fp.resumeTo = status;
      this.saveMeta();
      return;
    }
    this.row.status = status;
    Debates.patch(this.id, { status });
    this.publish({ type: 'status', status });
  }
  private publish(ev: any) {
    if (this.killed) return ev;
    return Hub.publish(this.id, ev);
  }
  private system(text: string) {
    this.publish({ type: 'system', text });
  }

  /**
   * User signals are buffered: if one arrives in the window between publishing
   * a question/approval and the engine actually awaiting it, it must not drop
   * (a dropped signal would hang the debate until the next user action).
   */
  private signalQueue: UserSignal[] = [];
  private waitUser(): Promise<UserSignal> {
    const queued = this.signalQueue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => (this.waiter = resolve));
  }
  private signal(s: UserSignal) {
    const w = this.waiter;
    if (w) {
      this.waiter = null;
      w(s);
    } else {
      this.signalQueue.push(s);
    }
  }

  get experts(): Persona[] {
    return this.row.personas.filter((p) => !p.isModerator);
  }

  /**
   * What a claim graded observed can be traced to (realism/evidence.ts): the
   * founder's own brief, answers and uploads, and the research desk's citation
   * ids. Anything else a persona calls observed is its backstory or a guess.
   */
  private provenance(events: DebateEvent[] = Events.since(this.id, 0)): Provenance {
    const meta = this.row.meta;
    return {
      founder: [
        this.row.topic,
        ...Object.values(meta.clarifyAnswers ?? {}),
        meta.contextBrief ?? '',
        ...events.flatMap((e) => (e.type === 'answer' ? [e.answer] : [])),
      ],
      citations: sessionSources(this.row).map((c) => c.id),
      measured: (meta.computations ?? []).some((c) => c.computable),
      panel: this.experts.map((p) => p.name),
      personaSoFar: personaTexts(events),
    };
  }

  // ---------- public API (called from routes) ----------

  start() {
    void this.drive();
  }

  answer(questionId: string, answer: string): 'ok' | 'amended' | 'consumed' {
    const meta = this.row.meta;
    const isClarify = meta.pendingClarify.includes(questionId);
    const isQuestion = meta.pendingQuestionId === questionId;
    /**
     * A clarify answer already given but not yet consumed by intake: the
     * founder walked Back in the batch and changed his mind. Overwrite and
     * republish so every client shows the amended answer. `clarifyQs` is the
     * commit marker — intakeStep() clears it (with clarifyAnswers) the moment
     * it reads the answers, so after that this is 'consumed', not 'amended'.
     */
    const isAmend =
      !isClarify && !isQuestion &&
      meta.clarifyQs.some((q) => q.id === questionId) &&
      Object.prototype.hasOwnProperty.call(meta.clarifyAnswers, questionId);
    if (!isClarify && !isQuestion && !isAmend) return 'consumed';
    /**
     * An amend is capped, because every one appends a persisted event row and
     * nothing else rate-limits this route: unlimited re-answers are a scripted
     * write loop against the database and the disk. Twenty changes of mind on
     * one question is far past anything a person does.
     */
    if (isAmend) {
      const n = (meta.amendCounts ??= {});
      if ((n[questionId] = (n[questionId] ?? 0) + 1) > AMEND_LIMIT) return 'consumed';
    }
    this.publish({ type: 'answer', questionId, answer });
    if (isClarify || isAmend) {
      meta.clarifyAnswers[questionId] = answer;
      meta.pendingClarify = meta.pendingClarify.filter((q) => q !== questionId);
    } else {
      meta.pendingQuestionId = null;
      /**
       * The room's record of what the founder said. Without this line the
       * transcript showed experts reacting to answers that were not there.
       * Clarify answers come before the file exists and go into its header.
       */
      appendTranscriptFile(this.id, `**${founderLine(CFG.founderName)}:** ${answer}`);
    }
    this.saveMeta();
    /**
     * An amend changes no count of open questions, so the 'clarifying' wait
     * loop has nothing to re-check, and a signal fired after the driver moved
     * on would leak into whichever waitUser() runs next. Do not wake anyone.
     */
    if (!isAmend) this.signal({ kind: 'answer', questionId, answer });
    return isAmend ? 'amended' : 'ok';
  }

  approve(stage: 'goal' | 'panel' | 'plan', action: 'approve' | 'revise', feedback?: string): boolean {
    if (this.row.meta.pendingApproval !== stage) return false;
    this.signal({ kind: 'approve', stage, action, feedback });
    return true;
  }

  /**
   * End means "stop arguing and write it up" — it has never meant "destroy the
   * deliverable", and it must not be able to.
   *
   * A real session died here. The founder pressed End; the room correctly left
   * the meeting, ran its closings, and reached the report. He pressed End
   * again (reasonably — nothing looked like it had stopped), and that second
   * abort landed on the REPORT agent five minutes later. The run froze in
   * 'reporting' with nothing in flight and no document, after the whole
   * session had been paid for.
   *
   * So the abort is scoped to the phase it belongs to. Once the room is
   * wrapping up or writing, End is acknowledged and does nothing else: the
   * founder has already been obeyed, and the only thing left to interrupt is
   * the thing he is waiting for. Abandoning outright is a separate, explicit
   * act (cancel), not the fifth press of a button that looked stuck.
   */
  end(): { ok: true; already: boolean } {
    const WRITING = new Set(['wrapup', 'reporting', 'complete']);
    // Paused, the step it would go back to decides what End means.
    const fp = this.row.status === 'paused' ? this.row.meta.founderPause : null;
    if (WRITING.has(fp ? fp.resumeTo : this.row.status)) {
      this.system('Already wrapping up. The report is being written — this cannot be interrupted without losing it.');
      return { ok: true, already: true };
    }
    if (this.row.meta.endedByUser) {
      this.system('Stop already requested. The room is finishing its closing statements.');
      return { ok: true, already: true };
    }
    this.row.meta.endedByUser = true;
    this.saveMeta();
    // Kill argument turns in flight. An expert or referee call can run for
    // minutes; without this the stop request queues behind it and the room
    // keeps arguing after the founder has asked it to stop.
    const killed = abortDebate(this.id);
    this.system(
      killed
        ? `Stopping. ${killed} turn${killed === 1 ? '' : 's'} cancelled. The panel will give closing statements and then write your report — this takes a few minutes and cannot be skipped.`
        : 'Stopping. The panel will give closing statements and then write your report — this takes a few minutes.'
    );
    if (fp) {
      // Ended while paused: before the meeting that cancels, from the meeting on it goes to the closings.
      this.row.meta.founderPause = null;
      this.saveMeta();
      this.setStatus(SETUP.includes(fp.resumeTo) ? 'cancelled' : 'wrapup');
      this.openResumeGate();
      if (!this.driving) void this.drive();
    }
    this.signal({ kind: 'end' });
    return { ok: true, already: false };
  }

  /**
   * Pause, at any step until the report is done (P4).
   *
   * It used to be allowed only in the meeting, and it worked by making the
   * motion engine believe the session had stopped, which the motion engine
   * read as "rule now and close": in the 2026-10-28 real run a pause during
   * the adversary's round closed the motion and Resume opened the next one.
   * Now a pause never closes or advances anything. A call already in flight
   * finishes (a written turn not yet heard is dropped unheard), the step it
   * was on is persisted, and Resume goes back to exactly that step.
   */
  pause(): boolean {
    const from = this.row.status;
    if (TERMINAL.includes(from) || from === 'paused') return false;
    this.row.meta.founderPause = { since: Date.now(), resumeTo: from };
    this.saveMeta();
    this.row.status = 'paused';
    Debates.patch(this.id, { status: 'paused' });
    this.publish({ type: 'status', status: 'paused' });
    this.system('Session paused by the founder. Anything already being written finishes; nothing new starts until you resume.');
    return true;
  }

  /** The driver waits here while the founder has paused. */
  private resumeGate: (() => void) | null = null;
  private waitForResume(): Promise<void> {
    return new Promise((resolve) => { this.resumeGate = resolve; });
  }
  private openResumeGate() {
    const g = this.resumeGate;
    this.resumeGate = null;
    g?.();
  }

  resumeMeeting(): boolean {
    if (this.row.status !== 'paused') return false;
    const fp = this.row.meta.founderPause;
    if (fp) {
      this.row.meta.founderPause = null;
      this.saveMeta();
      this.setStatus(fp.resumeTo);
      this.system('Session resumed.');
      this.openResumeGate();
      if (!this.driving) void this.drive();
      return true;
    }
    // A human chose to carry on; drop the scheduled wake so it cannot fire
    // later and re-enter a session that is already running. A limit pause
    // goes back to the step it interrupted, which need not be the meeting.
    const lp = this.row.meta.limitPause;
    this.resumeTo = lp?.resumeTo ?? null;
    this.clearLimitPause();
    LimitLatch.clear(this.id);
    if (lp) this.publish({ type: 'quota', pause: null });
    this.signal({ kind: 'resume' });
    // A limit pause leaves nobody driving; without this the click was queued and never read.
    if (!this.driving) void this.drive();
    return true;
  }
  /** Where a resumed limit pause goes back to; null means the meeting. */
  private resumeTo: DebateStatus | null = null;

  kill() {
    this.killed = true;
    this.researchAbort.abort();
    if (this.limitTimer) { clearTimeout(this.limitTimer); this.limitTimer = null; }
    this.signal({ kind: 'end' });
    this.openResumeGate();
  }

  /**
   * The allowance is spent. Park, say so, and come back on our own.
   *
   * This used to reach the driver's generic catch and mark the session
   * `error`, which threw away every argued motion because a clock ran out.
   * The session is parked as `paused` instead, which is a state the UI already
   * understands and offers a Resume button for, and a timer brings it back at
   * the reset time the provider stated (a reset clock, or a Retry-After), or
   * on a capped backoff when it stated none. Wherever it was (setup, the
   * meeting, wrap-up, the report), it goes back to exactly that step.
   */
  private parkForLimit(err: UsageLimitError) {
    const meta = this.row.meta;
    const prev = meta.limitPause;
    const attempts = (prev?.attempts ?? 0) + 1;
    const from = this.row.status;
    // A limit that lands while the founder has paused takes the pause over, going back to the same step.
    const fp = meta.founderPause;
    meta.founderPause = null;
    const resumeTo: DebateStatus = from === 'paused' ? fp?.resumeTo ?? prev?.resumeTo ?? 'meeting' : from;
    meta.limitPause = { since: prev?.since ?? Date.now(), resetAt: err.resetAt, kind: err.kind, attempts, resumeTo };
    meta.limitPause.nextTryAt = nextLimitTry(meta.limitPause);
    this.saveMeta();
    LimitLatch.clear(this.id);   // the pause holds the room now; the next call after it is a real try
    Debates.patch(this.id, { status: 'paused' });
    this.row.status = 'paused';
    this.publish({ type: 'status', status: 'paused' });
    this.publish({ type: 'quota', pause: { resumesAt: meta.limitPause.nextTryAt, kind: err.kind, stated: err.resetAt !== null } });

    const when = new Date(meta.limitPause.nextTryAt).toLocaleString(undefined, { hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' });
    const who = PROVIDER_LABEL[this.provider] ?? 'provider';
    // Only the Claude sign-in has a 5-hour window; an API key has a usage limit.
    const label = err.kind === 'weekly' ? `weekly ${who} limit` : err.kind === 'session' && this.provider === 'claude' ? `5-hour ${who} limit` : `${who} usage limit`;
    this.system(err.resetAt
      ? `Paused: waiting for quota. Your ${label} is spent; nothing is lost and nothing is cut. The session resumes on its own around ${when}.`
      : `Paused: waiting for quota. Your ${label} is spent; nothing is lost and nothing is cut. The provider gave no reset time, so the room tries again around ${when} and backs off from there.`);
    this.scheduleLimitResume();
  }

  /** One wake at the persisted next try (the stated reset, or the backoff). */
  private scheduleLimitResume() {
    const lp = this.row.meta.limitPause;
    if (!lp || this.killed) return;
    if (this.limitTimer) clearTimeout(this.limitTimer);

    /**
     * A bound, because a revoked or downgraded credential produces a limit
     * error that never clears, and a session retrying it forever is a slow
     * leak of nobody's benefit. Longer than a weekly window, so a weekly
     * limit is always waited out.
     */
    if (Date.now() - lp.since > QUOTA.giveUpAfterMs) {
      this.system(`This session has waited on a provider limit for ${Math.round(QUOTA.giveUpAfterMs / 86_400_000)} days without it clearing, which is a credential problem rather than a window. It is stopping here; everything decided so far is saved.`);
      this.row.meta.limitPause = null;
      this.saveMeta();
      Debates.patch(this.id, { status: 'error' });
      this.publish({ type: 'status', status: 'error' });
      return;
    }

    const wait = Math.max(QUOTA.minWaitMs, (lp.nextTryAt ?? nextLimitTry(lp)) - Date.now());
    console.log(`[debate ${this.id}] limit pause: resuming in ${Math.round(wait / 60_000)} min (attempt ${lp.attempts})`);
    this.limitTimer = setTimeout(() => {
      this.limitTimer = null;
      this.refresh();
      const cur = this.row.meta.limitPause;
      if (this.killed || this.row.status !== 'paused' || !cur) return;
      const to = cur.resumeTo ?? 'meeting';
      LimitLatch.clear(this.id);
      this.system('Trying again: the usage window should have reset.');
      this.publish({ type: 'quota', pause: null });
      this.row.status = to;
      Debates.patch(this.id, { status: to });
      this.publish({ type: 'status', status: to });
      void this.drive();
    }, wait);
  }

  /** A turn succeeded, so whatever limit we were waiting on has cleared. */
  private clearLimitPause() {
    if (!this.row.meta.limitPause) return;
    this.row.meta.limitPause = null;
    this.saveMeta();
    if (this.limitTimer) { clearTimeout(this.limitTimer); this.limitTimer = null; }
  }

  // ---------- main driver ----------

  async drive() {
    if (this.driving || this.killed) return;
    if (this.credentialError) {
      /**
       * Parked, not failed. The status is left exactly where it was so the
       * session resumes from the same point when the credential becomes
       * available; only the message tells anyone watching why the room has
       * gone quiet.
       */
      if (!TERMINAL.includes(this.row.status)) this.system(this.credentialError);
      return;
    }
    this.driving = true;
    this.resumeResearch();
    try {
      while (!this.killed) {
        this.refresh();
        const st = this.row.status;
        if (TERMINAL.includes(st)) break;
        throwIfLimited(this.id);   // a limit a step swallowed still pauses before the next step

        switch (st) {
          case 'intake': await this.intakeStep(); break;
          case 'clarifying': {
            if (this.row.meta.pendingClarify.length === 0) { this.setStatus('intake'); break; }
            const sig = await this.waitUser();
            if (sig.kind === 'end') { this.setStatus('cancelled'); this.system('Session cancelled.'); }
            break;
          }
          case 'goal_approval': await this.approvalWait('goal', 'panel_design', 'intake', 'reviseFeedback'); break;
          case 'panel_design': await this.panelStep(); break;
          case 'panel_approval': await this.approvalWait('panel', 'planning', 'panel_design', 'architectFeedback'); break;
          case 'planning': await this.planningStep(); break;
          case 'plan_approval': await this.approvalWait('plan', 'meeting', 'planning', 'planFeedback'); break;
          case 'meeting': this.castingStep(); await this.positionCardsStep(); await this.meetingLoop(); break;
          case 'paused': {
            // The founder's pause: Resume (or End) sets the status and opens the gate; no user signal is involved.
            if (this.row.meta.founderPause) { await this.waitForResume(); break; }
            const sig = await this.waitUser();
            const back = this.resumeTo;
            this.resumeTo = null;
            if (sig.kind === 'end' || this.row.meta.endedByUser) { this.setStatus(back === 'reporting' ? 'reporting' : 'wrapup'); this.system('Session ended by the founder. Moving to closing statements.'); }
            else { this.setStatus(back ?? 'meeting'); this.system('Session resumed.'); }
            break;
          }
          case 'wrapup': await this.wrapupStep(); break;
          case 'reporting': await this.reportStep(); break;
          default: throw new Error(`unknown status ${st}`);
        }
      }
    } catch (err) {
      // A turn cancelled by the user is a stop, not a crash.
      // A spent allowance after a stop still parks: the closings and report it interrupted must happen.
      if (this.killed || (!asUsageLimit(err) && (this.row.meta.endedByUser || abortedByUser(err)))) {
        const to: DebateStatus = this.row.meta.closedMotions.length ? 'wrapup' : 'cancelled';
        this.system(to === 'wrapup'
          ? 'Session ended by the founder. Moving to closing statements.'
          : 'Session cancelled before the panel reached the floor.');
        Debates.patch(this.id, { status: to });
        this.publish({ type: 'status', status: to });
        /**
         * Re-entering the driver is what lets a stopped session still produce
         * closing statements and a report. It is also a loop if the thing that
         * failed is the report itself, so it is allowed exactly once per
         * session: a second pass through here means wrapup could not get past
         * reporting, and going round again would just re-run the most
         * expensive agent in the app forever.
         */
        if (to === 'wrapup' && !this.killed && !this.row.meta.wrapupRetried) {
          this.row.meta.wrapupRetried = true;
          this.saveMeta();
          this.driving = false;
          void this.drive();
          return;
        }
      } else if (asUsageLimit(err)) {
        this.parkForLimit(asUsageLimit(err)!);
      } else if (isWasteGuard(err) && !this.row.meta.wrapupRetried && this.row.status === 'meeting' && this.row.meta.closedMotions.length) {
        /**
         * A stage tried to re-run a call whose answer already exists: a loop.
         * The argument so far is kept and written up, once; a second trip here
         * falls through to the honest error below.
         */
        console.error(`[debate ${this.id}] loop guard:`, err);
        this.system('The room started repeating a step it had already finished. Moving to closing statements and the report with everything argued so far.');
        this.row.meta.wrapupRetried = true;
        this.saveMeta();
        Debates.patch(this.id, { status: 'wrapup' });
        this.publish({ type: 'status', status: 'wrapup' });
        this.driving = false;
        void this.drive();
        return;
      } else if (isTurnTimeout(err)) {
        /**
         * Out of time is not out of order. The session keeps whatever it has
         * (every ruling is already persisted) and stops honestly, instead of
         * being described to the founder as something he did.
         */
        console.error(`[debate ${this.id}] turn timeout:`, err);
        this.system(`A step ran out of time: ${String((err as Error).message).slice(0, 200)}. The session is stopping here; everything decided so far is saved.`);
        this.publish({ type: 'error', message: String((err as Error).message).slice(0, 500) });
        Debates.patch(this.id, { status: 'error' });
        this.publish({ type: 'status', status: 'error' });
      } else if (err instanceof CredentialError) {
        /**
         * The provider refused the credential. Park: status untouched, the
         * message explains, retryCredential() resumes it when reopened.
         */
        console.log(`[debate ${this.id}] parked: credential refused mid-session`);
        const how: Record<Provider, string> = {
          claude: 'run `claude` in a terminal and sign in again',
          anthropic: 'check ANTHROPIC_API_KEY in .env and its credit in the Anthropic Console',
          codex: 'run `codex login` again',
          openai: 'check OPENAI_API_KEY in .env and its credit with OpenAI',
        };
        this.credentialError =
          'PAUSED. The provider refused this session\'s credential (revoked, expired, or out of credit). ' +
          `To fix it, ${how[this.provider]}, press Re-check on the Connect screen, and reopen this debate.`;
        this.system(this.credentialError);
      } else {
        console.error(`[debate ${this.id}] fatal:`, err);
        this.publish({ type: 'error', message: friendlyError(err) });
        Debates.patch(this.id, { status: 'error' });
        this.publish({ type: 'status', status: 'error' });
      }
    } finally {
      this.driving = false;
    }
  }

  // ---------- phases ----------

  private async intakeStep() {
    const meta = this.row.meta;
    const model = this.modelFor('chair');

    // Dossier first: distill uploaded context before anything else reads the topic.
    /**
     * File-level outcomes first, whether or not anything survived to read:
     * "your deck was skipped, here is why" is the difference between you
     * fixing the export and concluding the app is broken.
     */
    if (meta.contextNotes?.length) {
      for (const n of meta.contextNotes) this.system(n);
      meta.contextNotes = [];
      this.saveMeta();
    }
    if (meta.contextFiles > 0 && !meta.contextBrief) {
      this.system(`Dossier analyst reading your uploaded context (${meta.contextFiles} files).`);
      try {
        const brief = await analyzeContext(this.modelFor('dossier'), this.id, this.row.topic);
        meta.contextBrief = brief;
        this.saveMeta();
        this.publish({ type: 'context_brief', files: meta.contextFiles, brief });
      } catch (err) {
        this.system('Dossier analysis failed; continuing without it.');
        meta.contextBrief = null;
        meta.contextFiles = 0;
        this.saveMeta();
      }
    }

    let prompt: string;
    let resume: string | undefined = meta.sessions['_intake'];

    if (meta.reviseFeedback) {
      prompt = intakeRevisePrompt(meta.reviseFeedback);
      meta.reviseFeedback = null;
    } else if (meta.clarifyQs.length && Object.keys(meta.clarifyAnswers).length) {
      const answers = meta.clarifyQs
        .filter((q) => meta.clarifyAnswers[q.id])
        .map((q) => ({ question: q.question, answer: meta.clarifyAnswers[q.id] }));
      prompt = intakeAnswersPrompt(answers);
      meta.clarifyQs = [];
      meta.clarifyAnswers = {};
    } else {
      prompt = intakePrompt(this.row.topic, meta.contextBrief);
      resume = undefined;
      this.system('Intake analysis running. Assessing whether the mission is clear enough to brief a panel.');
    }

    let { value, sessionId } = await runJsonAgent<any>({
      model, system: intakeSystem(), prompt, resume,
      thinking: CFG.turnThinking, debateId: this.id, label: 'intake',
    });
    if (sessionId) meta.sessions['_intake'] = sessionId;

    // Autonomous sessions must never wait on clarifying questions.
    if (!value.clear && this.row.config.autonomy === 'autonomous') {
      ({ value, sessionId } = await runJsonAgent<any>({
        model, system: intakeSystem(),
        prompt: 'AUTONOMOUS SESSION: the founder is unreachable, clarifying questions are impossible. Make the most defensible interpretation of the topic, set clear to true, and fold your assumptions explicitly into the goal statement. Strict JSON.',
        resume: sessionId ?? meta.sessions['_intake'],
        thinking: CFG.turnThinking, debateId: this.id, label: 'intake:auto',
      }));
      if (sessionId) meta.sessions['_intake'] = sessionId;
    }

    // The analyst's read of the ask is captured whether or not it is clear yet,
    // so a re-run after his answers can be compared with what it first thought.
    meta.complexity = sanitizeComplexity(value.complexity);

    if (value.clear && typeof value.goal === 'string' && value.goal.trim()) {
      const title = String(value.title || 'UNTITLED SESSION').slice(0, 60);
      /**
       * Size the session HERE, before a panel exists, because panel size is one
       * of the three things being sized. The founder approves this shape and
       * its projected cost at goal_approval; everything downstream is told the
       * numbers rather than choosing them.
       */
      // 'auto': the intake's read picks the room. Hard or high-stakes calls get the deep one.
      if (this.row.config.profile === 'auto' && meta.profilePick?.source !== 'founder') {
        const pick = pickProfile(meta.complexity, this.row.topic);
        meta.profilePick = { ...pick, source: 'auto' };
      }
      meta.scope = scopeFrom(meta.complexity, this.provider, (meta.contextFiles ?? 0) > 0, this.profile, this.ceilingUsd());
      if (meta.profilePick) meta.scope.estimate.profileReason = meta.profilePick.reason;
      Debates.patch(this.id, { title, goal: value.goal });
      this.row.title = title;
      this.row.goal = value.goal;
      this.publish({ type: 'goal', title, goal: value.goal });
      this.publish({ type: 'scope', scope: meta.scope });
      this.stakesFromIntake(value.stakes);
      this.saveMeta();
      this.setStatus('goal_approval');
    } else {
      const qs: { id: string; question: string }[] = [];
      // How many questions is the analyst's call, not a policy of this file.
      // The slice is a malfunction guard only: a parser hiccup that yields
      // dozens of "questions" must not queue dozens of prompts at the founder.
      for (const q of (value.questions ?? []).slice(0, 12)) {
        const id = rid('q');
        qs.push({ id, question: String(q.question ?? q) });
        this.publish({
          type: 'clarify', questionId: id, question: String(q.question ?? q),
          options: Array.isArray(q.options) ? q.options.map(String).slice(0, 4) : [],
          allowCustom: true,
        });
      }
      if (!qs.length) throw new Error('intake returned neither goal nor questions');
      meta.clarifyQs = qs;
      meta.pendingClarify = qs.map((q) => q.id);
      meta.clarifyAnswers = {};
      this.saveMeta();
      this.setStatus('clarifying');
    }
  }

  /**
   * The stakes (docs/PHASE2-PLAN.md 2d), from what intake read off the brief.
   * Real or marked assumed, never invented: a missing field becomes a stated,
   * conservative assumption and says so in the room's STAKES block. No extra
   * question is asked for a missing field (zero extra steps for the founder;
   * the intake analyst may already have asked one); an autonomous session
   * records each assumption as one, and an interactive founder sees them
   * beside the goal and can revise it.
   */
  private stakesFromIntake(raw: any) {
    const str = (v: any) => (typeof v === 'string' ? v.trim().slice(0, 300) : undefined);
    const draft: StakesDraft = raw && typeof raw === 'object' ? {
      decisionOwner: raw.decisionOwner && typeof raw.decisionOwner === 'object' ? { name: str(raw.decisionOwner.name), role: str(raw.decisionOwner.role) } : undefined,
      decideBy: str(raw.decideBy),
      atRisk: raw.atRisk && typeof raw.atRisk === 'object' ? { money: str(raw.atRisk.money), people: str(raw.atRisk.people), time: str(raw.atRisk.time), reputation: str(raw.atRisk.reputation) } : undefined,
      ifWrong: raw.ifWrong && typeof raw.ifWrong === 'object' ? { yes: str(raw.ifWrong.yes), no: str(raw.ifWrong.no) } : undefined,
      reversibility: raw.reversibility === 'one-way' || raw.reversibility === 'two-way' ? raw.reversibility : undefined,
      from: raw.from === 'dossier' ? 'dossier' : 'founder',
    } : {};
    const res = resolveStakes(draft, { founderName: CFG.founderName ?? undefined });
    this.row.meta.stakes = res.marked;
    this.system(stakesBlock(res.marked));
    if (this.row.config.autonomy === 'autonomous') {
      for (const a of res.assumptions) {
        this.publish({ type: 'assumption', text: a });
      }
    }
  }

  private async approvalWait(
    stage: 'goal' | 'panel' | 'plan',
    advanceTo: DebateStatus,
    backTo: DebateStatus,
    feedbackKey: 'reviseFeedback' | 'architectFeedback' | 'planFeedback'
  ) {
    const meta = this.row.meta;
    meta.pendingApproval = stage;
    this.saveMeta();

    if (this.row.config.autonomy === 'autonomous') {
      this.system(`Auto-approved ${stage} (autonomous session).`);
      meta.pendingApproval = null;
      this.saveMeta();
      this.setStatus(advanceTo);
      return;
    }

    while (true) {
      const sig = await this.waitUser();
      if (sig.kind === 'end') {
        meta.pendingApproval = null;
        this.saveMeta();
        this.setStatus('cancelled');
        this.system('Session cancelled before the meeting started.');
        return;
      }
      if (sig.kind === 'approve' && sig.stage === stage) {
        meta.pendingApproval = null;
        if (sig.action === 'revise') {
          (meta as any)[feedbackKey] = sig.feedback || 'Please revise.';
          this.saveMeta();
          this.system(`Revision requested on ${stage}.`);
          this.setStatus(backTo);
        } else {
          this.saveMeta();
          this.setStatus(advanceTo);
        }
        return;
      }
    }
  }

  private async panelStep() {
    if (this.row.meta.endedByUser || this.killed) return;   // stop requested during setup
    const meta = this.row.meta;
    const model = this.modelFor('chair');
    let prompt: string;
    let resume: string | undefined = meta.sessions['_architect'];

    if (meta.architectFeedback) {
      prompt = architectRevisePrompt(meta.architectFeedback);
      meta.architectFeedback = null;
    } else {
      this.system('Panel architect at work. Researching the domain and designing the expert roster.');
      if (meta.architectLandscape === undefined) {
        meta.architectLandscape = await this.scoutDomain();
        this.saveMeta();
        if (this.row.meta.endedByUser || this.killed) return;
      }
      prompt = architectPrompt(this.row.topic, this.row.goal ?? '', this.scope.experts, this.row.meta.contextBrief, meta.architectLandscape);
      resume = undefined;
    }

    /**
     * The designer reads the dossier brief, so it holds no tools at all: text
     * written from an upload never sits in a seat that can fetch (the web pass
     * is scoutDomain, which never sees the brief).
     */
    let { value, sessionId } = await runJsonAgent<any>({
      model, system: architectSystem(), prompt, resume,
      thinking: this.thinking('heavy'), timeoutMs: CFG.researchTimeoutMs, debateId: this.id, label: 'architect',
    });
    if (sessionId) meta.sessions['_architect'] = sessionId;

    let personas = this.personasFrom(value);
    if (personas.length < 3) throw new Error('architect returned fewer than 3 experts');

    /**
     * The reality-check seat (docs/PHASE2-PLAN.md 2d): someone at the table
     * has to make the decision work on Monday. One retry with the hint; a
     * panel still without one goes ahead rather than stall the session.
     */
    const reality = checkRealitySeat(personas, `${this.row.topic} ${this.row.goal ?? ''}`);
    if (!reality.ok && reality.hint && !this.killed) {
      try {
        const retry = await runJsonAgent<any>({
          model, system: architectSystem(), prompt: architectRevisePrompt(reality.hint), resume: sessionId ?? meta.sessions['_architect'],
          thinking: this.thinking('heavy'), timeoutMs: CFG.researchTimeoutMs, debateId: this.id, label: 'architect:reality',
        });
        const again = this.personasFrom(retry.value);
        if (again.length >= 3) {
          value = retry.value;
          personas = again;
          if (retry.sessionId) meta.sessions['_architect'] = retry.sessionId;
        }
      } catch (err) {
        if (asUsageLimit(err) || abortedByUser(err)) throw err;
        console.error(`[debate ${this.id}] architect reality-seat retry failed; keeping the first roster:`, err);
      }
    }

    const roster = [MARCUS, ...personas];
    Debates.patch(this.id, { personas: roster });
    this.row.personas = roster;
    writeAgentsFile(this.row);
    meta.architectResearchQs = (value.research_questions ?? []).map(String).slice(0, 3);
    this.saveMeta();

    await this.dossierStep(personas);
    if (this.row.meta.endedByUser || this.killed) return;

    const reps = reputations(meta.dossiers);
    this.publish({
      type: 'panel', personas: roster, rationale: String(value.rationale ?? ''),
      ...(Object.keys(reps).length ? { publicReputation: reps } : {}),
      ...(meta.diversity ? { diversity: meta.diversity } : {}),
    });
    if (meta.diversity && !meta.diversity.ok) {
      this.system(`The panel did not pass the diversity check even after a second draft: ${meta.diversity.problems.join(' ')} It can go ahead as it is, or you can ask for a different roster.`);
    }
    this.setStatus('panel_approval');
  }

  /** The architect's roster, coerced into personas the engine can trust. */
  private personasFrom(value: any): Persona[] {
    const seen = new Set<string>();
    return (Array.isArray(value?.personas) ? value.personas : [])
      .slice(0, SCOPE_LIMITS.experts.max)   // scope sizes the panel; this is a malfunction guard, not the sizing
      .map((p: any, i: number): Persona => {
        let id = String(p.id ?? p.name ?? `expert${i}`).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) || `expert${i}`;
        while (seen.has(id) || RESERVED_IDS.has(id)) id = `${id}${i}`;
        seen.add(id);
        const name = String(p.name ?? `Expert ${i + 1}`);
        return {
          id,
          name,
          role: String(p.role ?? 'Domain expert'),
          tagline: String(p.tagline ?? ''),
          bio: String(p.bio ?? ''),
          expertise: Array.isArray(p.expertise) ? p.expertise.map(String).slice(0, 6) : [],
          personality: String(p.personality ?? ''),
          biases: String(p.biases ?? ''),
          style: String(p.style ?? ''),
          color: PALETTE.includes(p.color) ? p.color : PALETTE[i % PALETTE.length],
          initials: (String(p.initials ?? '').slice(0, 2) || name.split(/\s+/).map((w: string) => w[0]).join('').slice(0, 2)).toUpperCase(),
        };
      });
  }

  /**
   * Persona dossiers (docs/PHASE2-PLAN.md 2a): one balanced-tier call per
   * expert, in parallel, then the deterministic diversity check. Offenders
   * are written once more with a behaviour-level hint; a panel that still
   * fails goes ahead, flagged at panel approval. Then one relationships pass
   * over the public parts only. A dossier that cannot be written costs that
   * expert their voice card, never the session.
   *
   * On a roster revision, an expert the founder kept (same id, name and role)
   * keeps their dossier; only new or changed seats are written.
   */
  private async dossierStep(personas: Persona[]) {
    const meta = this.row.meta;
    const prior = meta.dossiers ?? {};
    const priorRoster = new Map((meta.dossierRoster ?? []).map((r) => [r.id, r]));
    const kept: Record<string, Dossier> = {};
    for (const p of personas) {
      const was = priorRoster.get(p.id);
      if (prior[p.id] && was && was.name === p.name && was.role === p.role) kept[p.id] = prior[p.id];
    }
    const todo = personas.filter((p) => !kept[p.id]);
    const stage = Hub.stage(this.id, 'panel', 'Writing the experts’ dossiers',
      'Each expert gets a history, personal stakes in the outcome and a way of talking, then the panel is checked for enough difference between them.');
    const dossiers: Record<string, Dossier> = { ...kept };
    let regenerated: string[] = [];
    let report: ReturnType<typeof checkDiversity> | null = null;
    try {
      const write = async (list: Persona[], hints: Record<string, string[]> = {}) => {
        const out = await Promise.allSettled(list.map(async (p) => [p.id, await this.writeDossier(p, personas, hints[p.id])] as const));
        for (const r of out) {
          if (r.status === 'fulfilled' && r.value[1]) dossiers[r.value[0]] = r.value[1];
          else if (r.status === 'rejected' && (asUsageLimit(r.reason) || abortedByUser(r.reason))) throw r.reason;
        }
      };
      await write(todo);
      if (this.killed || meta.endedByUser) return;
      const entries = (): PanelEntry[] => personas.filter((p) => dossiers[p.id]).map((p) => ({ id: p.id, dossier: dossiers[p.id], goalLean: dossiers[p.id].goalLean }));
      report = checkDiversity(entries());
      if (!report.ok && report.regenerate.length) {
        regenerated = report.regenerate;
        await write(personas.filter((p) => regenerated.includes(p.id)), report.hints);
        report = checkDiversity(entries());
      }
      await this.relationshipsPass(personas, dossiers);
    } finally {
      stage.close();
    }
    const nameOf = (id: string) => personas.find((p) => p.id === id)?.name ?? id;
    const missing = personas.filter((p) => !dossiers[p.id]).map((p) => p.id);
    meta.dossiers = dossiers;
    meta.dossierRoster = personas.map((p) => ({ id: p.id, name: p.name, role: p.role }));
    meta.diversity = diversityFlag(report, regenerated, missing, nameOf);
    this.saveMeta();
  }

  /** One expert's dossier: parsed, validated, and asked for once more if the first draft was malformed. */
  private async writeDossier(p: Persona, roster: Persona[], hints?: string[]): Promise<Dossier | null> {
    const panelIds = roster.map((x) => x.id);
    let errors: string[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const { value } = await runJsonAgent<any>({
          model: this.modelFor('persona'),
          system: personaSystem(),
          prompt: personaPrompt(p, this.row.goal ?? this.row.topic, this.row.topic, this.row.personas, this.row.meta.contextBrief,
            [...(hints ?? []), ...errors.map((e) => `fix this in the first draft: ${e}`)]),
          thinking: 2_000,
          timeoutMs: 5 * 60_000,
          debateId: this.id,
          label: `${p.id}:dossier${attempt > 1 ? ':retry' : ''}${hints?.length ? ':diverse' : ''}`,
        });
        const parsed = parseDossier(value, { personaId: p.id, panelIds });
        if (parsed.ok) return parsed.dossier;
        errors = parsed.errors.slice(0, 6);
      } catch (err) {
        if (asUsageLimit(err) || abortedByUser(err)) throw err;
        console.error(`[debate ${this.id}] dossier for ${p.id} failed:`, err);
        return null;
      }
    }
    console.error(`[debate ${this.id}] dossier for ${p.id} still malformed: ${errors.join('; ')}`);
    return null;
  }

  /** Who has history with whom, from the public parts only. Non-fatal. */
  private async relationshipsPass(personas: Persona[], dossiers: Record<string, Dossier>) {
    const members = personas.filter((p) => dossiers[p.id]).map((p) => ({ id: p.id, name: p.name, role: p.role, publicReputation: dossiers[p.id].publicReputation }));
    if (members.length < 2) return;
    try {
      const { value } = await runJsonAgent<any>({
        model: this.modelFor('persona'),
        system: relationshipsSystem(),
        prompt: relationshipsPrompt(members),
        thinking: 0,
        timeoutMs: 3 * 60_000,
        debateId: this.id,
        label: 'relationships',
      });
      const rel = value?.relationships && typeof value.relationships === 'object' ? value.relationships : {};
      const ids = new Set(members.map((m) => m.id));
      for (const m of members) {
        const list = Array.isArray(rel[m.id]) ? rel[m.id] : [];
        const clean = list
          .filter((r: any) => r && ids.has(String(r.with)) && String(r.with) !== m.id && ['ally', 'rival', 'history', 'respect'].includes(r.kind))
          .slice(0, 3)
          .map((r: any) => ({ with: String(r.with), kind: r.kind, note: String(r.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) }));
        if (clean.length) dossiers[m.id] = { ...dossiers[m.id], relationships: clean };
      }
    } catch (err) {
      if (asUsageLimit(err) || abortedByUser(err)) throw err;
      console.error(`[debate ${this.id}] relationships pass failed:`, err);
    }
  }

  /**
   * The architect's web pass: the domain as it really stands, from the topic
   * and the goal only. Never the dossier brief (docs/SECURITY-AUDIT-2.md
   * finding 2), and the goal goes out scrubbed like every research prompt. A
   * failure costs only the grounding: the designer works from what it knows.
   * The OpenAI door skips it: there it would be a paid call the session did
   * not have before this pass moved onto the research desk.
   *
   * It runs on the research desk as one question (one search, a second on a
   * named gap, pages read and extracted by the desk). Until 1 Nov 2026 it was
   * a flagship web loop with heavy thinking that read its search results in
   * context: $1.37 of the 28 Oct run, ~148,000 tokens written to the cache.
   * Its answer is also kept as a brief the rest of the debate's research
   * reuses (knownResearch) instead of searching the same ground again.
   */
  private async scoutDomain(): Promise<string> {
    if (this.provider === 'openai') return '';
    let g = gateQuestion(architectScoutQuestion(this.row.topic));
    if (!g.ok) g = gateQuestion(architectScoutQuestion(scrubForWeb(this.row.topic, 300)));
    if (!g.ok) return '';
    const req: ResearchRequest = {
      id: rid('r'),
      debateId: this.id,
      question: g.question,
      askedBy: 'architect',
      purpose: 'landscape',
      maxSources: 8,
      budget: { maxSearches: RESEARCH_LIMITS.searches, timeoutMs: this.provider === 'codex' ? CODEX_RESEARCH_MS : CFG.researchTimeoutMs },
    };
    try {
      const result = await runResearch(this.provider, req, { goal: scrubForWeb(this.row.goal ?? this.row.topic) });
      if (result.status !== 'ok' || !result.findings.length) return '';
      this.row.meta.architectScout = { requestId: req.id, question: req.question, summary: result.summary, citations: result.citations, status: result.status };
      // The note the designer reads: the brief and its findings, no markers and no links.
      const plain = (t: string) => t.replace(/\s*\[(c_[a-z0-9]+|uncorroborated)\]/g, '').trim();
      return [plain(result.summary), ...result.findings.map((f) => `- ${plain(f.claim)}`)].join('\n').slice(0, 3_000);
    } catch (err) {
      if (asUsageLimit(err) || abortedByUser(err)) throw err;
      console.error(`[debate ${this.id}] architect scout failed; designing without it:`, err);
      return '';
    }
  }

  /** What this debate's research already holds, for a new question to reuse (research/index.ts recall). */
  private knownResearch(): KnownBrief[] {
    const meta = this.row.meta;
    const out: KnownBrief[] = [];
    if (meta.architectScout) out.push({ ...meta.architectScout, id: meta.architectScout.requestId });
    meta.researchBriefs.forEach((b, i) => {
      if (b.status === 'ok' && b.citations?.length) out.push({ id: b.requestId ?? `brief-${i + 1}`, question: b.question, summary: b.summary, citations: b.citations, status: b.status });
    });
    return out;
  }

  private async planningStep() {
    if (this.row.meta.endedByUser || this.killed) return;
    const meta = this.row.meta;
    const model = this.modelFor('chair');

    if (!meta.preResearchDone && meta.architectResearchQs.length) {
      this.system(`Research desk pre-loading ${meta.architectResearchQs.length} briefs before the session opens.`);
      /**
       * After a restart a brief may already be in flight (resumeResearch
       * re-issued it) or already answered: wait on the one, skip the other,
       * and never send the same question twice.
       */
      const runs = meta.architectResearchQs.map((q) => {
        // The question as requestResearch stores it, so a restart recognises its own requests.
        const g = gateQuestion(q);
        const key = g.ok ? g.question : null;
        const inflight = (meta.researchInflight ?? []).find((r) => r.purpose === 'pre_session' && r.question === key);
        if (inflight) return this.launchResearch(inflight);
        if (key && meta.researchBriefs.some((b) => b.question === key)) return null;
        return this.requestResearch(q, { askedBy: 'architect', purpose: 'pre_session' });
      });
      await Promise.allSettled(runs.filter(Boolean) as Promise<void>[]);
      if (this.killed) return;
      meta.preResearchDone = true;
      this.saveMeta();
      // Paused while the desk was out: the briefs are kept, and the chair plans from them on Resume (P4).
      if (this.isPaused()) return;
    }

    // Page-derived text: fenced before it goes anywhere near the chair's prompt.
    const digest = this.row.meta.researchBriefs.map((b) => `Q: ${b.question}\n${fenceUntrusted('RESEARCH BRIEF', b.summary)}`).join('\n\n');
    let prompt: string;
    let resume: string | undefined = meta.sessions['marcus'];
    if (meta.planFeedback) {
      prompt = `The founder wants the plan revised: "${meta.planFeedback}"\nRevise the agenda. Same strict JSON format as before (plan_update with the full item list, keep ids stable).`;
      meta.planFeedback = null;
    } else {
      prompt = marcusPlanPrompt(digest, this.scope.motions, this.scope.depth);
      resume = undefined;
    }

    const marcusSys = marcusSystem(this.row.goal ?? '', this.row.topic, this.row.personas, this.row.config, this.row.meta.contextBrief, this.humanName());
    const { value, sessionId } = await runJsonAgent<any>({
      model, system: marcusSys, prompt, resume,
      thinking: this.thinking('heavy'), debateId: this.id, label: 'marcus:plan',
    });
    if (sessionId) meta.sessions['marcus'] = sessionId;
    this.saveMeta();

    if (value.say) this.publishMarcus(String(value.say));
    const items = value.plan_update?.items;
    if (!Array.isArray(items) || !items.length) throw new Error('Marcus returned no plan');
    const plan: Plan = {
      revision: (this.row.plan?.revision ?? 0) + 1,
      items: items.map((i: any, n: number) => ({
        id: String(i.id ?? `a${n + 1}`),
        title: String(i.title ?? ''),
        detail: String(i.detail ?? ''),
        /**
         * The PROPOSITION, which the room was never actually given.
         *
         * marcusPlanPrompt demands "the full proposition the room must rule
         * on", and motionOf() prefers it — but this mapping dropped the field,
         * so it fell back to "title. detail" every single session and the
         * panel argued a topic label instead of a claim. Everything Marcus
         * encoded in the proposition went with it, including the frame ("for
         * Indian SMBs" rather than "for US mid-market"), which is one of the
         * ways a founder ends up reading a well-argued answer to a question he
         * did not ask.
         */
        motion: i.motion ? String(i.motion) : undefined,
        status: ['pending', 'active', 'done', 'added', 'dropped'].includes(i.status) ? i.status : 'pending',
        // What the 80% budget rule skips first. Only an explicit true counts.
        ...(i.optional === true ? { optional: true } : {}),
      })),
      rationale: String(value.plan_update?.rationale ?? ''),
    };
    /**
     * An agenda that is all optional would let the budget skip every motion
     * after the first ruling, which is not what "optional" means. The first
     * motion always stands.
     */
    if (plan.items.length && plan.items.every((i) => i.optional)) delete plan.items[0].optional;
    Debates.patch(this.id, { plan });
    this.row.plan = plan;
    this.publish({ type: 'plan', plan });
    this.setStatus('plan_approval');
  }

  // ---------- the meeting ----------

  /**
   * The meeting: every motion on the agenda is argued until it goes dry, then
   * ruled on. The session ends when the agenda is exhausted, not when a
   * moderator gets bored.
   */
  private async meetingLoop() {
    initTranscriptFile(this.row, Events.since(this.id, 0), CFG.founderName);

    while (!this.killed) {
      this.refresh();
      if (this.row.status !== 'meeting') return;
      if (this.row.meta.endedByUser) {
        this.setStatus('wrapup');
        this.system('Session ended by the founder. Moving to closing statements.');
        return;
      }
      if (this.row.meta.floorCount >= DEPTH.hardMessageCeiling) {
        this.publishMarcus('We have hit the hard session ceiling. Closing statements now.');
        this.setStatus('wrapup');
        return;
      }

      /**
       * No budget check here. Spend never skips a motion or ends the session:
       * the agenda is argued until it is settled. The founder's own ceiling,
       * if they set one, is asked about between rounds (ceilingGate).
       */

      const items = (this.row.plan?.items ?? []).filter((i) => i.status !== 'dropped');
      const done = new Set(this.row.meta.closedMotions);
      const next = items.find((i) => !done.has(i.id));

      if (!next) {
        this.publishMarcus('Every motion on the agenda has been argued and ruled on. Closing statements.');
        this.setStatus('wrapup');
        return;
      }

      const index = items.findIndex((i) => i.id === next.id) + 1;
      this.markPlanItem(next.id, 'active');

      this.activeMotionId = next.id;
      const decision = await runMotion(this.motionHost(), next, index, items.length);
      this.activeMotionId = null;
      if (this.killed) return;

      if (decision) {
        this.row.meta.decisions.push(decision);
        this.row.meta.closedMotions.push(next.id);
        this.saveMeta();
        this.markPlanItem(next.id, 'done');
        appendTranscriptFile(
          this.id,
          `\n---\n\n### DECISION — ${decision.motionTitle}\n\n**Ruling:** ${decision.decision}\n\n**Owner:** ${decision.owner}\n\n**Why:** ${decision.rationale}\n\n**Evidence grade:** ${decision.evidence}\n${decision.dissents.length ? `\n**Dissents:** ${decision.dissents.map((d) => `${d.expert}: ${d.position}`).join(' | ')}\n` : ''}${decision.undecidable ? `\n**Undecidable:** ${decision.undecidable.question} (needs: ${decision.undecidable.evidenceNeeded}, owner: ${decision.undecidable.who})\n` : ''}\n---\n`
        );
      }

      const usage = Usage.get(this.id);
      this.row.meta.usage = usage;
      this.saveMeta();
      // The meter's persisted checkpoint, once per motion.
      const snap = this.budgetNow(usage);
      if (snap) this.publish({ type: 'budget', budget: snap });
      this.publish({
        type: 'progress',
        messages: this.row.meta.floorCount,
        motionsClosed: this.row.meta.closedMotions.length,
        motionsTotal: items.length,
        spentUsd: Math.round(usage.costUsd * 100) / 100,
        usage,
      });
    }
  }

  /**
   * The live agenda: Marcus adding a motion the argument demanded, or dropping
   * one it killed.
   *
   * This code was first written for the old free-for-all loop, which the
   * motion engine replaced (and which has since been deleted), so for a while
   * the agenda froze at approval. The chair's steer and ruling now call it.
   *
   * It MERGES rather than replaces, which is the one real change from the
   * original. Asking the chair to restate the entire agenda in the middle of a
   * round to add one motion invites him to restate it wrong, and a replace
   * would then silently delete motions the room had already ruled on or was
   * arguing at that moment. Anything he leaves out stays exactly as it is; a
   * closed motion and the motion on the floor cannot be dropped at all.
   */
  private applyPlanUpdate(raw: any): boolean {
    const incoming: any[] = Array.isArray(raw?.items) ? raw.items : [];
    if (!incoming.length) return false;

    const closed = new Set(this.row.meta.closedMotions);
    const byId = new Map<string, AgendaItem>((this.row.plan?.items ?? []).map((i) => [i.id, { ...i }]));
    const added: string[] = [];
    const dropped: string[] = [];

    for (const r of incoming) {
      const id = String(r?.id ?? '').trim();
      if (!id) continue;
      const status: AgendaItem['status'] = ['pending', 'active', 'done', 'added', 'dropped'].includes(r?.status)
        ? r.status
        : 'pending';
      const prev = byId.get(id);

      if (!prev) {
        if (status === 'dropped') continue;                 // dropping something that was never on it
        byId.set(id, {
          id,
          title: String(r.title ?? '').slice(0, 200) || id,
          detail: String(r.detail ?? '').slice(0, 1200),
          // The proposition, which the room argues; motionOf falls back to
          // "title. detail" without it and the panel debates a label.
          motion: r.motion ? String(r.motion) : undefined,
          status: 'added',
        });
        added.push(id);
        continue;
      }

      if (status === 'dropped') {
        if (closed.has(id) || id === this.activeMotionId) continue;   // ruled, or on the floor right now
        prev.status = 'dropped';
        dropped.push(id);
      } else if (status === 'added' || status === 'pending') {
        // A revision of something already on the agenda: text only, never status.
        if (r.title) prev.title = String(r.title).slice(0, 200);
        if (r.detail) prev.detail = String(r.detail).slice(0, 1200);
        if (r.motion) prev.motion = String(r.motion);
      }
      byId.set(id, prev);
    }

    // Only a real addition or removal is a revision. Rewording an item the room
    // is already going to argue is not worth a plan event and a revision bump
    // the founder has to read as though something changed.
    if (!added.length && !dropped.length) return false;
    const plan: Plan = {
      revision: (this.row.plan?.revision ?? 0) + 1,
      items: [...byId.values()],
      rationale: String(raw?.rationale ?? '').slice(0, 600),
    };
    Debates.patch(this.id, { plan });
    this.row.plan = plan;
    this.publish({ type: 'plan', plan });
    const names = (ids: string[]) => ids.map((id) => `"${byId.get(id)?.title ?? id}"`).join(', ');
    this.system(
      [
        added.length ? `Marcus adds ${added.length === 1 ? 'a motion' : 'motions'} to the agenda: ${names(added)}.` : '',
        dropped.length ? `Marcus drops ${names(dropped)} from the agenda.` : '',
        plan.rationale,
      ].filter(Boolean).join(' ')
    );
    return true;
  }

  /**
   * Put a ruled motion back on the floor.
   *
   * A ruling used to be final even when a later motion destroyed the premise it
   * rested on, and the founder would then read a report carrying a conclusion
   * the room itself had disproved. Reopening vacates the old ruling rather than
   * annotating it: the decision is pulled from the record the report is written
   * from, the item goes back on the agenda, and the meeting loop picks it up as
   * soon as the current motion closes (it sits earlier in the list, so it is
   * the next one found).
   *
   * The cap is what keeps this from being a loop. A second attempt at the same
   * motion is recorded as the chair's standing objection against the existing
   * ruling instead, which is the honest outcome anyway: if the room cannot
   * settle it in two passes, the disagreement is the finding.
   */
  private reopenMotion(motionId: string, because: string) {
    const meta = this.row.meta;
    const item = (this.row.plan?.items ?? []).find((i) => i.id === motionId);
    if (!item) return;
    if (motionId === this.activeMotionId) return;             // it is being argued right now
    if (!meta.closedMotions.includes(motionId)) return;        // never ruled: nothing to reopen
    const reason = because.trim() || 'The chair says a later motion broke the premise this ruling rested on.';

    const already = (meta.reopenedMotions ??= []);
    if (already.includes(motionId)) {
      const d = meta.decisions.find((x) => x.motionId === motionId);
      if (d) {
        d.dissents = [
          ...(d.dissents ?? []),
          {
            expert: MARCUS.name,
            position: reason,
            reasoning: 'Recorded as a standing objection rather than a second reopening. This motion has already been re-argued once, and a room that can reopen without limit never decides anything.',
          },
        ].slice(0, 8);
      }
      this.saveMeta();
      this.system(`Marcus moved to reopen "${item.title}" a second time. It has already been re-argued once, so his objection stands on the record against that ruling instead: ${reason}`);
      return;
    }

    already.push(motionId);
    meta.closedMotions = meta.closedMotions.filter((x) => x !== motionId);
    meta.decisions = meta.decisions.filter((x) => x.motionId !== motionId);
    if (meta.motionCheckpoint?.motionId === motionId) meta.motionCheckpoint = null;
    this.saveMeta();
    this.markPlanItem(motionId, 'active');
    this.publish({ type: 'motion_reopened', motionId, title: item.title, because: reason });
    appendTranscriptFile(this.id, `\n---\n\n### REOPENED — ${item.title}\n\n${reason}\n\nThe earlier ruling on this motion is vacated; the room will argue it again.\n\n---\n`);
  }

  private markPlanItem(id: string, status: AgendaItem['status']) {
    if (!this.row.plan) return;
    const plan: Plan = {
      ...this.row.plan,
      items: this.row.plan.items.map((i) => (i.id === id ? { ...i, status } : i)),
    };
    Debates.patch(this.id, { plan });
    this.row.plan = plan;
    this.publish({ type: 'plan', plan });
  }

  /** The capability surface the motion engine drives the room through. */

  // ---------- casting: which model does which job ----------

  /**
   * The approved shape of this session. Rows created before scope existed get
   * the shape the app used to hardcode, so an in-flight debate keeps behaving
   * the way it started rather than changing mid-session.
   */
  private get scope(): SessionScope {
    return this.row.meta.scope ?? LEGACY_SCOPE;
  }

  /**
   * Rounds a motion may run. The target is what the founder approved and paid
   * for; the ceiling gives the room a little room to finish a thought it is
   * genuinely in the middle of, and then stops it.
   */
  private roundBudget(): { target: number; ceiling: number } {
    /**
     * The sizing is a STARTING SHAPE, not a budget. His decision, verbatim:
     * "we cant plan it in advance / whatever we do in advance is to just get
     * it going / everything can be changed on the go". A motion now runs until
     * the referee judges it settled on the merits; the ceiling survives only as
     * a runaway guard, not as the thing that decides depth. It used to sit at
     * target+3, so an "exhaustive" motion was capped at eight rounds before a
     * word had been said about it.
     */
    // Since P2 a profile states its own length; the runaway ceiling stays for debates from before profiles.
    const len = this.lengthSpec();
    const ceiling = len ? len.maxRounds : DEPTH.maxRoundsPerMotion;
    return { target: Math.min(this.scope.roundsPerMotion, ceiling), ceiling };
  }

  /** The profile's session length (P2), or null for a debate from before profiles. */
  private lengthSpec(): LengthSpec | null {
    const p = this.profile;
    return p ? BUDGET_PROFILES[p].length : null;
  }

  /**
   * Messages the open motion may still take on the floor (P2): its share of
   * the session's length, minus what it has used. Counted from the record, so
   * a restart or a pause cannot lose track of it.
   */
  private motionRemaining(st: MotionState): number {
    const len = this.lengthSpec();
    if (!len) return Infinity;
    const events = Events.since(this.id, 0);
    const isMsg = (e: DebateEvent) => e.type === 'message';
    const all = events.filter(isMsg).length;
    const used = events.filter((e) => isMsg(e) && e.seq > st.startSeq).length;
    const closed = new Set(this.row.meta.closedMotions);
    const motionsLeft = (this.row.plan?.items ?? []).filter((i) => i.status !== 'dropped' && !closed.has(i.id)).length;
    const allowance = motionAllowance(len, {
      spentElsewhere: all - used,
      motionsLeft,
      experts: this.experts.length,
      adversary: this.adversarySeats() > 0 && !st.redTeamed,
    });
    return allowance - used;
  }

  // ---------- the budget profile ----------

  /**
   * How deep the room argues (a process shape, not a spend limit), or null for
   * a debate created before profiles existed: those keep today's thinking
   * budgets and three adversaries, so nothing in flight changes shape
   * underneath its own run. 'auto' resolves at intake (profilePick).
   */
  private get profile(): BudgetProfile | null {
    return profileOf(this.row.config, this.row.meta.profilePick);
  }

  /**
   * The founder overrides the profile before the panel is designed (the
   * intake's pick included). Re-sizes the session and re-shows the estimate.
   */
  setProfile(p: BudgetProfile): boolean {
    if (!this.row.config.profile || !['intake', 'clarifying', 'goal_approval'].includes(this.row.status)) return false;
    const meta = this.row.meta;
    meta.profilePick = { profile: p, source: 'founder', reason: `You chose the ${BUDGET_PROFILES[p].label.toLowerCase()} room.` };
    if (meta.complexity && meta.scope) {
      meta.scope = scopeFrom(meta.complexity, this.provider, (meta.contextFiles ?? 0) > 0, p, this.ceilingUsd());
      meta.scope.estimate.profileReason = meta.profilePick.reason;
      this.publish({ type: 'scope', scope: meta.scope });
    }
    this.saveMeta();
    return true;
  }

  /** The founder's ceiling in force (extended, this debate's, or BUDGET_CEILING_USD), or null: no limit. */
  private ceilingUsd(): number | null {
    return ceilingOf(this.provider, this.row.meta.ceilingUsd, this.row.config.ceilingUsd, CFG.budgetCeilingUsd);
  }

  /**
   * At the founder's own ceiling, if they set one: pause between rounds and
   * ask. Extending raises it and the room carries on at full depth; stopping
   * is the ordinary End (every open motion ruled, closings, the report).
   */
  private async ceilingGate(): Promise<void> {
    const ceiling = this.ceilingUsd();
    if (ceiling === null || this.row.meta.endedByUser || this.killed) return;
    const spent = Usage.get(this.id).costUsd;
    if (spent < ceiling) return;
    const q = ceilingQuestion(spent, ceiling, billingOf(this.provider));
    const questionId = rid('uq');
    this.publish({ type: 'question', questionId, question: q.question, context: q.context, options: q.options, allowCustom: false });
    this.row.meta.pendingQuestionId = questionId;
    this.saveMeta();
    const snap = this.budgetNow();
    if (snap) this.live({ type: 'budget', budget: { ...snap, state: 'ceiling' } });
    const sig = await this.waitUser();
    this.row.meta.pendingQuestionId = null;
    if (sig.kind === 'end' || (sig.kind === 'answer' && sig.answer.trim() === CEILING_STOP)) {
      this.row.meta.endedByUser = true;
      this.saveMeta();
      this.system('Stopping at your ceiling. Every open motion is ruled, then closing statements and the full report.');
      return;
    }
    this.row.meta.ceilingUsd = q.next;
    this.saveMeta();
    this.system(`Ceiling raised to $${q.next.toFixed(2)}. The room carries on.`);
  }

  /** Thinking tokens for a kind of seat: the profile's, or today's for an unprofiled debate. */
  private thinking(kind: 'referee' | 'floor' | 'reply' | 'steer' | 'heavy'): number {
    const p = this.profile;
    if (p) return BUDGET_PROFILES[p].thinking[kind];
    return { referee: CFG.refereeThinking, floor: CFG.floorThinking, reply: 2_000, steer: CFG.steerThinking, heavy: CFG.heavyThinking }[kind];
  }

  /** Adversary seats per attack on a ruling: 0 (off), 1 or 3 by profile; 3 for an unprofiled debate. */
  private adversarySeats(): number {
    const p = this.profile;
    return p ? BUDGET_PROFILES[p].adversarySeats : 3;
  }

  /** Adversary seats on the written report: never 0 on any profile; 3 for an unprofiled debate. */
  private reportAdversarySeats(): number {
    const p = this.profile;
    return p ? BUDGET_PROFILES[p].reportAdversarySeats : 3;
  }

  /** The meter's current reading (information only), or null when this debate is not metered. */
  private budgetNow(usage = Usage.get(this.id)): BudgetSnapshot | null {
    const p = this.profile;
    if (!p) return null;
    const scope = this.row.meta.scope;
    const projected = scope ? projectTurns(scope, (this.row.meta.contextFiles ?? 0) > 0, p) : null;
    return budgetSnapshot(p, this.provider, {
      usd: usage.costUsd,
      output: usage.output,
      flagshipCalls: usage.flagshipCalls ?? 0,
      calls: usage.turns,
      turns: this.row.meta.floorCount,
    }, {
      expectedTurns: projected ? projected.floor + projected.reactionTurns : undefined,
      estimate: scope?.estimate,
      ceilingUsd: this.ceilingUsd(),
    });
  }

  /** After every agent call: show the meter. Nothing acts on it. */
  private budgetTick(usage: UsageTotals) {
    const snap = this.budgetNow(usage);
    if (!snap) return;
    this.row.meta.budget = snap;
    this.live({ type: 'budget', budget: snap });
  }

  /** The provider family this whole debate runs on. */
  private get provider(): Provider {
    return providerOfConfig(this.row.config);
  }

  /**
   * The model for a given job. Casting is fixed by the product in
   * shared/models.ts: the user picks a provider, never a model, and the chair
   * does not choose models either.
   */
  private modelFor(seat: Seat): string {
    return modelFor(this.provider, seat);
  }

  /** The casting sheet for this session, built from the fixed seat table. */
  private castingSheet(): Casting {
    // Only seats that run: `react` is cast but idle until the floor director (2b-7).
    const seats = (Object.keys(SEAT_TIER) as Seat[]).filter((s) => s !== 'repair' && s !== 'react');
    return {
      chair: this.modelFor('chair'),
      entries: seats.map((role) => ({ role, model: this.modelFor(role), why: SEAT_WHY[role] })),
      strategy: `${PROVIDER_LABEL[this.provider]} session. Hard seats run on ${modelName(this.modelFor('chair'))}, research and the dossier on ${modelName(this.modelFor('research'))}, turn rewrites on ${modelName(this.modelFor('lint'))}.`,
      revision: 1,
    };
  }

  /**
   * Publish the casting sheet once, when the room opens, so the founder can
   * see what runs where. Costs no model call. A debate resumed from before the
   * models changed gets a fresh sheet, so the card never names a model that
   * no longer runs.
   */
  private castingStep() {
    const meta = this.row.meta;
    if (meta.casting && meta.casting.chair === this.modelFor('chair')) return;
    meta.casting = this.castingSheet();
    this.saveMeta();
    this.publish({ type: 'casting', casting: meta.casting });
  }

  /**
   * Every expert writes down what they believe, before the first motion opens.
   *
   * `buildRoomBlocks` deliberately makes the system prompt BYTE-IDENTICAL for
   * every seat so a round's turns share one cached prefix, and its own comment
   * insists "everything in the prefix must be written in nobody's voice".
   * Identity therefore lived entirely in the six lines of `expertVoice`, which
   * means fifteen experts walked in knowing exactly the same things and the
   * only thing they could disagree about was manner. That is the texture the
   * founder called "okay, not great": clever people each landing one distinct
   * observation and nobody ever losing.
   *
   * These calls run in PARALLEL and BLIND. No expert sees another's card, and
   * none of them exist yet when any of them is written, so the convictions
   * cannot converge before the room has even opened. The card is then frozen
   * into that expert's own fresh suffix (never into the shared prefix, which
   * must stay byte-identical or the cache design breaks) along with the rule
   * that a concession is only legal if the expert names their own falsifier.
   *
   * Nothing here is allowed to stop the meeting. An expert whose card call
   * fails simply has no card and argues the way the room worked before this
   * existed, which is the same non-fatal shape as the casting call above.
   */
  private async positionCardsStep() {
    const meta = this.row.meta;
    /**
     * Written once and only once. Re-minting them on a resume would hand the
     * room a different set of convictions half way through a debate that had
     * already been argued against the first set, and the transcript would show
     * an expert quietly abandoning a red line nobody ever attacked.
     */
    if (meta.positionCards) return;
    if (meta.endedByUser || this.killed) return;
    const experts = this.experts;
    if (!experts.length) return;

    const stage = Hub.stage(this.id, 'panel', 'The panel are taking positions',
      'Each expert, separately and without seeing the others, is naming a thesis, a red line, and the one observation that would flip them.');
    const cards: Record<string, PositionCard> = {};
    try {
      await Promise.allSettled(
        experts.map(async (p) => {
          try {
            const { value } = await runJsonAgent<any>({
              model: this.modelFor('floor'),
              system: positionCardSystem(),
              prompt: positionCardPrompt(p, this.row.goal ?? this.row.topic, this.row.topic, this.row.personas, meta.contextBrief, meta.dossiers?.[p.id]),
              thinking: this.thinking('floor'),
              debateId: this.id,
              label: `${p.id}:position`,
            });
            const card = sanitizePositionCard(value);
            if (card) cards[p.id] = card;
          } catch (err) {
            // One silent seat, never a dead session.
            console.error(`[debate ${this.id}] position card failed for ${p.id}:`, err);
          }
        })
      );
    } finally {
      stage.close();
    }

    await this.contrarianPass(cards);

    meta.positionCards = cards;
    // The belief ledger opens with the panel's traits; motions add starting stances as they open.
    if (meta.ledger === undefined || meta.ledger === null) {
      meta.ledger = newLedger(Object.fromEntries(experts.map((p) => {
        const d = meta.dossiers?.[p.id];
        return [p.id, { stubbornness: d?.stubbornness ?? 0.5, ...(d?.priorPublicStance ? { priorPublicStance: d.priorPublicStance } : {}) }];
      })));
    }
    this.saveMeta();
    const n = Object.keys(cards).length;
    if (n) {
      this.system(
        `The panel have written their positions. ${n === experts.length ? 'Each expert' : `${n} of ${experts.length} experts`} has named a thesis, a red line they will not concede, and the one observation that would flip them. None of them has seen anyone else's. From here nobody gives ground on their thesis unless what would flip them actually happens in front of the room.`
      );
    }
  }

  /**
   * Blind conviction has a failure mode the first live probe measured: on a
   * one-sided brief, all six seats wrote the SAME thesis, and five of them
   * named the same colleague as the one they expected to be wrong, a colleague
   * who agreed with every word. The room walked in with nothing to resolve.
   *
   * So the finished cards get one consensus check, and when every seat landed
   * on the same side, the single best-placed expert is re-briefed to hold the
   * strongest HONEST case for the other side, conviction rules unchanged: they
   * concede only by naming their falsifier. The founder sees this happen in a
   * system line, because a transcript that hides who was assigned the contrary
   * brief would be dressing consensus up as conflict.
   */
  private async contrarianPass(cards: Record<string, PositionCard>) {
    const ids = Object.keys(cards);
    if (ids.length < 3) return;
    try {
      const theses = ids.map((id) => {
        const p = this.row.personas.find((x) => x.id === id);
        return { id, name: p?.name ?? id, role: p?.role ?? '', thesis: cards[id].thesis };
      });
      const { value } = await runJsonAgent<any>({
        model: this.modelFor('floor'),
        system: cardConsensusSystem(),
        prompt: cardConsensusPrompt(this.row.goal ?? this.row.topic, theses),
        thinking: this.thinking('steer'),
        debateId: this.id,
        label: 'cards:consensus',
      });
      if (!value?.consensus) return;
      const holdout = this.experts.find((p) => p.id === String(value.holdout ?? ''));
      if (!holdout || !cards[holdout.id]) {
        console.warn(`[debate ${this.id}] consensus found but holdout '${value?.holdout}' is not a carded expert; leaving the room agreed`);
        return;
      }
      const { value: raw } = await runJsonAgent<any>({
        model: this.modelFor('floor'),
        system: positionCardSystem(),
        prompt:
          positionCardPrompt(holdout, this.row.goal ?? this.row.topic, this.row.topic, this.row.personas, this.row.meta.contextBrief, this.row.meta.dossiers?.[holdout.id]) +
          contrarianAddendum(String(value.axis ?? ''), String(value.strongest_case ?? '')),
        thinking: this.thinking('floor'),
        debateId: this.id,
        label: `${holdout.id}:position:contrarian`,
      });
      const card = sanitizePositionCard(raw);
      if (!card) return;
      cards[holdout.id] = card;
      this.system(
        `Every expert, each writing blind, landed on the same side of the central question. ${holdout.name} has been re-briefed to hold the strongest honest case for the other side, so the consensus has to earn its ruling instead of inheriting it.`
      );
    } catch (err) {
      // An agreed room is a quality loss, never a dead session.
      console.error(`[debate ${this.id}] contrarian pass failed:`, err);
    }
  }

  private motionHost(): MotionHost {
    const self = this;
    return {
      id: this.id,
      model: this.modelFor('chair'),
      modelFor: (role) => self.modelFor(role),
      personas: this.row.personas,
      experts: this.experts,
      goal: this.row.goal ?? '',
      topic: this.row.topic,
      contextBrief: this.row.meta.contextBrief,
      config: this.row.config as any,
      get marcusSession() {
        return self.row.meta.sessions['marcus'];
      },
      setMarcusSession(id: string) {
        self.row.meta.sessions['marcus'] = id;
        self.saveMeta();
      },
      publish: (ev) => {
        self.publish(ev);
        // A call taken on the founder's behalf belongs in the record as much as their own answers do.
        if (ev?.type === 'assumption') appendTranscriptFile(self.id, `**Marcus, deciding for the founder:** ${ev.text}`);
      },
      publishMarcus: (t) => self.publishMarcus(t),
      system: (t) => self.system(t),
      /**
       * The live floor. Every turn in a checkpoint presents the SAME frozen
       * prefix (the checkpoint boundary), so the cache holds across it; what
       * was said since rides in each speaker's suffix.
       */
      floor: async (st, run) => {
        const floor = st.floor ?? self.newFloor(run.motionId);
        st.floor = floor;
        const res = await runFloor(self.floorHost(st), floor, { ...run, performing: st.performing ?? null });
        // The director's state at the checkpoint, for the room's display: who is hot, whose hand is up, the clock.
        const seats = self.directorSeats(run.motionId);
        const heat: Record<string, number> = {};
        for (const [k, v] of Object.entries(floor.heat)) heat[k] = Math.round(v * 100) / 100;
        self.publish({
          type: 'floor', motionId: run.motionId, heat,
          handsUp: seats.filter((s) => (floor.heat[s.id] ?? 0) >= (s.temperament?.interruptThreshold ?? 0.75) - 0.15).map((s) => s.id),
          clock: { elapsedSec: Math.round(floor.clock.elapsedSec), slotSec: floor.clock.slotSec },
        });
        return res;
      },
      windDown: async (st, checkpoint, boundary) => {
        const floor = st.floor ?? self.newFloor(st.motionId);
        st.floor = floor;
        return windDown(self.floorHost(st), floor, { motionId: st.motionId, checkpoint, boundary });
      },
      newFloor: (motionId) => self.newFloor(motionId),
      research: (q) => { void self.requestResearch(q, { askedBy: 'marcus', purpose: 'fact_check', motionId: self.activeMotionId }); },
      landedResearch: (motionId) => self.takeLandedResearch(motionId),
      pendingResearch: (motionId) => self.pendingResearch(motionId),
      compute: (q, motionId) => self.computeTask(q, motionId),
      revisePlan: (update) => { self.applyPlanUpdate(update); },
      reopen: (motionId, because) => { self.reopenMotion(motionId, because); },
      agenda: () => (self.row.plan?.items ?? []).map((i) => ({ id: i.id, title: i.title, status: i.status })),
      settled: () => self.row.meta.decisions.map((d) => ({ id: d.motionId, title: d.motionTitle })),
      reopened: () => self.row.meta.reopenedMotions ?? [],
      rounds: () => self.roundBudget(),
      length: () => self.lengthSpec(),
      remaining: (st) => self.motionRemaining(st),
      computations: () => self.row.meta.computations ?? [],
      redTeam: (decision, motionTitle, motion) => self.redTeamAttack(decision, motionTitle, motion),
      hasFiles: () => self.hasQuantDesk(),
      room: (boundarySeq) => self.roomBlocks(boundarySeq, self.activeMotionId),
      founder: () => self.humanName(),
      checkpoint: (st) => {
        self.row.meta.motionCheckpoint = st ? structuredClone({ ...st, performing: st.performing ?? null }) : null;
        self.saveMeta();
      },
      restore: (motionId) => {
        const cp = self.row.meta.motionCheckpoint;
        return cp && cp.motionId === motionId ? { ...structuredClone(cp), index: 0 } as any : null;
      },
      summon: (discipline, why, motion) => self.summonExpert(discipline, why, motion),
      askUser: (q) => self.askUserAndWait(q),
      researchInflight: () => self.researchRuns.size,
      stopped: () => self.killed || self.row.status !== 'meeting',
      endedByUser: () => { self.refresh(); return !!self.row.meta.endedByUser; },
      stage: (actor, label, detail) => Hub.stage(self.id, actor, label, detail),
      ceiling: () => self.ceilingGate(),
      thinking: (kind) => self.thinking(kind),
      minds: {
        open: (motionId, motion) => self.openBeliefs(motionId, motion),
        moves: (motionId) => self.unexplainedMoves(motionId),
        attribute: (motionId, ref, cause, source) => {
          const kinds = ['evidence', 'computation', 'argument', 'falsifier', 'founder', 'social', 'unexplained'] as const;
          const kind = (kinds as readonly string[]).includes(cause) ? cause as typeof kinds[number] : null;
          if (!kind || kind === 'unexplained') return;
          const src = source.trim();
          const who = self.row.personas.some((p) => p.id === src) ? src : undefined;
          const ref2 = !who && src ? src.slice(0, 40) : undefined;
          self.ledger({ type: 'attribute', motionId, messageId: ref, movedBy: { kind, ...(ref2 ? { ref: ref2 } : {}), ...(who ? { who } : {}) } });
        },
        checkpoint: (motionId) => { if (self.row.meta.ledger) self.ledger({ type: 'checkpoint', motionId, seq: Events.lastSeq(self.id) }); },
        dynamics: (motionId) => self.dynamicsFor(motionId),
      },
      rulingStakes: () => {
        const s = self.row.meta.stakes;
        if (!s) return null;
        return { owner: rulingOwner(s.stakes, undefined, self.humanName()), costYes: costOfBeingWrong(s, 'yes'), costNo: costOfBeingWrong(s, 'no') };
      },
    };
  }

  /**
   * Seats a new expert mid-session. The referee flags a discipline nobody at
   * the table has; the architect designs one person to fill exactly that gap,
   * and they take the floor immediately with an entrance line.
   * Capped at 3 additions per session so a panel cannot balloon.
   */
  private async summonExpert(discipline: string, why: string, motion: string): Promise<boolean> {
    const meta = this.row.meta;
    if ((meta.summonedCount ?? 0) >= 3) return false;

    this.system(`The room has hit a question none of the panel can answer: ${discipline}. Marcus is calling someone in.`);
    try {
      const roster = this.row.personas.map((p) => `- ${p.name} (${p.id}): ${p.role}`).join('\n');
      const { value } = await runJsonAgent<any>({
        model: this.modelFor('summon'),
        system: summonSystem(),
        prompt: summonPrompt(discipline, why, motion, roster, this.row.goal ?? ''),
        thinking: CFG.turnThinking,
        debateId: this.id,
        label: 'summon',
      });

      const taken = new Set(this.row.personas.map((p) => p.id));
      let id = String(value.id ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) || 'summoned';
      while (taken.has(id) || RESERVED_IDS.has(id)) id = `${id}x`;

      const name = String(value.name ?? 'Late Arrival');
      const persona: Persona = {
        id,
        name,
        role: String(value.role ?? discipline),
        tagline: String(value.tagline ?? ''),
        bio: String(value.bio ?? ''),
        expertise: Array.isArray(value.expertise) ? value.expertise.map(String).slice(0, 6) : [discipline],
        personality: String(value.personality ?? ''),
        biases: String(value.biases ?? ''),
        style: String(value.style ?? ''),
        color: PALETTE[this.row.personas.length % PALETTE.length],
        initials: (String(value.initials ?? '').slice(0, 2) || name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2)).toUpperCase(),
      };

      const roster2 = [...this.row.personas, persona];
      Debates.patch(this.id, { personas: roster2 });
      this.row.personas = roster2;
      writeAgentsFile(this.row);
      meta.summonedCount = (meta.summonedCount ?? 0) + 1;
      // A summoned expert gets a dossier from the same call shape, so they do not arrive generic (2a, item 5).
      if (meta.dossiers) {
        const d = await this.writeDossier(persona, roster2.filter((x) => !x.isModerator));
        if (d) {
          meta.dossiers[id] = d;
          (meta.dossierRoster ??= []).push({ id, name: persona.name, role: persona.role });
          if (meta.ledger) meta.ledger.traits[id] = { stubbornness: d.stubbornness, ...(d.priorPublicStance ? { priorPublicStance: d.priorPublicStance } : {}) };
        }
      }
      this.saveMeta();

      this.publish({ type: 'panel_amended', persona, reason: why || discipline });
      // They speak on arrival so the addition earns its seat immediately.
      const entrance = String(value.entrance ?? '').trim();
      if (entrance) {
        const mid = rid('m');
        this.publish({ type: 'message', id: mid, speaker: id, kind: 'floor', text: entrance });
        appendTranscriptFile(this.id, `**${persona.name} (joining):** ${entrance}`);
        meta.lastSeen[id] = Events.lastSeq(this.id);
        meta.floorCount++;
        this.saveMeta();
      }
      return true;
    } catch (err) {
      this.system('The call for another expert did not connect. The room carries on.');
      return false;
    }
  }

  /** Publishes a question and blocks until answered. */
  private async askUserAndWait(q: any): Promise<'answered' | 'ended'> {
    const questionId = rid('uq');
    this.publish({
      type: 'question',
      questionId,
      question: String(q.question ?? ''),
      context: String(q.context ?? ''),
      options: Array.isArray(q.options)
        ? q.options.slice(0, 4).map((o: any) => ({ label: String(o.label ?? o), description: String(o.description ?? '') }))
        : [],
      allowCustom: true,
    });
    appendTranscriptFile(this.id, `**Marcus asks the founder:** ${String(q.question ?? '')}`);
    this.row.meta.pendingQuestionId = questionId;
    this.saveMeta();
    const sig = await this.waitUser();
    if (sig.kind === 'end') {
      this.row.meta.pendingQuestionId = null;
      this.saveMeta();
      return 'ended';
    }
    return 'answered';
  }

  /**
   * The shared room record for one call. boundarySeq freezes the prefix at the
   * current round's start so every caller in the round presents a byte-identical
   * system prompt; see buildRoomBlocks for why that identity is the cost model.
   */
  private roomBlocks(boundarySeq: number, currentMotionId: string | null, projected: any[] = []) {
    const events = Events.since(this.id, 0);
    /**
     * The in-memory projection (2b-7): a turn still being performed is part of
     * what the next speaker will have heard by the time they speak, so it rides
     * in the live part of the record, exactly as it will be published.
     */
    const last = events.length ? events[events.length - 1].seq : 0;
    const now = Date.now();
    const extra = projected.map((e, i) => ({ ...e, seq: Math.max(last, boundarySeq) + 1 + i, ts: now })) as DebateEvent[];
    return buildRoomBlocks({
      events: extra.length ? [...events, ...extra] : events,
      personas: this.row.personas,
      goal: this.row.goal ?? '',
      topic: this.row.topic,
      contextBrief: this.row.meta.contextBrief,
      boundarySeq,
      currentMotionId,
      founder: this.humanName(),
      hasDesk: this.hasQuantDesk(),
      reputations: reputations(this.row.meta.dossiers),
      stakes: this.row.meta.stakes ? stakesBlock(this.row.meta.stakes) : null,
    });
  }

  // ---------- the belief ledger (2b-5) ----------

  /** Feed the ledger one input and act on what it emits: persist beliefs and concessions. */
  private ledger(input: LedgerInput): LedgerEmit[] {
    const meta = this.row.meta;
    if (!meta.ledger) return [];
    const { state, emits } = reduceLedger(meta.ledger, input);
    meta.ledger = state;
    for (const e of emits) {
      if (e.type === 'belief') this.publish({ type: 'belief', motionId: e.motionId, beliefs: e.beliefs });
      else if (e.type === 'concession' || e.type === 'concession_update') this.publish({ type: 'concession', concession: e.concession });
    }
    this.saveMeta();
    return emits;
  }

  /**
   * Starting stances when a motion opens: one fast-tier clerk call reads them
   * off the position cards. A failure costs only the head start; the ledger
   * then takes each expert's first STANCE line as their starting point.
   */
  private async openBeliefs(motionId: string, motion: string) {
    const meta = this.row.meta;
    if (!meta.ledger || meta.ledger.motions[motionId]) return;
    const cards = meta.positionCards ?? {};
    const carded = this.experts.filter((p) => cards[p.id]);
    let beliefs: import('../../../shared/types.ts').Belief[] = [];
    const seq = Events.lastSeq(this.id);
    if (carded.length) {
      try {
        const { value } = await runJsonAgent<any>({
          model: this.modelFor('clerk'),
          system: stanceClerkSystem(),
          prompt: stanceClerkPrompt(motion, carded.map((p) => ({ id: p.id, name: p.name, thesis: cards[p.id].thesis, redLine: cards[p.id].redLine, falsifier: cards[p.id].falsifier }))),
          thinking: 0,
          timeoutMs: 120_000,
          debateId: this.id,
          label: 'clerk:stances',
        });
        const seen = new Set<string>();
        beliefs = (Array.isArray(value?.stances) ? value.stances : [])
          .filter((s: any) => carded.some((p) => p.id === String(s?.expert)) && !seen.has(String(s.expert)) && seen.add(String(s.expert)))
          .map((s: any) => ({
            expert: String(s.expert),
            motionId,
            stance: Math.max(-2, Math.min(2, Math.round(Number(s.stance) || 0))) as Stance,
            confidence: ['low', 'medium', 'high'].includes(s.confidence) ? s.confidence : 'medium',
            crux: String(s.crux ?? '').slice(0, 200),
            reasons: [],
            sinceSeq: seq,
          }));
      } catch (err) {
        if (asUsageLimit(err) || abortedByUser(err)) throw err;
        console.error(`[debate ${this.id}] starting stances failed; the first trailers will set them:`, err);
      }
    }
    this.ledger({ type: 'open', motionId, seq, beliefs });
  }

  /** Stance moves on the open motion nobody explained, for the referee to attribute. */
  private unexplainedMoves(motionId: string) {
    const m = this.row.meta.ledger?.motions[motionId];
    if (!m) return [];
    const nameOf = (id: string) => this.row.personas.find((p) => p.id === id)?.name ?? id;
    return m.flags
      .filter((f): f is Extract<typeof f, { kind: 'unexplained_move' }> => f.kind === 'unexplained_move' && !f.resolved)
      .map((f) => {
        const c = m.concessions.find((x) => x.messageId === f.messageId);
        return {
          ref: f.messageId,
          expert: nameOf(f.expert),
          from: c ? STANCE_LABEL[c.from.stance as Stance] : '?',
          to: c ? STANCE_LABEL[c.to.stance as Stance] : '?',
          candidates: f.candidates,
        };
      })
      .slice(0, 6);
  }

  /** What the ledger says the chair should act on, as plain lines. Each trigger is raised once. */
  private dynamicsFor(motionId: string): string[] {
    const meta = this.row.meta;
    if (!meta.ledger) return [];
    const since = meta.ledgerTriggerSeq?.[motionId] ?? -Infinity;
    const flags = ledgerChairTriggers(meta.ledger, motionId, since);
    if (!flags.length) return [];
    (meta.ledgerTriggerSeq ??= {})[motionId] = Math.max(...flags.map((f) => ('seq' in f ? f.seq : 0)));
    this.saveMeta();
    const nameOf = (id: string) => this.row.personas.find((p) => p.id === id)?.name ?? id;
    return flags.map((f) => triggerLine(f, nameOf)).filter((l): l is string => !!l);
  }

  /**
   * The private card for one expert's turn: how they talk, what they stand to
   * gain or lose on this motion, where they stand now. Only theirs, only in
   * their own suffix.
   */
  private privateCard(speakerId: string): string {
    const meta = this.row.meta;
    const d = meta.dossiers?.[speakerId];
    if (!d) return '';
    const motionId = this.activeMotionId;
    const item = motionId ? this.row.plan?.items.find((i) => i.id === motionId) : undefined;
    const card = voiceCard(d, {
      motion: item ? (item.motion ?? `${item.title} ${item.detail}`) : '',
      ticUse: motionId ? meta.ticUse?.[motionId]?.[speakerId] : undefined,
      belief: motionId && meta.ledger ? ownBelief(meta.ledger, motionId, speakerId) : undefined,
    });
    const nameOf = (id: string) => this.row.personas.find((p) => p.id === id)?.name ?? id;
    const rel = d.relationships.filter((r) => this.row.personas.some((p) => p.id === r.with)).slice(0, 3)
      .map((r) => `${nameOf(r.with)} (${r.kind}: ${r.note})`);
    // A whisper reaches only the person it was whispered to, and only in their own suffix.
    const asides = (this.motionEvents(motionId) as any[]).filter((e) => e.type === 'aside' && e.to === speakerId).slice(-2)
      .map((e) => `${nameOf(e.from)} leaned over and said to you, privately: "${String(e.text).slice(0, 160)}"`);
    return `HOW YOU COME ACROSS (private to you; never recite it)\n${card}${rel.length ? `\nIn this room: ${rel.join('; ')}.` : ''}${asides.length ? `\n${asides.join('\n')}` : ''}`;
  }

  /** The word budget for a turn shape, using the speaker's own natural length for a set piece. */
  private budgetFor(shape: LintShape, speakerId: string): { min: number; max: number } {
    const base = WORD_BUDGET[shape];
    const typical = this.row.meta.dossiers?.[speakerId]?.speech.typicalWords;
    if (shape !== 'set_piece' || !typical) return base;
    return { min: Math.min(base.min, Math.max(20, Math.round(typical / 2))), max: Math.max(60, Math.min(160, typical)) };
  }

  /** The record of one motion, from its (latest) opening. Empty when no motion is named. */
  private motionEvents(motionId: string | null): DebateEvent[] {
    if (!motionId) return [];
    const events = Events.since(this.id, 0);
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === 'motion_open' && e.motionId === motionId) return events.slice(i);
    }
    return [];
  }

  /**
   * A closing statement. Closings are not run through the floor director:
   * every expert gives one, in seat order, streamed as written.
   */
  private async closingTurn(speakerId: string): Promise<boolean> {
    const kind = 'closing' as const;
    const meta = this.row.meta;
    const p = this.row.personas.find((x) => x.id === speakerId);
    if (!p) return false;
    /**
     * Stateless voice over the shared record. The persona has no private
     * session: the room (system prompt) is identical for every closer and
     * cached across them, and everything persona-specific rides in this small
     * fresh suffix. Closing statements deliberately get no position card: the
     * concession rule that travels with it would turn a closing into a defence.
     */
    const boundary = this.wrapStartSeq ?? Events.lastSeq(this.id);
    const room = this.roomBlocks(boundary, null);
    const shape = 'closing' as const;
    const turn: TurnSpec = { shape, words: this.budgetFor(shape, speakerId) };
    const prompt = closingSuffix(p, room.roundSoFar, this.hasQuantDesk(), turn, this.privateCard(speakerId));

    const messageId = rid('m');
    this.live({ type: 'speaking', speaker: speakerId, phase: 'thinking' });
    let lastThink = 0;
    let firstDelta = true;
    /**
     * The trailer is held back while the turn streams, so the founder never
     * sees a STANCE or COMPUTE line flash up and vanish. The published message
     * replaces the stream either way.
     */
    const filter = new TrailerStreamFilter((textDelta) => {
      if (firstDelta) {
        firstDelta = false;
        this.live({ type: 'speaking', speaker: speakerId, phase: 'talking' });
      }
      this.live({ type: 'delta', messageId, speaker: speakerId, kind, textDelta });
    });

    try {
      const res = await runAgent({
        model: this.modelFor('floor'),
        system: room.system,
        prompt,
        thinking: this.thinking('reply'),
        debateId: this.id,
        label: `${speakerId}:${kind}`,
        onDelta: (text) => filter.push(text),
        onThinking: () => {
          const now = Date.now();
          if (now - lastThink > 3000) {
            lastThink = now;
            this.live({ type: 'speaking', speaker: speakerId, phase: 'thinking' });
          }
        },
      });

      /**
       * The trailer comes off first: it is an instruction and a record for the
       * server, not something the expert said, and nothing that measures,
       * lints or publishes this turn may count it as speech.
       */
      const { text: spoken, trailer } = splitTrailer(res.text);
      if (!spoken) throw new Error(`${speakerId}:${kind} produced a trailer and no speech`);
      // The speaker's grades are checked before anyone reads them: a persona's backstory is never "observed".
      trailer.claims = regradeClaims(trailer.claims, this.provenance());
      const motionKey = this.activeMotionId ?? '_closing';
      const prev = meta.stances?.[motionKey]?.[speakerId];
      const stanceMoved = prev && trailer.stance ? prev.stance !== trailer.stance.stance : null;

      /**
       * Lint, and rewrite the form on the fast tier when the score calls for
       * it. This replaced a flagship "too long, say it again under 100 words"
       * re-run that fired on up to 40% of floor turns at flagship price, and
       * that was itself setting how the room sounded.
       */
      const linted = await lintAndRewrite(
        spoken,
        this.lintContext(speakerId, shape, kind, stanceMoved),
        { name: p.name, style: p.style },
        this.rewriter(speakerId)
      );
      const text = linted.text;

      this.publish({
        type: 'message', id: messageId, speaker: speakerId, kind, text,
        ...(trailer.claims?.length ? { claims: trailer.claims } : {}),
        lint: linted.record,
      });
      appendTranscriptFile(
        this.id,
        `**${p.name} (closing):** ${text}` +
          (trailer.claims?.length ? `\n\n_Claims: ${trailer.claims.map((c) => `${claimTag(c)} ${c.text}`).join('; ')}_` : '')
      );
      meta.spentUsd += res.costUsd ?? 0;
      if (trailer.stance) {
        ((meta.stances ??= {})[motionKey] ??= {})[speakerId] = { ...trailer.stance, seq: Events.lastSeq(this.id) };
      }
      this.saveMeta();
      return true;
    } catch (err) {
      Hub.dropPartial(this.id, messageId);
      throwIfLimited(this.id);   // a spent allowance pauses the room; it is not a lost train of thought
      this.system(`${p.name} lost their train of thought (turn failed). Marcus keeps the room moving.`);
      return false;
    } finally {
      this.live({ type: 'speaking', speaker: null, phase: null });
    }
  }

  /**
   * After a turn is heard: the speaker's habits count against this motion's
   * budget, and their STANCE line goes through the belief ledger, which
   * publishes any concession with what moved it.
   */
  private afterSpoken(speakerId: string, messageId: string, text: string, trailer: import('./trailer.ts').Trailer, kind: string, seq: number) {
    const meta = this.row.meta;
    const motionId = this.activeMotionId;
    if (!motionId || kind === 'closing') return;
    // The latest stated stance, server-side: the linter and the crux clerk read it.
    if (trailer.stance) ((meta.stances ??= {})[motionId] ??= {})[speakerId] = { ...trailer.stance, seq };
    const d = meta.dossiers?.[speakerId];
    if (d?.speech.tics.length) {
      const used = ruleTics(text, d.speech.tics.map((t) => ({ ...t, used: 0 }))).used;
      if (used.length) {
        const mine = (((meta.ticUse ??= {})[motionId] ??= {})[speakerId] ??= {});
        for (const t of used) mine[t] = (mine[t] ?? 0) + 1;
      }
    }
    if (meta.ledger) this.ledger({ type: 'turn', motionId, seq, expert: speakerId, messageId, report: stanceReport(trailer) });
  }

  // ---------- the live floor (2b-7) ----------

  /** A fresh floor for a motion, seeded from the session's own words so a replay makes the same choices. */
  private newFloor(motionId: string): FloorState {
    const seats = this.directorSeats(motionId);
    const motions = Math.max(1, this.scope.motions);
    // The meeting clock: a slot from the turns a motion of this depth runs (about seven a checkpoint, plus reactions).
    const turns = Math.round(this.scope.roundsPerMotion * 7 * 1.4) * motions;
    return newDirectorFloor(motionId, seats, `${this.row.topic}:${motionId}`, slotSecFor(turns, motions));
  }

  /**
   * The seats as the director sees them: temperament and natural length from
   * the dossier, air-time weight from dominance and conviction, and whether
   * the crux on the table turns on them (the relevance rule).
   */
  private directorSeats(motionId: string): DirectorSeat[] {
    const meta = this.row.meta;
    const m = meta.ledger?.motions[motionId];
    const hits = new Set(meta.cruxHits?.[motionId] ?? []);
    return this.experts.map((p) => {
      const d = meta.dossiers?.[p.id];
      const b = m?.beliefs[p.id];
      const relevant = (!!b && !!b.crux && Math.abs(b.stance) >= 1) || hits.has(p.id);
      return {
        id: p.id,
        ...(d ? { temperament: d.temperament, typicalWords: d.speech.typicalWords } : {}),
        weight: Math.max(0.5, Math.min(1.8, 0.7 + (d?.temperament.dominance ?? 0.5) * 0.6 + (b ? Math.abs(b.stance) * 0.15 : 0))),
        relevant,
      };
    });
  }

  /** The runner's side of the live floor: models, publishing, the database. */
  private floorHost(st: MotionState): FloorHost {
    const self = this;
    const profile = this.profile;
    return {
      seats: (motionId) => self.directorSeats(motionId),
      interruptCap: () => (profile ? BUDGET_PROFILES[profile].interruptCap : DIRECTOR_RULES.interruptCap),
      asidesAllowed: () => (profile ? BUDGET_PROFILES[profile].asides : false),
      generate: (req) => self.generateTurn(req),
      react: (turn, motionId, allowAside) => self.reactTo(turn, motionId, allowAside),
      perform: (turn, plan, motionId) => self.performTurn(turn, plan, motionId),
      pause: (ms, reason) => self.pauseFor(ms, reason),
      chair: (reason) => self.chairLine(reason),
      afterTurn: (turn, checkpoint, mayCallDesk) => self.afterFloorTurn(turn, checkpoint, mayCallDesk),
      dynamics: (motionId) => self.dynamicsFor(motionId),
      landed: (motionId) => self.landedForFloor(motionId),
      save: (floor, performing) => {
        st.floor = floor;
        st.performing = performing;
        self.row.meta.motionCheckpoint = structuredClone({ ...st, performing });
        self.saveMeta();
      },
      stopped: () => self.killed || self.row.status !== 'meeting',
      endedByUser: () => { self.refresh(); return !!self.row.meta.endedByUser; },
      throwIfLimited: () => throwIfLimited(self.id),
      nameOf: (id) => self.row.personas.find((p) => p.id === id)?.name ?? id,
    };
  }

  /**
   * Write one floor turn in full, lint it, and hand it back unheard. Nothing
   * is published here: the performance does that, with only the heard words.
   * The prompt is built against the projection (the persisted record plus
   * the turn still being performed), so it carries exactly what the room will
   * have heard, and never a cut turn's unsaid remainder.
   */
  private async generateTurn(req: GenerateRequest): Promise<GeneratedTurn | null> {
    const meta = this.row.meta;
    const p = this.row.personas.find((x) => x.id === req.speaker);
    if (!p) return null;
    const room = this.roomBlocks(req.boundary, this.activeMotionId, req.projected);
    const card = meta.positionCards?.[req.speaker];
    const lintShape: LintShape = req.shape;
    const words = req.shape === 'set_piece' ? this.budgetFor('set_piece', req.speaker) : { min: WORD_BUDGET.reply.min, max: req.words };
    const turn: TurnSpec = { shape: req.shape, words };
    const clock = this.activeMotionId && meta.motionCheckpoint?.floor ? clockLine(meta.motionCheckpoint.floor.clock) : '';
    const extra = [this.privateCard(req.speaker), clock ? `THE CLOCK: ${clock}` : ''].filter(Boolean).join('\n\n');
    /**
     * The desk syntax is offered only where it can actually be answered;
     * hasQuantDesk() is the same gate computeTask enforces. RESEARCH is offered
     * only while the desk can still take one on this motion.
     */
    const prompt = floorSuffix(p, room.roundSoFar, req.checkpoint, req.direction, req.pressure, this.hasQuantDesk() && req.mayCallDesk, card, turn,
      !!this.activeMotionId && this.researchLeft(this.activeMotionId) > 0, extra);
    this.live({ type: 'speaking', speaker: req.speaker, phase: 'thinking' });
    try {
      const res = await runAgent({
        model: this.modelFor('floor'),
        system: room.system,
        prompt,
        // A set piece thinks at the floor budget; a reply at the reply budget.
        thinking: req.shape === 'set_piece' ? this.thinking('floor') : this.thinking('reply'),
        debateId: this.id,
        label: `${req.speaker}:floor`,
      });
      meta.spentUsd += res.costUsd ?? 0;
      // The trailer comes off first: it is a record for the server, not something the expert said.
      const { text: spoken, trailer } = splitTrailer(res.text);
      if (!spoken) throw new Error(`${req.speaker}:floor produced a trailer and no speech`);
      trailer.claims = regradeClaims(trailer.claims, this.provenance());
      const motionKey = this.activeMotionId ?? '_closing';
      const prev = meta.stances?.[motionKey]?.[req.speaker];
      const stanceMoved = prev && trailer.stance ? prev.stance !== trailer.stance.stance : null;
      const ctx = this.lintContext(req.speaker, lintShape, 'floor', stanceMoved);
      const linted = await lintAndRewrite(spoken, { ...ctx, budget: words }, { name: p.name, style: p.style }, this.rewriter(req.speaker));
      const to = trailer.ask && this.experts.some((e) => e.id === trailer.ask!.to) ? [trailer.ask.to] : undefined;
      return {
        id: rid('m'),
        speaker: req.speaker,
        shape: req.shape,
        text: linted.text,
        ...(to ? { to } : {}),
        ...(trailer.claims?.length ? { claims: trailer.claims } : {}),
        lint: linted.record,
        trailer,
        ...(req.replyTo ? { replyTo: req.replyTo } : {}),
      };
    } catch (err) {
      throwIfLimited(this.id);   // a spent allowance pauses the room; it is not a lost train of thought
      if (abortedByUser(err)) return null;
      this.system(`${p.name} lost their train of thought (turn failed). The room carries on.`);
      return null;
    } finally {
      this.live({ type: 'speaking', speaker: null, phase: null });
    }
  }

  /**
   * How the listeners take a turn, sentence by sentence: one fast-tier call
   * for everyone. A failure means nobody reacts, never a lost turn.
   */
  private async reactTo(turn: GeneratedTurn, motionId: string, allowAside: boolean): Promise<{ reactions: Reaction[]; aside?: { from: string; to: string; text: string } | null }> {
    const meta = this.row.meta;
    const listeners = this.experts.filter((p) => p.id !== turn.speaker);
    if (!listeners.length) return { reactions: [] };
    const floor = meta.motionCheckpoint?.floor;
    const sentences = splitSentences(turn.text).map((s) => s.text);
    if (sentences.length < 1) return { reactions: [] };
    const cards = listeners.map((p) => {
      const b = meta.ledger ? ownBelief(meta.ledger, motionId, p.id) : undefined;
      const d = meta.dossiers?.[p.id];
      const heat = floor?.heat[p.id] ?? 0.2;
      const threshold = d?.temperament.interruptThreshold ?? 0.75;
      return {
        id: p.id, name: p.name, role: p.role,
        stance: b ? STANCE_LABEL[b.stance] : 'stance unknown',
        crux: b?.crux ?? '',
        heat: heat > 0.7 ? 'hot' : heat > 0.4 ? 'warm' : 'calm',
        cutsIn: threshold < 0.55 ? 'cuts in readily' : threshold > 0.85 ? 'rarely cuts in' : 'cuts in when it matters',
        ...(d ? { register: d.speech.register } : {}),
      };
    });
    const speaker = this.row.personas.find((p) => p.id === turn.speaker)?.name ?? turn.speaker;
    try {
      const { value } = await runJsonAgent<any>({
        model: this.modelFor('react'),
        system: reactionSystem(),
        prompt: reactionPrompt(speaker, sentences, cards, allowAside),
        thinking: 0,
        timeoutMs: 120_000,
        debateId: this.id,
        label: 'react',
      });
      const ids = new Set(listeners.map((l) => l.id));
      const clip = (v: unknown, words: number) => {
        const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
        return s && s.split(' ').length <= words ? s : null;
      };
      const reactions: Reaction[] = (Array.isArray(value?.reactions) ? value.reactions : [])
        .filter((r: any) => ids.has(String(r?.listener)))
        .map((r: any) => ({
          listener: String(r.listener),
          intensity: Math.max(0, Math.min(3, Math.round(Number(r.intensity) || 0))),
          atSentence: Math.max(0, Math.round(Number(r.atSentence) || 0)),
          cutIn: clip(r.cutIn, 14),
          backchannel: clip(r.backchannel, 10),
          wantsFloor: r.wantsFloor === true,
        }));
      const a = value?.aside;
      const aside = allowAside && a && ids.has(String(a.from)) && ids.has(String(a.to)) && clip(a.text, 16)
        ? { from: String(a.from), to: String(a.to), text: clip(a.text, 16)! }
        : null;
      return { reactions, aside };
    } catch (err) {
      throwIfLimited(this.id);
      if (!abortedByUser(err)) console.error(`[debate ${this.id}] reaction call failed; nobody reacts to this turn:`, err);
      return { reactions: [] };
    }
  }

  /**
   * Perform a planned turn to the room: the words at speaking pace, the cut-in
   * over the speaker's last words, the silence after it, the resumed remainder
   * or the trailing reaction. Each message is published when its performance
   * ends, carrying only the words heard.
   */
  private async performTurn(turn: GeneratedTurn, plan: PerformPlan, motionId: string): Promise<{ concession: boolean; words: number }> {
    const meta = this.row.meta;
    const events = plannedEvents(turn, plan);
    const nameOf = (id: string) => this.row.personas.find((p) => p.id === id)?.name ?? id;
    let concession = false;
    let words = 0;
    const pace = CFG.speakingPace;
    const nap = (n: number) => (pace > 0 && !this.killed ? new Promise<void>((r) => setTimeout(r, (n / pace) * 1000)) : Promise.resolve());
    const chunks = (text: string) => {
      const w = text.split(' ');
      const out: string[] = [];
      for (let i = 0; i < w.length; i += 2) out.push((i ? ' ' : '') + w.slice(i, i + 2).join(' '));
      return out;
    };
    const stream = async (ev: any, from = 0, to = Infinity, over?: { ev: any; queue: string[] }) => {
      const parts = chunks(ev.text);
      let at = 0;
      for (const c of parts) {
        const start = at;
        at += c.length;
        if (start < from || start >= to) continue;
        this.live({ type: 'delta', messageId: ev.id, speaker: ev.speaker, kind: ev.kind, textDelta: c });
        if (over && over.queue.length) this.live({ type: 'delta', messageId: over.ev.id, speaker: over.ev.speaker, kind: over.ev.kind, textDelta: over.queue.shift()! });
        await nap(c.trim().split(' ').length);
      }
    };
    const publishMessage = (ev: any) => {
      const full = this.publish(ev);
      words += ev.text.split(/\s+/).filter(Boolean).length;
      meta.floorCount++;
      meta.lastSpeaker = ev.speaker;
      const over = ev.overlap ? ` (over ${nameOf(this.messageSpeaker(events, ev.overlap.with) ?? '').toUpperCase()})` : '';
      const cut = ev.cutOff ? `— [cut off by ${nameOf(ev.cutOff.by).toUpperCase()}]` : '';
      appendTranscriptFile(this.id, `**${nameOf(ev.speaker)}${over}:** ${ev.text}${cut}` +
        (ev.claims?.length ? `\n\n_Claims: ${ev.claims.map((c: any) => `${claimTag(c)} ${c.text}`).join('; ')}_` : ''));
      return full;
    };

    this.live({ type: 'speaking', speaker: turn.speaker, phase: 'talking' });
    try {
      const main = events[0];
      if (plan.cut) {
        const cutIn = events[1];
        // The speaker alone, then the cut-in starts over their last words; both streams are open at once.
        await stream(main, 0, plan.cut.overlapFrom);
        await stream(main, plan.cut.overlapFrom, Infinity, { ev: cutIn, queue: chunks(cutIn.text) });
        const pub = publishMessage(main);
        this.afterSpoken(turn.speaker, turn.id, main.text, turn.trailer, 'floor', (pub as any)?.seq ?? Events.lastSeq(this.id));
        const sent = Math.min(chunks(cutIn.text).length, chunks(main.text.slice(plan.cut.overlapFrom)).length);
        await stream(cutIn, chunks(cutIn.text).slice(0, sent).join('').length);
        publishMessage(cutIn);
        if (plan.tensionMs) await this.pauseFor(plan.tensionMs, 'tension');
        if (events[2] && events[2].id === plan.cut.resumeId) {
          await stream(events[2]);
          publishMessage(events[2]);
        }
      } else {
        const trail = plan.trailing?.overlap ? events[events.length - 1] : null;
        if (trail) {
          const from = trail.overlap.fromChar;
          await stream(main, 0, from);
          await stream(main, from, Infinity, { ev: trail, queue: chunks(trail.text) });
        } else {
          await stream(main);
        }
        const pub = publishMessage(main);
        this.afterSpoken(turn.speaker, turn.id, main.text, turn.trailer, 'floor', (pub as any)?.seq ?? Events.lastSeq(this.id));
      }
      if (plan.trailing) {
        const trail = events[events.length - 1];
        if (!plan.trailing.overlap || plan.cut) await stream(trail);
        else {
          const sent = Math.min(chunks(trail.text).length, chunks(main.text.slice(trail.overlap.fromChar)).length);
          await stream(trail, chunks(trail.text).slice(0, sent).join('').length);
        }
        publishMessage(trail);
      }
      if (plan.aside) this.publish({ type: 'aside', id: plan.aside.id, from: plan.aside.from, to: plan.aside.to, text: plan.aside.text });
      // A concession this turn emitted, with a cause: the room goes quiet for a beat.
      const m = meta.ledger?.motions[motionId];
      concession = !!m?.concessions.some((c) => c.messageId === turn.id && c.movedBy.kind !== 'unexplained');
      this.saveMeta();
      return { concession, words };
    } finally {
      for (const ev of events) Hub.dropPartial(this.id, ev.id);
      this.live({ type: 'speaking', speaker: null, phase: null });
    }
  }

  /** Who said a message, from the planned events or the record. */
  private messageSpeaker(planned: any[], id: string): string | undefined {
    const p = planned.find((e) => e.id === id);
    if (p) return p.speaker;
    const e = Events.since(this.id, 0).find((x) => x.type === 'message' && x.id === id) as any;
    return e?.speaker;
  }

  /**
   * The next research finding on this motion nobody has answered: the expert
   * whose crux it hits answers it, else the expert who asked. Handed out once.
   */
  private landedForFloor(motionId: string): { speaker: string; direction: string } | null {
    const meta = this.row.meta;
    const l = (meta.researchLanded ?? []).find((x) => x.motionId === motionId && !x.floored);
    if (!l) return null;
    l.floored = true;
    this.saveMeta();
    const hit = l.hits.find((h) => this.experts.some((e) => e.id === h.expert));
    const speaker = hit?.expert ?? (this.experts.some((e) => e.id === l.askedBy) ? l.askedBy : null);
    if (!speaker) return null;
    const nameOf = (id: string) => (id === 'marcus' ? 'the chair' : this.row.personas.find((p) => p.id === id)?.name ?? id);
    const effect = hit ? `, and it ${hit.effect} what your position turns on` : '';
    return { speaker, direction: `the desk has answered ${speaker === l.askedBy ? 'your' : `${nameOf(l.askedBy)}'s`} question ("${l.question.slice(0, 160)}")${effect}. Its answer is in the record. Take it on, now.` };
  }

  /** A silence on the performance timeline, persisted, and actually waited at speaking pace. */
  private async pauseFor(ms: number, reason: 'after_concession' | 'unanswered' | 'tension' | 'chair') {
    this.publish({ type: 'pause', ms, reason });
    if (CFG.speakingPace > 0 && !this.killed) await new Promise((r) => setTimeout(r, ms * (2.5 / CFG.speakingPace)));
  }

  /**
   * The chair on a trigger: one or two sentences to the person concerned, on
   * the flagship, against the shared record. A failure costs only the line.
   */
  private async chairLine(reason: string): Promise<boolean> {
    const room = this.roomBlocks(Events.lastSeq(this.id) + 1, this.activeMotionId);
    const stage = Hub.stage(this.id, 'marcus', 'Marcus steps in', reason.slice(0, 200));
    try {
      const res = await runAgent({
        model: this.modelFor('chair'),
        system: room.system,
        prompt: [marcusVoice(this.row.config, this.humanName()), chairLinePrompt(reason, 40)].join('\n\n'),
        thinking: this.thinking('reply'),
        debateId: this.id,
        label: 'marcus:floor',
      });
      const { text } = splitTrailer(res.text);
      const line = text.replace(/\s+/g, ' ').trim().replace(/^"(.*)"$/, '$1');
      if (!line) return false;
      this.publishMarcus(line.split(/\s+/).slice(0, 60).join(' '));
      return true;
    } catch (err) {
      throwIfLimited(this.id);
      return false;
    } finally {
      stage.close();
    }
  }

  /**
   * What rides on a performed turn: research goes out in the background, a
   * desk calculation stops the room and comes back to the speaker. Returns
   * the direction for that answer, or null.
   */
  private async afterFloorTurn(turn: GeneratedTurn, checkpoint: number, mayCallDesk: boolean): Promise<string | null> {
    if (turn.trailer.research && this.activeMotionId) {
      void this.requestResearch(turn.trailer.research, { askedBy: turn.speaker, purpose: 'crux', motionId: this.activeMotionId });
    }
    if (turn.trailer.compute && mayCallDesk) {
      const ok = await this.deskCall(turn.speaker, turn.trailer.compute, checkpoint);
      if (ok && !this.killed && this.row.status === 'meeting') return deskAnswerDirection(turn.trailer.compute);
    }
    return null;
  }

  /** What the linter needs to know about the room around a turn. */
  private lintContext(speakerId: string, shape: LintShape, kind: 'floor' | 'interjection' | 'closing', stanceMoved: boolean | null): LintContext {
    const events = Events.since(this.id, 0);
    const spoken = events.filter(
      (e): e is Extract<DebateEvent, { type: 'message' }> =>
        e.type === 'message' && (e.kind === 'floor' || e.kind === 'interjection' || e.kind === 'closing' || e.kind === 'reaction')
    );
    let motionFrom = 0;
    if (this.activeMotionId) {
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (e.type === 'motion_open' && e.motionId === this.activeMotionId) { motionFrom = e.seq; break; }
      }
    }
    const antithesisSoFar = spoken
      .filter((e) => e.seq >= motionFrom)
      .reduce((n, e) => n + (e.text.match(ANTITHESIS_ALL)?.length ?? 0), 0);
    const firstName = (n: string) => n.replace(/^(dr|prof|mr|mrs|ms)\.?\s+/i, '').split(/\s+/)[0] ?? '';
    const d = this.row.meta.dossiers?.[speakerId];
    return {
      shape,
      budget: this.budgetFor(shape, speakerId),
      speaker: speakerId,
      // The founder's name only when one is configured: the fallback "the founder" is not a name.
      names: [...this.row.personas.map((p) => firstName(p.name)), CFG.founderName ? firstName(CFG.founderName) : ''].filter(Boolean),
      chairName: firstName(MARCUS.name),
      replyToColleague: shape === 'reply' || kind === 'interjection',
      recent: spoken.slice(-30).map((e) => ({ speaker: e.speaker, text: e.text })),
      stanceMoved,
      antithesisSoFar,
      ...(d ? {
        neverSay: d.speech.neverSay,
        tics: d.speech.tics.map((t) => ({ ...t, used: (this.activeMotionId ? this.row.meta.ticUse?.[this.activeMotionId]?.[speakerId]?.[t.text] : 0) ?? 0 })),
      } : {}),
    };
  }

  /** The fast-tier rewriter the linter calls. Billed like any other turn. */
  private rewriter(speakerId: string): Rewriter {
    return async (req) => {
      const res = await runAgent({
        model: this.modelFor('lint'),
        system: req.system,
        prompt: req.prompt,
        thinking: 0,
        timeoutMs: 120_000,
        debateId: this.id,
        label: `${speakerId}:lint`,
      });
      this.row.meta.spentUsd += res.costUsd ?? 0;
      return res.text;
    };
  }

  /**
   * An expert stops the room to have a figure computed, then answers it.
   *
   * Before this, the desk could only be dispatched by Marcus, once, between
   * rounds: a hard ceiling of ONE measured number per round for a room of
   * sixteen, and anyone who thought a figure was wrong had to petition the
   * chair and wait for the next steer. The 7 Aug probe measured the result,
   * with experts asking Marcus to "get the desk" a number in 7 of 11 turns.
   *
   * The follow-up turn is the whole point of the feature, not a courtesy: a
   * named person holding a number that was measured rather than argued, handed
   * back the floor while the exchange that produced it is still live. Running
   * the desk and then moving on to the next scheduled speaker would leave the
   * figure in the transcript with nobody obliged to answer it.
   */
  private async deskCall(speakerId: string, question: string, checkpoint: number): Promise<boolean> {
    if (!this.hasQuantDesk()) return false;          // same gate the prompt was written under
    const key = `${this.activeMotionId ?? '-'}:${checkpoint}`;
    if (this.deskCalls.key !== key) this.deskCalls = { key, used: 0 };
    if (this.deskCalls.used >= DESK_CALLS_PER_ROUND) {
      console.log(`[debate ${this.id}] ${speakerId} asked the desk for "${question}" past the checkpoint's limit; dropped`);
      // The ask was made and not served: the room and the transcript are told,
      // so a dropped call is a fact on the record instead of a silent nothing.
      const who = this.row.personas.find((p) => p.id === speakerId)?.name ?? speakerId;
      this.system(`${who} sent the desk a calculation, but the desk is at its two-call limit until the next checkpoint. The question is on the record: "${question.slice(0, 200)}". Ask again later if it still matters.`);
      return false;
    }
    this.deskCalls.used++;

    try {
      await this.computeTask(question, this.activeMotionId);
      // The follow-up turn is the point: the speaker gets the floor back to answer the number (floor.ts).
      return true;
    } catch (err) {
      // A desk call that fails costs the room a pause, never the checkpoint.
      console.error('[quant] expert desk call failed:', err);
      return false;
    }
  }

  // ---------- the research desk (2b-4) ----------

  /**
   * Research requests the room may still send on a motion: the profile's
   * per-motion allowance, held to one on the Codex door for quick and
   * standard (its turns are serialised per credential, so research there
   * stops the floor while it runs), and never past the session cap.
   */
  private researchLeft(motionId: string | null): number {
    const p = this.profile;
    const meta = this.row.meta;
    const session = p ? BUDGET_PROFILES[p].researchCap - (meta.researchCount ?? 0) : Infinity;
    if (!motionId) return Math.max(0, session);
    let perMotion = p ? BUDGET_PROFILES[p].researchPerMotion : 2;
    if (this.provider === 'codex' && p !== 'deep') perMotion = Math.min(perMotion, 1);
    return Math.max(0, Math.min(session, perMotion - (meta.researchByMotion?.[motionId] ?? 0)));
  }

  /**
   * Send the research desk a question. It runs in the background: the room
   * keeps arguing, and the answer lands as a moment, not a document. Returns
   * the run, or null when the allowance is spent (the room is told).
   */
  private requestResearch(
    question: string,
    from: { askedBy: string; purpose: ResearchRequest['purpose']; motionId?: string | null }
  ): Promise<void> | null {
    const meta = this.row.meta;
    if (!question.trim()) return null;
    /**
     * Every question is model-written by a seat that has read the founder's
     * uploads, and it is about to reach a seat with web tools: it must look
     * like a question, not a carrier (research/gate.ts). Refused ones are
     * said in the room, scrubbed, so the payload itself is not repeated.
     */
    const gated = gateQuestion(question);
    if (!gated.ok) {
      const who = this.row.personas.find((p) => p.id === from.askedBy)?.name ?? (from.askedBy === 'architect' ? 'The panel architect' : 'The chair');
      this.system(`Research desk: ${who}'s question was not sent, because ${gated.reason}. Research questions go out as plain questions only. "${scrubForWeb(question, 160)}" stays an open question.`);
      return null;
    }
    const q = gated.question;
    const motionId = from.purpose === 'pre_session' ? null : from.motionId ?? null;
    if (this.researchLeft(motionId) <= 0) {
      // Runaway guards set well above what a session of this depth uses, not
      // spend limits. An unprofiled debate has no session cap, as before.
      const p = this.profile;
      if (p && (meta.researchCount ?? 0) >= BUDGET_PROFILES[p].researchCap) {
        this.system(`Research desk: ${BUDGET_PROFILES[p].researchCap} research requests already this session, which is past what a ${p} room should need; treating that as a loop. "${q.slice(0, 160)}" stays an open question.`);
        return null;
      }
      const who = this.row.personas.find((p) => p.id === from.askedBy)?.name ?? 'The chair';
      this.system(`Research desk: the allowance ${motionId ? 'for this motion ' : ''}is spent, so ${who}'s question stays open: "${q.slice(0, 160)}". Treat any figure offered for it as assumed.`);
      return null;
    }
    const req: ResearchRequest = {
      id: rid('r'),
      debateId: this.id,
      question: q,
      askedBy: from.askedBy,
      ...(motionId ? { motionId } : {}),
      purpose: from.purpose,
      maxSources: 6,
      budget: { maxSearches: RESEARCH_LIMITS.searches, timeoutMs: this.provider === 'codex' ? CODEX_RESEARCH_MS : CFG.researchTimeoutMs },
    };
    meta.researchCount = (meta.researchCount ?? 0) + 1;
    if (motionId) (meta.researchByMotion ??= {})[motionId] = (meta.researchByMotion[motionId] ?? 0) + 1;
    (meta.researchInflight ??= []).push(req);
    this.saveMeta();
    this.publish({ type: 'research_started', taskId: req.id, question: q });
    return this.launchResearch(req);
  }

  /** Run a request (new, or re-issued after a restart) and land its answer. */
  private launchResearch(req: ResearchRequest): Promise<void> {
    const existing = this.researchRuns.get(req.id);
    if (existing) return existing;
    const run = (async () => {
      // The goal rides along as context; it was written after intake read the uploads, so it goes out scrubbed.
      // What the debate already found goes along, so a question it answers is not searched again.
      const result = await runResearch(this.provider, req, { goal: scrubForWeb(this.row.goal ?? this.row.topic), signal: this.researchAbort.signal, known: this.knownResearch() });
      if (this.killed) return;
      await this.landResearch(req, result);
    })()
      .catch((err) => console.error(`[debate ${this.id}] research ${req.id} could not land:`, err))
      .finally(() => {
        this.researchRuns.delete(req.id);
        // A killed run leaves its request persisted: that is what a restart re-issues.
        if (this.killed) return;
        this.row.meta.researchInflight = (this.row.meta.researchInflight ?? []).filter((r) => r.id !== req.id);
        this.saveMeta();
      });
    this.researchRuns.set(req.id, run);
    return run;
  }

  /** After a restart: every request that was in flight is sent again, once. */
  private resumeResearch() {
    if (this.researchResumed || TERMINAL.includes(this.row.status)) return;
    this.researchResumed = true;
    const pending = (this.row.meta.researchInflight ?? []).filter((r) => !this.researchRuns.has(r.id));
    if (!pending.length) return;
    this.system(`Research desk: picking up ${pending.length === 1 ? 'the request' : `${pending.length} requests`} that ${pending.length === 1 ? 'was' : 'were'} in flight when the session stopped.`);
    for (const r of pending) void this.launchResearch(r);
  }

  /**
   * The answer reaches the room as the desk's one spoken line with its
   * citation markers; the summary and the sources go to the side panel and
   * the report. Whatever came back from the web is fenced wherever it enters
   * a prompt (transcript.ts); here it is stored and published as data.
   */
  private async landResearch(req: ResearchRequest, result: ResearchResult) {
    const meta = this.row.meta;
    meta.researchBriefs.push({
      question: req.question,
      summary: result.summary,
      citations: result.citations,
      status: result.status,
      askedBy: req.askedBy,
      motionId: req.motionId ?? null,
      requestId: req.id,
    });
    this.saveMeta();
    const usable = result.findings.length > 0;
    // An answer that arrives after the room has closed goes to the side panel only; nobody is left to hear it.
    const roomOpen = !TERMINAL.includes(this.row.status) && this.row.status !== 'reporting';
    if (usable && roomOpen) {
      this.publish({ type: 'message', id: rid('m'), speaker: 'research', kind: 'research', text: result.spoken || result.summary });
    } else if (!usable && roomOpen) {
      this.system(`Research desk on "${req.question.slice(0, 160)}": ${result.summary} Treat any figure offered for it as assumed.`);
    }
    this.publish({ type: 'research_done', taskId: req.id, summary: result.summary.slice(0, 280), result });
    // Evidence landed: a move citing one of these ids has a cause the ledger can check.
    if (usable && req.motionId && meta.ledger) {
      const seq = Events.lastSeq(this.id);
      for (const c of result.citations) this.ledger({ type: 'evidence', motionId: req.motionId, seq, kind: 'evidence', ref: c.id });
    }
    appendTranscriptFile(
      this.id,
      `**RESEARCH DESK (${req.question}):** ${usable ? result.spoken || result.summary : result.summary}` +
        (result.citations.length ? `\n\n${result.citations.map((c) => `- [${c.id}] ${c.title} (${c.url})${c.provenance === 'model_reported' ? ' — reported by the model, not attested by the tool' : ''}`).join('\n')}` : '')
    );
    if (!usable || !req.motionId) return;
    const hits = await this.matchCruxes(req.motionId, result);
    if (this.killed) return;
    // Re-read: the driver may have refreshed the row from the database while the clerk ran.
    (this.row.meta.researchLanded ??= []).push({ motionId: req.motionId, askedBy: req.askedBy, question: req.question, spoken: result.spoken || result.summary, hits });
    // Whose crux it hit stays on record for the motion: the floor director treats them as relevant.
    if (hits.length) {
      const mine = ((this.row.meta.cruxHits ??= {})[req.motionId] ??= []);
      for (const h of hits) if (!mine.includes(h.expert)) mine.push(h.expert);
    }
    this.saveMeta();
    if (hits.length) {
      const name = (id: string) => this.row.personas.find((p) => p.id === id)?.name ?? id;
      this.system(`The research desk's finding ${hits.map((h) => `${h.effect} ${name(h.expert)}'s crux`).join(' and ')}.`);
    }
  }

  /**
   * Which experts' cruxes a finding bears on, from their own STANCE lines.
   * One fast-tier classification; a failure costs only the pointer.
   */
  private async matchCruxes(motionId: string, result: ResearchResult): Promise<{ expert: string; effect: 'supports' | 'undermines' }[]> {
    const stances = this.row.meta.stances?.[motionId] ?? {};
    const cruxes = this.experts
      .filter((p) => stances[p.id]?.crux)
      .map((p) => ({ id: p.id, name: p.name, crux: stances[p.id].crux }));
    if (!cruxes.length) return [];
    // Research-labelled spend, so it gets its own line in the research token log (28 Oct: one of these carried ~103,000 tokens unseen).
    const meter = new ResearchMeter({ id: `${result.requestId}/crux`, debateId: this.id, purpose: 'crux match' }, this.provider);
    const model = this.modelFor('clerk');
    try {
      const { value, usage, costUsd } = await runJsonAgent<any>({
        model,
        system: cruxMatchSystem(),
        prompt: cruxMatchPrompt(result.findings.map((f) => fenceUntrusted('RESEARCH FINDING', f.claim)), cruxes),
        thinking: 0,
        timeoutMs: 120_000,
        debateId: this.id,
        label: 'research:crux',
        onRequestUsage: (u) => meter.request(u),
      });
      meter.step('crux', model, usage, costUsd ?? 0);
      meter.finish();
      const seen = new Set<string>();
      return (Array.isArray(value?.hits) ? value.hits : [])
        .map((h: any) => ({ expert: String(h?.expert ?? ''), effect: h?.effect === 'supports' ? 'supports' as const : h?.effect === 'undermines' ? 'undermines' as const : null }))
        .filter((h: any) => h.effect && cruxes.some((c) => c.id === h.expert) && !seen.has(h.expert) && seen.add(h.expert))
        .slice(0, 6);
    } catch (err) {
      meter.step('crux', model, undefined);
      if (meter.steps.length) meter.finish();
      console.error(`[debate ${this.id}] crux matching failed:`, err);
      return [];
    }
  }

  /** Research that landed on a motion since the chair last steered it, as lines for his prompt. Read once. */
  private takeLandedResearch(motionId: string): string[] {
    const meta = this.row.meta;
    const mine = (meta.researchLanded ?? []).filter((l) => l.motionId === motionId);
    if (!mine.length) return [];
    meta.researchLanded = (meta.researchLanded ?? []).filter((l) => l.motionId !== motionId);
    this.saveMeta();
    const name = (id: string) => (id === 'marcus' ? 'You' : this.row.personas.find((p) => p.id === id)?.name ?? id);
    return mine.map((l) =>
      `${name(l.askedBy)} asked "${l.question.slice(0, 200)}". The desk said: ${fenceUntrusted('RESEARCH DESK', l.spoken)}` +
        (l.hits.length ? ` It ${l.hits.map((h) => `${h.effect} ${name(h.expert)}'s crux`).join(' and ')}.` : '')
    );
  }

  /**
   * A motion does not go to ruling while research on it is still out: wait a
   * bounded time, then rule and say what is still pending.
   */
  private async pendingResearch(motionId: string): Promise<string[]> {
    const mine = () => (this.row.meta.researchInflight ?? []).filter((r) => r.motionId === motionId);
    const runs = mine().map((r) => this.researchRuns.get(r.id)).filter(Boolean) as Promise<void>[];
    if (runs.length) {
      const stage = Hub.stage(this.id, 'research', 'Waiting for the research desk', 'The motion goes to ruling once the research on it lands, or in a few minutes if it does not.');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.allSettled(runs), new Promise((r) => { timer = setTimeout(r, RULING_WAITS_FOR_RESEARCH_MS); })]);
      } finally {
        clearTimeout(timer);
        stage.close();
      }
    }
    return mine().map((r) => r.question);
  }

  /**
   * Send a contested number to the quant desk.
   *
   * Unlike research this is awaited, not fired into the background. A figure
   * the room is arguing about is worthless once the round has moved on: the
   * whole point is that the next speaker sees a computed number instead of
   * another opinion about it. It costs the room a pause, and the stage frame
   * tells everyone watching exactly what the pause is for.
   */
  private async computeTask(question: string, motionId: string | null): Promise<void> {
    if ((this.row.meta.contextFiles ?? 0) === 0) return;   // nothing to compute from
    if (!this.hasQuantDesk()) {
      this.system('The quant desk is unavailable on this session, so this figure stays an estimate rather than a measurement.');
      return;
    }
    const taskId = rid('q');
    this.computeInflight++;
    this.publish({ type: 'compute_started', taskId, question });
    const stage = Hub.stage(this.id, 'quant', 'The quant desk is computing',
      question.slice(0, 200));
    try {
      const res = await runQuant(
        this.modelFor('quant'),
        this.id,
        question,
        this.row.goal ?? this.row.topic,
        (t) => stage.think(t)
      );
      const rec = {
        question,
        answer: res.answer,
        computable: res.computable,
        figures: res.figures,
        method: res.method,
        caveats: res.caveats,
        motionId,
      };
      (this.row.meta.computations ??= []).push(rec);
      this.saveMeta();
      this.publish({
        type: 'compute_done',
        taskId,
        question,
        answer: res.answer,
        computable: res.computable,
        figures: res.figures,
        method: res.method,
        reconciles: res.reconciles,
        caveats: res.caveats,
      });
      /**
       * Also lands in the transcript as a message. Every persona reads the
       * transcript, so this is the only way a computed figure reaches the
       * room, and it must arrive attributed so nobody can later claim it as
       * their own estimate.
       */
      const body = res.computable
        ? `${res.answer}\n\n${res.figures.map((f) => `- ${f.label}: ${f.value}  (${f.source})`).join('\n')}${res.caveats.length ? `\n\nCaveats: ${res.caveats.join(' ')}` : ''}`
        : `NOT COMPUTABLE. ${res.answer}`;
      this.publish({ type: 'message', id: rid('m'), speaker: 'quant', kind: 'quant', text: body });
      appendTranscriptFile(this.id, `**QUANT DESK (${question}):** ${body}`);
      if (res.computable && motionId && this.row.meta.ledger) {
        this.ledger({ type: 'evidence', motionId, seq: Events.lastSeq(this.id), kind: 'computation', ref: taskId });
      }
    } catch (err) {
      console.error('[quant] failed:', err);
      this.publish({
        type: 'compute_done', taskId, question,
        answer: 'The quant desk could not complete this computation.',
        computable: false, figures: [], method: '', reconciles: null, caveats: [],
      });
    } finally {
      stage.close();
      this.computeInflight--;
    }
  }

  /**
   * Whether a measured number can actually be produced this session: the quant
   * desk needs uploaded files and the Claude toolchain. OpenAI and Codex
   * sessions have no python and no file tools, and the floor prompts already
   * speak conditionally on this gate, so the room stops promising measured
   * numbers there.
   */
  private hasQuantDesk(): boolean {
    if (debateProvider(this.id) === 'openai') return false;
    return (this.row.meta.contextFiles ?? 0) > 0;
  }

  /**
   * The adversary desk: three independent seats, each handed the finished
   * ruling cold with the single instruction to prove it wrong. Three, because
   * the experiment that justified this seat found near-zero variance on the
   * top defeater and high variance on the rest: the extra seats buy breadth,
   * not confirmation, so their findings are merged, never voted.
   *
   * They ride the same cached room prefix as every other caller (the record
   * IS the case file), and they get the interpreter and the founder's files
   * whenever this room has them: an adversary that can only bracket a figure
   * is worth less than one that can recompute it.
   */
  private async redTeamAttack(decision: Decision, motionTitle: string, motion: string): Promise<Defeater[]> {
    const seats = this.adversarySeats();
    if (!seats) return [];                              // off on this budget profile
    const stage = Hub.stage(this.id, 'quant', 'The adversary desk is attacking the ruling',
      `${seats === 1 ? 'An independent adversary is' : `${seats} independent adversaries are`} re-deriving "${motionTitle}" under one instruction: this conclusion is wrong, find why.`);
    try {
      const room = this.roomBlocks(Events.lastSeq(this.id), this.activeMotionId);
      const rulingText = [
        `DECISION: ${decision.decision}`,
        `OWNER: ${decision.owner}`,
        `RATIONALE: ${decision.rationale}`,
        `EVIDENCE GRADE: ${decision.evidence}`,
        decision.dissents.length
          ? `DISSENTS ALREADY ON RECORD:\n${decision.dissents.map((d) => `- ${d.expert}: ${d.position}`).join('\n')}`
          : '',
      ].filter(Boolean).join('\n');
      const hasTools = this.hasQuantDesk();
      const comps = (this.row.meta.computations ?? []).filter((c) => c.computable).map((c) => ({ question: c.question, answer: c.answer }));
      const suffix = [
        redTeamSystem(hasTools, hasTools ? contextDir(this.id) : null),
        redTeamRulingPrompt(motionTitle, motion, rulingText, comps),
        // The grades the room recorded for its own claims: an "assumed" the ruling leaned on is a target.
        claimsRecord(this.motionEvents(this.activeMotionId), this.row.personas, this.humanName()),
      ].filter(Boolean).join('\n\n');
      return await this.runAdversaries(seats, room.system, suffix, hasTools, (i) => `redteam:${i}`, (t) => stage.think(t));
    } catch (err) {
      // An adversary crash must never take the session with it.
      console.error(`[debate ${this.id}] red team failed:`, err);
      return [];
    } finally {
      stage.close();
    }
  }

  /** Fan out the adversaries (three, or the profile's count) and merge what lands. */
  private async runAdversaries(
    seats: number,
    system: string,
    prompt: string,
    hasTools: boolean,
    label: (i: number) => string,
    onThinking?: (t: string) => void
  ): Promise<Defeater[]> {
    const tooling = hasTools
      ? { tools: computeTools(contextDir(this.id), workDir(this.id)), cwd: workDir(this.id), maxTurns: 40 }
      : {};
    const results = await Promise.allSettled(
      Array.from({ length: Math.max(1, seats) }, (_, k) => k + 1).map((i) =>
        runJsonAgent<any>({
          model: this.modelFor('floor'),
          system,
          prompt,
          thinking: this.thinking('heavy'),
          timeoutMs: CFG.quantTimeoutMs,
          debateId: this.id,
          label: label(i),
          // One thinking feed on the war-room card; three interleaved would be noise.
          ...(i === 1 && onThinking ? { onThinking } : {}),
          ...tooling,
        })
      )
    );
    const seen = new Set<string>();
    const merged: Defeater[] = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const v = r.value.value;
      for (const raw of Array.isArray(v?.defeaters) ? v.defeaters : []) {
        const claim = String(raw?.claim ?? '').trim();
        const severity = ['fatal', 'material', 'minor'].includes(raw?.severity) ? raw.severity : 'material';
        if (!claim || severity === 'minor') continue;
        const key = claim.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push({
          claim: claim.slice(0, 800),
          arithmetic: String(raw?.arithmetic ?? '').slice(0, 1200),
          consequence: String(raw?.consequence ?? '').slice(0, 600),
          severity,
        });
      }
    }
    return merged.slice(0, 6);
  }

  /**
   * The same desk, run against the REPORT after the writer produced it and
   * before it renders. The one error that shipped to a board in this app's
   * life was introduced at exactly this step, by the writer transposing two
   * bridge labels between the desk's answer and the report JSON, and the
   * numbers audit runs BEFORE the writer, so it structurally cannot catch
   * what the writer does. This seat is the only thing standing after him.
   */
  private async redTeamReport(data: ReportData): Promise<Defeater[]> {
    const seats = this.reportAdversarySeats();
    if (!seats) return [];
    const stage = Hub.stage(this.id, 'quant', 'The adversary desk is attacking the report',
      `${seats === 1 ? 'An independent adversary is' : 'Independent adversaries are'} checking the written report against the source files, figure by figure, before it is rendered.`);
    try {
      const claims = [
        `HEADLINE RECOMMENDATION: ${data.keyRecommendation}`,
        `EXECUTIVE SUMMARY:\n${(data.executiveSummary ?? []).join('\n')}`,
        ...(data.decisions ?? []).map((d: any) => `DECISION "${d.title ?? d.topic ?? ''}": ${d.conclusion ?? d.decision ?? ''}\nRESOLUTION: ${d.resolution ?? d.rationale ?? ''}`),
        ...(data.tables ?? []).map((t: any) => `TABLE "${t.title}":\n${JSON.stringify(t.rows ?? t).slice(0, 2000)}`),
        ...(data.charts ?? []).map((c: any) => `CHART "${c.title}":\n${JSON.stringify(c).slice(0, 1500)}`),
        data.numbersAudit ? `NUMBERS AUDIT SUMMARY: ${data.numbersAudit.summary}` : '',
      ].filter(Boolean).join('\n\n').slice(0, 24_000);
      const hasTools = this.hasQuantDesk();
      const room = this.roomBlocks(Events.lastSeq(this.id), null);
      const suffix = [
        redTeamSystem(hasTools, hasTools ? contextDir(this.id) : null),
        redTeamReportPrompt(claims),
      ].join('\n\n');
      return await this.runAdversaries(seats, room.system, suffix, hasTools, (i) => `redteam:report:${i}`, (t) => stage.think(t));
    } catch (err) {
      throwIfLimited(this.id);
      console.error(`[debate ${this.id}] report red team failed:`, err);
      return [];
    } finally {
      stage.close();
    }
  }

  /**
   * Hand the adversaries' findings back to the writer that made the mistakes.
   * Resumed, not fresh: the writer already holds the whole report in session,
   * so the correction costs a delta, and a fresh seat would re-transcribe
   * everything and roll new dice on every figure it touched.
   */
  private async reviseReport(data: ReportData, findings: Defeater[], writerSession?: string): Promise<ReportData | null> {
    try {
      const list = findings
        .map((d, i) => `${i + 1}. CLAIM: ${d.claim}\n   THE ARITHMETIC AGAINST IT: ${d.arithmetic}\n   CONSEQUENCE IF TRUE: ${d.consequence}`)
        .join('\n');
      const checkedAgainst = this.hasQuantDesk()
        ? 'checked your report against the source files'
        : "checked your report against the session's own record, hunting figures that cannot all be true at once";
      const { value } = await runJsonAgent<ReportData>({
        model: this.modelFor('report'),
        system: reportSystem(),
        prompt: `An independent adversary desk ${checkedAgainst} and returns these findings:\n\n${list}\n\nFor each one: if it is right, correct the figure and EVERYTHING derived from it, in every section it appears (summary, decisions, tables, charts). If you can show it is wrong, leave your figure exactly as it was. Do not soften language, do not add hedges, do not add new sections. Return the FULL corrected report as strict JSON in exactly the same schema as before, complete, with nothing omitted.`,
        resume: writerSession,
        thinking: 12_000,
        timeoutMs: 30 * 60_000,
        maxTurns: 10,
        debateId: this.id,
        label: 'report:revise',
      });
      // A revision that lost the report is worse than the error it fixed.
      if (!value || !value.keyRecommendation || !Array.isArray(value.executiveSummary) || !value.executiveSummary.length) return null;
      return value;
    } catch (err) {
      throwIfLimited(this.id);
      console.error(`[debate ${this.id}] report revision failed; shipping the writer's original with findings printed:`, err);
      return null;
    }
  }

  /** The name of the human in this room, as the panel addresses them. */
  private humanName(): string {
    return CFG.founderName || 'the founder';
  }

  private publishMarcus(text: string) {
    this.publish({ type: 'message', id: rid('m'), speaker: 'marcus', kind: 'marcus', text });
    appendTranscriptFile(this.id, `**Marcus:** ${text}`);
  }

  private live(frame: any) {
    if (!this.killed) Hub.live(this.id, frame);
  }

  /** The founder has paused: a step stops at its next boundary and waits for Resume (P4). */
  private isPaused(): boolean {
    return this.row.status === 'paused' && !!this.row.meta.founderPause;
  }

  // ---------- wrapup + report ----------

  private async wrapupStep() {
    const meta = this.row.meta;
    this.wrapStartSeq = this.wrapStartSeq ?? Events.lastSeq(this.id);
    if (!meta.closedExperts.length) {
      // Neutral on purpose: whichever path ended the meeting already said why,
      // and "we are at time" after "the agenda is fully answered" read as two
      // incompatible chairs.
      this.publishMarcus('Closing statements. Where you land on the calls that matter, and what evidence would move you. Keep it tight.');
    }
    for (const e of this.experts) {
      if (meta.closedExperts.includes(e.id)) continue;
      // Paused between closings: those given stand, the rest follow on Resume (P4).
      if (this.isPaused()) return;
      await this.closingTurn(e.id);
      meta.closedExperts.push(e.id);
      this.saveMeta();
    }
    if (this.isPaused()) return;
    const dissents = meta.decisions.reduce((n, d) => n + (d.dissents?.length ?? 0), 0);
    this.publishMarcus(marcusClosingSay(dissents, this.humanName()));
    this.setStatus('reporting');
  }

  /**
   * The audit gate. Runs between the room closing and the report being written,
   * and only when there are source files to check against.
   *
   * A panel that argues well and prints a wrong number is worse than useless:
   * the founder defends the number, not the argument. This recomputes every
   * figure in every ruling before the writer can bake them in, and anything
   * that fails is carried into the report as a printed correction rather than
   * quietly fixed, because the founder needs to know his panel got it wrong.
   *
   * It is handed the event log as well as the rulings, because the failure that
   * forced this to audit derivations never entered a ruling: the chair repeated
   * a payback of "inside month two" against a true 3.1 months across two steers
   * until an expert used it as fact. Everything spoken in the room can reach the
   * founder, since the report is written from the transcript too.
   */
  private async auditNumbers(events: DebateEvent[]): Promise<AuditOutcome> {
    const meta = this.row.meta;
    if ((meta.contextFiles ?? 0) === 0) return { kind: 'skipped' };
    if (!meta.decisions.length) return { kind: 'skipped' };
    if (debateProvider(this.id) === 'openai') return { kind: 'skipped' };  // no python on this provider; hasQuantDesk is false for the same reason

    const decisions = meta.decisions
      .map((d) => `MOTION: ${d.motionTitle}\nRULING (${d.evidence}): ${d.decision}\nRATIONALE: ${d.rationale}`)
      .join('\n\n')
      .slice(0, 30_000);
    // The rulings are what the panel committed to; the spoken figures are what
    // it worked from. The 7 Aug miss lived entirely in the second one.
    const claims = numericClaims(events, this.row.personas, this.humanName());

    this.system('Before the report is written, every figure the panel committed to is being recomputed against your files, and every claim derived from one is being re-derived.');
    const stage = Hub.stage(this.id, 'quant', 'Auditing the panel\'s numbers',
      `Recomputing the figures behind ${meta.decisions.length} ruling${meta.decisions.length === 1 ? '' : 's'} from the source data, and re-deriving what the room built on them.`);
    /**
     * One retry, then an HONEST failure. The audit used to end
     * `catch { return null }`, and null also meant "nothing to audit" — so the
     * report rendered without its audit section and nothing anywhere said the
     * checker had crashed. That is precisely how the ozone report shipped a
     * transposed bridge to a board: auditNumbers() threw, the section vanished,
     * and a checked document and an unchecked one became indistinguishable.
     */
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          const res = await runAudit(this.modelFor('quant'), this.id, decisions, claims, (t) => stage.think(t));
          this.publish({ type: 'audit', checked: res.checked, summary: res.summary, findings: res.findings });
          appendTranscriptFile(this.id, `**NUMBERS AUDIT:** ${res.summary}`);
          /**
           * Returned whole, even with no findings. The war-room card is published
           * above regardless, so dropping it here showed the founder an audit on
           * screen and none in the document he actually hands over. A clean audit
           * is a result: it is the difference between figures that were checked and
           * figures that merely went unchallenged.
           */
          return { kind: 'ok', audit: res };
        } catch (err) {
          if (asUsageLimit(err)) throw err;          // a spent allowance parks the session; it is not an audit verdict
          console.error(`[audit] attempt ${attempt} failed:`, err);
          if (attempt >= 2) {
            this.system('The numbers audit failed twice. The report will be delivered, and it will say on its face that its figures were not independently verified.');
            return { kind: 'failed', reason: err instanceof Error ? err.message : String(err) };
          }
        }
      }
    } finally {
      stage.close();
    }
  }

  private async reportStep() {
    // Read before the audit rather than after it, because the audit now takes
    // the log as input. Nothing the audit publishes is a spoken event, so the
    // report writer's material is identical either way.
    const events = Events.since(this.id, 0);
    /**
     * Each finished part is kept (P4): a pause stops between the audit, the
     * writer, the adversary and the correction, and Resume picks up at the
     * next one rather than paying for any of them twice.
     */
    const prog = (this.row.meta.reportProgress ??= {});
    if (!prog.audit) {
      prog.audit = await this.auditNumbers(events);
      this.saveMeta();
      if (this.isPaused()) return;
    }
    const auditOutcome = prog.audit as AuditOutcome;
    const audit = auditOutcome.kind === 'ok' ? auditOutcome.audit : null;
    // The realism sections are the server's, like the sources: what was at stake, how minds changed, the dissent record.
    const nameOf = (id: string) => this.row.personas.find((p) => p.id === id)?.name ?? id;
    const stakesReport = stakesLines(this.row.meta.stakes);
    const minority = this.row.meta.stakes || this.row.meta.ledger ? dissentRecord(this.row.meta.decisions) : undefined;
    const minds = mindChangeSections(this.row.meta.ledger, this.row.meta.decisions.map((d) => ({ id: d.motionId, title: d.motionTitle })), this.experts.map((p) => p.id), nameOf);

    if (!prog.written) {
      this.system('The analysts are writing the full report. This is the longest single step.');
      const realism = realismMaterial(this.row.meta.stakes, minds, minority);
      const material = reportMaterial(this.row, events, this.humanName()) + (realism ? `\n\n====\n\n${realism}\n` : '') + (audit ? `\n\n====\n\n${auditBrief(audit)}\n` : '');
      const { value, sessionId } = await this.writeReport(material);
      prog.written = value;
      prog.writerSession = sessionId ?? null;
      this.saveMeta();
      if (this.isPaused()) return;
    }

    /**
     * The adversary desk gets the WRITER'S OUTPUT, not the room's argument.
     * The audit above runs before the writer, so a figure the writer breaks
     * in transcription is structurally invisible to it; the one error this
     * app ever shipped to a board was exactly that, a transposed bridge label
     * introduced between the desk's answer and the report JSON. Anything the
     * adversaries land goes back to the writer to correct, and every finding
     * is printed in the audit section either way: the founder should know
     * both what was caught and that somebody was hunting.
     */
    if (!prog.attacked) {
      prog.findings = await this.redTeamReport(prog.written as ReportData);
      prog.attacked = true;
      this.saveMeta();
      if (this.isPaused()) return;
    }
    const rtFindings = (prog.findings ?? []) as Defeater[];
    if (rtFindings.length && !prog.revised) {
      this.system(`The adversary desk found ${rtFindings.length} problem${rtFindings.length === 1 ? '' : 's'} in the written report. The writer is correcting it.`);
      const revised = await this.reviseReport(prog.written as ReportData, rtFindings, prog.writerSession ?? undefined);
      if (revised) prog.written = revised;
      prog.revised = true;
      this.saveMeta();
      if (this.isPaused()) return;
    }
    const written: ReportData = prog.written as ReportData;
    await this.publishReport(written, events, auditOutcome, rtFindings, { stakesReport, minority, minds });
    this.row.meta.reportProgress = null;
    this.saveMeta();
    this.setStatus('complete');
  }

  /** The report writer's one call. */
  private writeReport(material: string) {
    return runJsonAgent<ReportData>({
      model: this.modelFor('report'),
      system: reportSystem(),
      prompt: reportPrompt(material),
      /**
       * NOT heavyThinking. Thinking shares the response window with the text,
       * and this response IS the deliverable — ~30K tokens of report JSON.
       * At 60K requested thinking the model spent the whole window reasoning
       * and truncated the report; the analysis already happened in the debate,
       * so the writer needs composition room, not another hour of thought.
       */
      thinking: 12_000,
      timeoutMs: 30 * 60_000,
      /**
       * The turn budget is the report's whole failure mode. Without this it
       * inherited the default 3 — sized for one-shot expert speeches — and a
       * single stray tool attempt plus the sheer size of the report JSON blew
       * past it: the CLI exits 1 with NOTHING on stderr, which cost a finished
       * $21 session its deliverable. The report is the most expensive turn in
       * the app to lose, so it gets room to stumble.
       */
      maxTurns: 10,
      debateId: this.id,
      label: 'report',
    });
  }

  /** Server-written fields, render, print check and PDFs: no argument left, only the document. */
  private async publishReport(
    written: ReportData,
    events: DebateEvent[],
    auditOutcome: AuditOutcome,
    rtFindings: Defeater[],
    { stakesReport, minority, minds }: { stakesReport: ReturnType<typeof stakesLines>; minority: ReturnType<typeof dissentRecord> | undefined; minds: ReturnType<typeof mindChangeSections> }
  ) {
    const audit = auditOutcome.kind === 'ok' ? auditOutcome.audit : null;
    // Deterministic fields are ours, not the model's.
    const sources: Citation[] = sessionSources(this.row);
    let data: ReportData = {
      ...written,
      generatedAtIso: new Date().toISOString(),
      preparedFor: this.humanName(),
      topic: this.row.topic,
      goal: this.row.goal ?? '',
      model: `${PROVIDER_LABEL[this.provider]} · chair ${modelName(this.modelFor('chair'))}`,
      mode: 'live floor',   // the floor director ran this room (2b-7); the stored setup mode no longer changes anything
      autonomy: this.row.config.autonomy,
      panel: this.row.personas.map((p) => ({ id: p.id, name: p.name, role: p.role, color: p.color })),
      stats: computeStats(events),
      /**
       * ALWAYS server-written, including the absent case. This spread used to
       * add nothing when the audit was legitimately skipped, which left the
       * report WRITER's own `numbersAudit` standing if it invented one: a
       * fabricated "figures checked" section on a document nothing checked.
       * The writer's copy is overwritten unconditionally.
       */
      numbersAudit: audit ?? undefined,
      // Server-written like the audit: the tools' sources, never the writer's recollection of them.
      sources: sources.length ? sources : undefined,
      stakes: stakesReport,
      minority,
      mindChanges: minds,
      ...(auditOutcome.kind === 'failed'
          ? {
              numbersAudit: {
                checked: 0,
                summary: 'The audit itself failed after a retry. Every figure in this report came from the panel unverified: treat each one as the panel\'s claim, not as a checked fact, and recompute anything you intend to act on.',
                findings: [],
                failed: true,
              },
            }
          : {}),
    };

    /**
     * Adversary findings are printed even when the writer fixed them: a
     * caught error is a fact about how this document was made, and a reader
     * weighing the numbers deserves to know both that somebody attacked them
     * and what fell.
     */
    if (rtFindings.length) {
      const asFindings = rtFindings.map((d) => ({
        figure: `Adversary desk: ${d.claim}`,
        verdict: 'wrong' as const,
        recomputed: d.arithmetic,
        impact: d.consequence,
      }));
      data.numbersAudit = data.numbersAudit
        ? { ...data.numbersAudit, checked: data.numbersAudit.checked + asFindings.length, findings: [...data.numbersAudit.findings, ...asFindings] }
        : {
            checked: asFindings.length,
            summary: 'No pre-report audit ran in this session. The findings below are from the adversary desk\'s attack on the written report itself.',
            findings: asFindings,
          };
    }

    /**
     * Evidence honesty (P1). Whatever the writer or the audit built on a
     * panelist's backstory is printed as an assumption, and the backstory
     * itself is listed as illustration. A figure research or the founder also
     * gave is not persona-only, so both go into the index.
     */
    const nameOf = (id: string) => this.row.personas.find((p) => p.id === id)?.name ?? id;
    const prov = this.provenance(events);
    data = labelPersonaDerived(
      data,
      personaClaims(events, nameOf),
      indexProvenance({ ...prov, founder: [...prov.founder, ...this.row.meta.researchBriefs.map((b) => b.summary)] })
    );

    let html: string;
    try {
      const mod = await import('../report/render.ts');
      html = mod.renderReport(data);
    } catch (err) {
      console.error('[report] renderer missing/failed, using fallback:', err);
      /**
       * Escaped, because every character here is model-written and this HTML is
       * SERVED. The title used to be interpolated raw, so a report title
       * containing `</title><script>` broke out of the tag and ran in the
       * founder's session on the app's own origin, from a document he opens
       * precisely because he trusts it.
       */
      const esc = (s: unknown) =>
        String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      html = `<!doctype html><meta charset="utf-8"><title>${esc(data.title)}</title><pre>${esc(JSON.stringify(data, null, 2))}</pre>`;
    }

    const dir = debateDir(this.id);
    fs.writeFileSync(path.join(dir, 'report.html'), html);
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(data, null, 2));
    this.publish({ type: 'report_ready', path: `/api/debates/${this.id}/report` });

    // PDF is a bonus: never let a missing Chrome (or renderer) fail a session.
    try {
      const mod: any = await import(/* @vite-ignore */ '../report/pdf.ts' as string);
      /**
       * Measure before shipping. The corpus in stress.ts proves the template
       * against hostile content; this proves THIS document, whose data no
       * corpus anticipated. It never blocks the deliverable: a report with one
       * flawed chart beats no report. It is recorded so the fault is fixed in
       * the template rather than discovered by whoever opens the PDF.
       */
      /**
       * Measure, then REPAIR. Reporting a fault and shipping anyway was the
       * wrong contract: the founder's answer to "the layout has faults" is
       * "then fix it", and he is right — a flaw a machine can see is a flaw a
       * machine can mend. Almost every real fault is a value the writer chose
       * that the layout cannot hold (a 20-character axis unit, a label longer
       * than its column), so the repair edits the DATA, re-renders, and
       * re-measures. Cheap model, tight turn budget, bounded attempts, and it
       * never blocks: if repair fails the report still ships and the fault is
       * recorded, exactly as before.
       */
      try {
        const qa = await import('../report/qa.ts');
        let verdict = await qa.runPrintQa(html, { contentWidthMm: 182, timeoutMs: 90_000 });

        for (let attempt = 1; attempt <= 2 && !verdict.ok; attempt++) {
          const faults = verdict.issues
            .map((i) => `${i.check} (${i.count}): ${i.samples.slice(0, 6).join(' | ')}`)
            .join('\n');
          console.log(`[report] print QA repair attempt ${attempt} for ${this.id}`);
          const repaired = await repairReportData(this.modelFor('repair'), data, faults, this.id);
          if (!repaired) break;
          /**
           * The server-owned fields are re-imposed BEFORE the candidate is
           * rendered and measured, not trusted to the echo: a repair model
           * asked to fix layout can drop an optional field it never
           * understood, and numbersAudit silently vanishing from a shipped
           * report is the exact failure the audit rework closed.
           */
          const candidate: ReportData = {
            ...repaired,
            generatedAtIso: data.generatedAtIso,
            preparedFor: data.preparedFor,
            topic: data.topic,
            goal: data.goal,
            model: data.model,
            mode: data.mode,
            autonomy: data.autonomy,
            panel: data.panel,
            stats: data.stats,
            ...(data.numbersAudit ? { numbersAudit: data.numbersAudit } : {}),
            sources: data.sources,
            stakes: data.stakes,
            minority: data.minority,
            mindChanges: data.mindChanges,
            ...(data.personaClaims ? { personaClaims: data.personaClaims } : {}),
          };
          let nextHtml: string;
          try {
            nextHtml = mod.renderReport(candidate);
          } catch {
            break;                                     // a repair that will not render is not a repair
          }
          const nextVerdict = await qa.runPrintQa(nextHtml, { contentWidthMm: 182, timeoutMs: 90_000 });
          // Only adopt a repair that actually measured BETTER. A model asked to
          // fix a layout can always produce different text; different is not
          // the bar, fewer faults is.
          const before = verdict.issues.reduce((n, i) => n + i.count, 0);
          const after = nextVerdict.issues.reduce((n, i) => n + i.count, 0);
          if (!nextVerdict.measuredNodes || after >= before) break;
          data = candidate;
          html = nextHtml;
          verdict = nextVerdict;
          fs.writeFileSync(path.join(dir, 'report.html'), html);
          fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(data, null, 2));
          if (verdict.ok) console.log(`[report] print QA repaired ${this.id} on attempt ${attempt}`);
        }

        if (!verdict.ok) {
          const summary = verdict.issues.map((i) => `${i.check} x${i.count}`).join(', ');
          console.error(`[report] print QA faults survive repair in ${this.id}: ${summary}`);
          for (const i of verdict.issues) console.error(`  [${i.check}] ${i.samples.join(' | ')}`);
          this.row.meta.printQa = { ok: false, summary, at: Date.now() };
        } else {
          this.row.meta.printQa = { ok: true, summary: `${verdict.measuredNodes} elements measured clean`, at: Date.now() };
        }
        this.saveMeta();
      } catch (err) {
        console.error('[report] print QA could not run:', err);
      }

      await mod.renderPdf(html, path.join(dir, 'report.pdf'));

      /**
       * The transcript as a group chat, not a markdown dump. Two documents go
       * out because they answer different questions: the report is what the
       * room decided, this is what was actually said. Everything else the
       * session produced (report.html, report.json, transcript.md, agents.md)
       * stays on the app to download; a chat app is no place for a .md file.
       */
      let transcriptPdf: string | null = null;
      try {
        const tr = await import('../report/transcript-pdf.ts');
        const trHtml = tr.renderTranscriptHtml(this.row, events, this.humanName());
        fs.writeFileSync(path.join(dir, 'transcript.html'), trHtml);
        await mod.renderPdf(trHtml, path.join(dir, 'transcript.pdf'));
        transcriptPdf = path.join(dir, 'transcript.pdf');
      } catch (err) {
        console.error('[report] transcript pdf failed:', err);
      }
      this.system(transcriptPdf ? 'PDF exports ready: report and transcript.' : 'PDF export ready.');
    } catch (err) {
      console.error('[report] pdf export skipped:', err);
      this.system('PDF export unavailable on this machine; the interactive report is ready.');
    }
  }
}

// ---------- registry ----------

const runs = new Map<string, DebateRun>();

export const Engine = {
  create(topic: string, config: DebateConfig, files?: { filename: string; buffer: Buffer }[]): string {
    const id = rid('d');
    const row = Debates.create(id, topic, config);
    if (files?.length) {
      const res = saveContextFiles(id, files);
      row.meta.contextFiles = countContextFiles(id);
      row.meta.contextNotes = res.notes;
      Debates.patch(id, { meta: row.meta });
      console.log(`[engine] ${id} context: ${res.saved} files saved, ${res.skipped} skipped`);
    }
    const run = new DebateRun(id);
    runs.set(id, run);
    run.start();
    return id;
  },

  get(id: string): DebateRun | null {
    let run = runs.get(id) ?? null;
    if (!run) {
      const row = Debates.get(id);
      if (!row) return null;
      run = new DebateRun(id);
      runs.set(id, run);
      if (!TERMINAL.includes(row.status)) run.start();
    }
    return run;
  },

  resumeAll() {
    for (const s of Debates.list()) {
      if (!TERMINAL.includes(s.status)) {
        console.log(`[engine] resuming debate ${s.id} (${s.status})`);
        this.get(s.id);
      }
    }
  },

  /**
   * Drop a debate's run from memory without touching its data: what a
   * process restart does. The next get() builds a fresh run from the
   * database. Used by the engine test to restart with research in flight.
   */
  forget(id: string) {
    runs.get(id)?.kill();
    runs.delete(id);
  },

  remove(id: string) {
    runs.get(id)?.kill();
    runs.delete(id);
    Usage.drop(id);
    SearchSeen.drop(id);
    forgetResearch(id);
    /**
     * The provider binding goes with the debate.
     */
    AgentAuth.unbind(id);
    Debates.remove(id);
    fs.rmSync(debateDir(id), { recursive: true, force: true });
  },
};
