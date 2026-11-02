/**
 * MOCK MODE driver. Active when VITE_MOCK=1.
 * Simulates the full server: auth, library, and a scripted live debate
 * that exercises every DebateEvent type and both approval flows.
 *
 * Dev helpers:
 *   window.__mockSpeed = 4   // fast-forward all timing
 */
import type {
  Bid,
  DebateConfig,
  DebateDetail,
  DebateEvent,
  DebateStatus,
  DebateSummary,
  DoorsInfo,
  LiveFrame,
  Persona,
  Plan,
  WireFrame,
} from '../../../shared/types';
import { emptyUsage } from '../../../shared/types';
import type { Api, ReportSource } from '../lib/api';
import { ApiError } from '../lib/api';

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventDraft = DistOmit<DebateEvent, 'seq' | 'ts'>;
type MessageKind = Extract<DebateEvent, { type: 'message' }>['kind'];
type QuestionEv = Extract<DebateEvent, { type: 'question' }>;

declare global {
  interface Window {
    __mockSpeed?: number;
  }
}

const speed = () => window.__mockSpeed || Number(localStorage.getItem('mockSpeed')) || 1;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms / speed()));
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

class Deferred<T> {
  promise: Promise<T>;
  resolve!: (v: T) => void;
  constructor() {
    this.promise = new Promise<T>((res) => (this.resolve = res));
  }
}

/* ------------------------------------------------------------------ */
/* Personas                                                            */
/* ------------------------------------------------------------------ */

const MARCUS: Persona = {
  id: 'marcus',
  name: 'Marcus',
  role: 'Moderator and devil’s advocate',
  tagline: 'Consensus is a hypothesis. I am the test.',
  bio: 'Career moderator of high-stakes decision rooms. Marcus does not hold positions, he holds standards: every claim needs a mechanism and a falsifier. He attacks the panel’s best idea at least once before letting it live.',
  expertise: ['facilitation', 'adversarial review', 'decision quality'],
  personality: 'Calm, surgical, allergic to vibes. Interrupts drift immediately.',
  biases: 'Overweights disconfirming evidence. Suspicious of fast agreement.',
  style: 'Short declaratives. Names people. Assigns the floor.',
  color: '#d9b45b',
  initials: 'M',
  isModerator: true,
};

const PANEL: Persona[] = [
  {
    id: 'ilsa',
    name: 'Dr. Ilsa Brandt',
    role: 'Behavioral economist, decisions under uncertainty',
    tagline: 'Your intuition is a liar with good manners.',
    bio: 'Spent fifteen years studying why smart groups make bad calls. Runs reference-class forecasts before she allows herself an opinion. Changes her mind in public when the data moves, and expects the same of others.',
    expertise: ['base rates', 'forecasting', 'incentive design', 'group judgment'],
    personality: 'Warm delivery, ruthless standards of evidence.',
    biases: 'Overweights historical comparables. Underweights genuinely novel situations.',
    style: 'Numbers first, then the story. Flags her own uncertainty ranges.',
    color: '#4cc9f0',
    initials: 'IB',
  },
  {
    id: 'viktor',
    name: 'Viktor Aslanov',
    role: 'Macro strategist and professional bear',
    tagline: 'Optimism is a cost center.',
    bio: 'Made his reputation calling two cycles early and being unbearable about it. Prices every plan against the hostile scenario first. Believes graceful degradation is the most underrated property a strategy can have.',
    expertise: ['downside scenarios', 'cycles', 'capital discipline', 'risk pricing'],
    personality: 'Dry, contrarian, secretly delighted when proven wrong by rigor.',
    biases: 'Overweights tail risk. Underweights compounding upside.',
    style: 'Paints the worst case in detail, then asks who survives it.',
    color: '#c084fc', // a seat's own hue is data, not the app's accent  taste-skill-ignore
    initials: 'VA',
  },
  {
    id: 'tessa',
    name: 'Tessa Okonkwo',
    role: 'Systems architect, failure-mode engineering',
    tagline: 'Everything couples. My job is deciding what is allowed to.',
    bio: 'Designs systems that fail politely. Reads every strategy as an architecture diagram and immediately looks for the shared dependency that takes the whole thing down. Insists on pre-committed triggers over in-the-moment judgment.',
    expertise: ['systems design', 'failure modes', 'decoupling', 'triggers and tripwires'],
    personality: 'Precise, patient, immovable on hard constraints.',
    biases: 'Overweights structural risk. Underweights speed and momentum.',
    style: 'Draws the dependency graph out loud. Names the coupling.',
    color: '#34d399',
    initials: 'TO',
  },
  {
    id: 'rohan',
    name: 'Rohan Mehta',
    role: 'Operator, zero-to-one execution',
    tagline: 'The thesis never fails. The seam does.',
    bio: 'Has personally run three zero-to-one builds through the ugly middle. Distrusts any plan that needs a team that does not exist yet. His unit of analysis is the month-three-to-nine execution seam where theses go to die.',
    expertise: ['execution', 'sequencing', 'team sizing', 'operational reality'],
    personality: 'Blunt, practical, interrupts abstraction with lived detail.',
    biases: 'Overweights operational friction. Underweights what fresh capital can fix.',
    style: 'War stories with a rule attached. Counts heads, not hopes.',
    color: '#f472b6',
    initials: 'RM',
  },
  {
    id: 'amara',
    name: 'Amara Diallo',
    role: 'Ethnographer of actual human behavior',
    tagline: 'People vote with their feet, then lie about the ballot.',
    bio: 'Studies the gap between what people say they want and what they do when it costs them something. Field notes over surveys, always. Her veto question: does this survive contact with the actual humans involved?',
    expertise: ['field research', 'revealed preference', 'adoption', 'frontline signal'],
    personality: 'Quietly devastating. Speaks late and lands hard.',
    biases: 'Overweights observed behavior. Underweights stated ambition.',
    style: 'Concrete scenes from the field, then the pattern.',
    color: '#fb923c',
    initials: 'AD',
  },
];

/* ------------------------------------------------------------------ */
/* MockDebate                                                          */
/* ------------------------------------------------------------------ */

const PERSIST_PREFIX = 'mockdb:';

interface PersistShape {
  id: string;
  topic: string;
  title: string;
  config: DebateConfig;
  createdAt: number;
  updatedAt: number;
  events: DebateEvent[];
  fileCount?: number;
}

class MockDebate {
  id: string;
  topic: string;
  title: string;
  config: DebateConfig;
  createdAt = Date.now();
  updatedAt = Date.now();
  status: DebateStatus = 'intake';
  events: DebateEvent[] = [];
  personas: Persona[] = [];
  plan: Plan | null = null;
  goal: string | null = null;
  messageCount = 0;
  fileCount = 0;
  fileNames: string[] = [];

  private seq = 0;
  private msgN = 0;
  private listeners = new Set<(f: WireFrame) => void>();
  private partial: { id: string; speaker: string; kind: MessageKind; text: string } | null = null;

  paused = false;
  ended = false;
  private prevStatus: DebateStatus = 'meeting';
  private pendingAnswer: Deferred<string> | null = null;
  pendingAnswerId: string | null = null;
  pendingQuestionEv: QuestionEv | null = null;
  approvalStage: 'goal' | 'panel' | 'plan' | null = null;
  private approvalDef: Deferred<{ action: 'approve' | 'revise'; feedback?: string }> | null = null;

  constructor(id: string, topic: string, config: DebateConfig, persist = true) {
    this.id = id;
    this.topic = topic;
    this.config = config;
    const line = topic.trim().split(/\n/)[0] || 'Untitled debate';
    this.title = line.length > 64 ? line.slice(0, 61).trimEnd() + '...' : line;
    if (persist) this.save();
  }

  private save() {
    try {
      const p: PersistShape = {
        id: this.id,
        topic: this.topic,
        title: this.title,
        config: this.config,
        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
        events: this.events,
        fileCount: this.fileCount,
      };
      sessionStorage.setItem(PERSIST_PREFIX + this.id, JSON.stringify(p));
    } catch {
      /* storage full: mock only, ignore */
    }
  }

  static rehydrate(p: PersistShape): MockDebate {
    const d = new MockDebate(p.id, p.topic, p.config, false);
    d.createdAt = p.createdAt;
    d.updatedAt = p.updatedAt;
    d.fileCount = p.fileCount ?? 0;
    for (const ev of p.events) d.apply(ev);
    d.seq = p.events.reduce((m, e) => Math.max(m, e.seq), 0);
    return d;
  }

  /** Fold a persisted event into cached snapshot state. */
  private apply(ev: DebateEvent) {
    this.events.push(ev);
    this.updatedAt = ev.ts;
    switch (ev.type) {
      case 'status':
        this.status = ev.status;
        break;
      case 'goal':
        this.goal = ev.goal;
        break;
      case 'panel':
        this.personas = ev.personas;
        break;
      case 'plan':
        this.plan = ev.plan;
        break;
      case 'message':
        this.messageCount++;
        break;
    }
  }

  emit(draft: EventDraft) {
    const ev = { ...draft, seq: ++this.seq, ts: Date.now() } as DebateEvent;
    this.apply(ev);
    this.save();
    for (const l of this.listeners) l(ev);
  }

  live(f: LiveFrame) {
    for (const l of this.listeners) l(f);
  }

  st(status: DebateStatus) {
    this.emit({ type: 'status', status });
  }

  subscribe(since: number, onFrame: (f: WireFrame) => void): () => void {
    for (const ev of this.events) if (ev.seq > since) onFrame(ev);
    if (this.partial && this.partial.text) {
      onFrame({
        type: 'delta',
        messageId: this.partial.id,
        speaker: this.partial.speaker,
        kind: this.partial.kind,
        textDelta: this.partial.text,
      });
    }
    this.listeners.add(onFrame);
    return () => this.listeners.delete(onFrame);
  }

  detail(since = 0): DebateDetail {
    return {
      ...this.summary(),
      topic: this.topic,
      ownerName: 'You',
      goal: this.goal,
      personas: this.personas,
      plan: this.plan,
      events: this.events.filter((e) => e.seq > since),
      pendingQuestion: this.pendingQuestionEv,
      pendingApproval: this.approvalStage,
      decisions: [],
      activeMotionId: null,
      hasReport: this.status === 'complete',
      hasPdf: false,
      usage: emptyUsage(),
    };
  }

  summary(): DebateSummary {
    return {
      id: this.id,
      title: this.title,
      status: this.status,
      config: this.config,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      messageCount: this.messageCount,
    };
  }

  /* ---------------- control surface ---------------- */

  /** Mirrors the real server: false = not pending, the route 409s. */
  answer(questionId: string, answer: string): boolean {
    if (this.pendingAnswerId === questionId && this.pendingAnswer) {
      const d = this.pendingAnswer;
      this.pendingAnswer = null;
      this.pendingAnswerId = null;
      this.pendingQuestionEv = null;
      d.resolve(answer);
      return true;
    }
    return false;
  }

  approve(action: 'approve' | 'revise', feedback?: string) {
    if (this.approvalDef) {
      const d = this.approvalDef;
      this.approvalDef = null;
      d.resolve({ action, feedback });
    }
  }

  pause() {
    if (this.paused || TERMINAL.has(this.status)) return;
    this.paused = true;
    this.prevStatus = this.status;
    this.st('paused');
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.st(this.prevStatus);
  }

  end() {
    if (this.ended || TERMINAL.has(this.status)) return;
    this.ended = true;
    this.paused = false;
    this.pendingAnswer?.resolve('(debate ended by the founder)');
    this.pendingAnswer = null;
    this.pendingAnswerId = null;
    this.pendingQuestionEv = null;
    this.approvalDef?.resolve({ action: 'approve' });
    this.approvalDef = null;
    this.approvalStage = null;
  }

  private async gate() {
    while (this.paused) await delay(200);
  }

  /* ---------------- speech ---------------- */

  private async say(speaker: string, kind: MessageKind, text: string, replyTo?: string): Promise<string> {
    await this.gate();
    const id = `${this.id}-m${++this.msgN}`;
    this.live({ type: 'speaking', speaker, phase: 'thinking' });
    await delay(rnd(500, 1100));
    await this.gate();
    this.live({ type: 'speaking', speaker, phase: 'talking' });
    const words = text.split(' ');
    this.partial = { id, speaker, kind, text: '' };
    for (let i = 0; i < words.length; ) {
      const n = 3 + Math.floor(Math.random() * 3);
      const chunk = words.slice(i, i + n).join(' ') + (i + n < words.length ? ' ' : '');
      i += n;
      this.partial.text += chunk;
      this.live({ type: 'delta', messageId: id, speaker, kind, textDelta: chunk });
      await delay(rnd(130, 220));
    }
    this.partial = null;
    this.emit({ type: 'message', id, speaker, kind, text, replyTo });
    this.live({ type: 'speaking', speaker: null, phase: null });
    await delay(rnd(300, 650));
    return id;
  }

  private async askUser(q: Omit<QuestionEv, 'seq' | 'ts' | 'type'>): Promise<string> {
    if (this.ended) return q.options[0]?.label ?? 'proceed';
    if (this.config.autonomy === 'autonomous') {
      this.emit({
        type: 'assumption',
        text: `Autonomous mode: the panel answered for you. Question was: "${q.question}" Assumed: "${q.options[0]?.label ?? 'default'}".`,
      });
      return q.options[0]?.label ?? 'proceed';
    }
    this.emit({ type: 'question', ...q });
    this.pendingAnswerId = q.questionId;
    this.pendingQuestionEv = this.events[this.events.length - 1] as QuestionEv;
    this.pendingAnswer = new Deferred<string>();
    const ans = await this.pendingAnswer.promise;
    this.emit({ type: 'answer', questionId: q.questionId, answer: ans });
    return ans;
  }

  private async clarify(questionId: string, question: string, options: string[]): Promise<string> {
    if (this.ended) return options[0];
    if (this.config.autonomy === 'autonomous') {
      this.emit({
        type: 'assumption',
        text: `Autonomous mode: skipped clarifying question "${question}" and assumed "${options[0]}".`,
      });
      return options[0];
    }
    this.emit({ type: 'clarify', questionId, question, options, allowCustom: true });
    this.pendingAnswerId = questionId;
    this.pendingAnswer = new Deferred<string>();
    const ans = await this.pendingAnswer.promise;
    this.emit({ type: 'answer', questionId, answer: ans });
    return ans;
  }

  /** Propose + approval loop. propose() re-emits the proposal (with feedback woven in on revise). */
  private async approvalGate(
    stage: 'goal' | 'panel' | 'plan',
    approvalStatus: DebateStatus,
    propose: (feedback?: string) => Promise<void>,
  ) {
    let feedback: string | undefined;
    for (;;) {
      if (this.ended) return;
      await this.gate();
      await propose(feedback);
      if (this.config.autonomy === 'autonomous') {
        this.emit({
          type: 'assumption',
          text: `Autonomous mode: ${stage} auto-approved as drafted. No confirmation was requested.`,
        });
        return;
      }
      this.st(approvalStatus);
      this.approvalStage = stage;
      this.approvalDef = new Deferred();
      const res = await this.approvalDef.promise;
      this.approvalStage = null;
      if (this.ended || res.action === 'approve') return;
      feedback = res.feedback || 'Tighten it.';
      this.emit({ type: 'system', text: `Revision requested on ${stage}: ${feedback}` });
    }
  }

  /* ---------------- the script ---------------- */

  async run() {
    try {
      await this.script();
    } catch (e) {
      this.emit({ type: 'error', message: e instanceof Error ? e.message : 'Mock engine fault' });
      this.st('error');
    }
  }

  private async script() {
    const topicShort = this.title.replace(/\.\.\.$/, '');
    const auto = this.config.autonomy === 'autonomous';

    /* ---- intake ---- */
    this.st('intake');
    this.emit({ type: 'system', text: 'Clarity agent engaged. Parsing topic statement.' });
    if (this.fileCount > 0) {
      await delay(900);
      this.emit({ type: 'system', text: `Context dossier detected: ${this.fileCount} file(s). Distilling.` });
      await delay(1300);
      const names = this.fileNames.length > 0 ? ` Key sources: ${this.fileNames.slice(0, 3).join(', ')}.` : '';
      this.emit({
        type: 'context_brief',
        files: this.fileCount,
        brief: `Dossier ingested and distilled.${names} The material sharpens the constraint set: prior numbers and notes are now available to every panelist, and claims that contradict the dossier will be challenged with citations to it.`,
      });
    }
    await delay(1400);
    this.emit({ type: 'system', text: 'Topic parsed. Two ambiguities found. Opening clarification.' });
    await delay(600);

    if (!auto) this.st('clarifying');
    await this.clarify('c1', 'What outcome would make this debate worth your time?', [
      'A go or no-go recommendation',
      'A ranked list of options with tradeoffs',
      'A stress-test of my current plan',
    ]);
    await delay(400);
    await this.clarify('c2', 'How adversarial should the panel be?', [
      'Balanced, with one committed skeptic',
      'Aggressively adversarial on everything',
      'Mostly supportive, poke only the weak points',
    ]);
    if (this.ended) return this.wrapup();

    /* ---- goal ---- */
    await delay(900);
    await this.approvalGate('goal', 'goal_approval', async (feedback) => {
      const base = `Deliver a decision-grade verdict on: "${topicShort}". The panel will steelman the strongest case for and against, audit what evidence actually exists, and end with one concrete recommendation plus the conditions under which it fails.`;
      this.emit({
        type: 'goal',
        title: 'Mission goal',
        goal: feedback ? `${base} Revision applied per your note: ${feedback}` : base,
      });
    });
    if (this.ended) return this.wrapup();

    /* ---- panel design ---- */
    this.st('panel_design');
    this.emit({ type: 'system', text: 'Panel architect scanning the domain space.' });
    await delay(1000);
    this.emit({ type: 'system', text: 'Candidate roster drafted. Tension engineered: one committed bear included.' });
    await delay(1200);
    await this.approvalGate('panel', 'panel_approval', async (feedback) => {
      this.emit({
        type: 'panel',
        personas: [MARCUS, ...PANEL],
        rationale: feedback
          ? `Roster revised per your note (${feedback}). Five specialists covering evidence, downside risk, systems, execution, and ground truth. Viktor stays: consensus needs a predator.`
          : 'Five specialists chosen to cover evidence, downside risk, system structure, execution reality, and ground truth. Deliberate tension built in: Viktor exists to break agreement, Amara to break abstraction.',
      });
    });
    if (this.ended) return this.wrapup();

    /* ---- planning ---- */
    this.st('planning');
    this.emit({ type: 'system', text: 'Marcus drafting the opening agenda. Pre-research agents fanning out.' });
    await delay(1200);
    await this.approvalGate('plan', 'plan_approval', async (feedback) => {
      this.emit({
        type: 'plan',
        plan: {
          revision: 1,
          rationale: feedback ? `Agenda revised: ${feedback}` : undefined,
          items: [
            { id: 'a1', title: 'Frame the decision and define what winning looks like', detail: 'Agree on the actual question and the bar for a useful answer.', status: 'pending' },
            { id: 'a2', title: 'Strongest case in favor, steelmanned', detail: 'The best honest version of yes.', status: 'pending' },
            { id: 'a3', title: 'Strongest case against, steelmanned', detail: 'The best honest version of no.', status: 'pending' },
            { id: 'a4', title: 'Evidence audit: what do we actually know', detail: 'Separate observed fact from confident vibes.', status: 'pending' },
            { id: 'a5', title: 'Recommendation and failure conditions', detail: 'One call, plus what would prove it wrong.', status: 'pending' },
          ],
        },
      });
    });
    if (this.ended) return this.wrapup();

    /* ---- meeting ---- */
    this.st('meeting');
    if (this.plan) {
      const items = this.plan.items.map((it, i) => ({ ...it, status: i === 0 ? ('active' as const) : it.status }));
      this.emit({ type: 'plan', plan: { revision: this.plan.revision, items } });
    }

    const beats: Array<() => Promise<void>> = [
      async () => {
        this.emit({
          type: 'motion_open',
          motionId: 'm1',
          index: 1,
          total: 5,
          title: 'Frame the decision',
          motion: 'Motion: this is a habit business wearing a packaging costume, and should be framed and funded as one.',
        });
        this.live({ type: 'usage', usage: { input: 18400, output: 2200, cacheWrite: 9100, cacheRead: 41000, webSearches: 1, turns: 6, costUsd: 0.42 } });
      },
      async () => {
        await this.say(
          'marcus',
          'marcus',
          'We are in session. The goal is locked and the agenda is approved, so let me set the terms of engagement. I want positions backed by a mechanism, not vibes. If you assert something, tell me what would falsify it. First item: framing the decision. Ilsa, you flagged the base rates earlier. Take the floor.',
        );
      },
      async () => {
        this.emit({
          type: 'bids',
          round: 1,
          bids: [
            { speaker: 'ilsa', urgency: 8, hook: 'I have base rates that reframe the whole question' },
            { speaker: 'viktor', urgency: 6, hook: 'The framing itself smuggles in the conclusion' },
            { speaker: 'rohan', urgency: 5, hook: 'Ground truth from operators before we theorize' },
          ] satisfies Bid[],
          winner: 'ilsa',
        });
        await delay(1600);
      },
      async () => {
        await this.say(
          'ilsa',
          'floor',
          'Start with the reference class, because intuition fails exactly here. Looking at comparable decisions, the base rate of success is far lower than the enthusiasm in this room suggests. Roughly one in three attempts of this shape clears its own bar within two years. That does not kill the idea. It tells us the interesting question is what separates the third that works, and whether this case has those separators.',
        );
      },
      async () => {
        this.lastViktorMsg = await this.say(
          'viktor',
          'floor',
          'I want to push on the reference class itself. You chose comparables that flatter the argument. Class this instead with decisions made under the same incentive structure and the picture darkens considerably. My base case says the tailwinds everyone is assuming are cyclical, not structural. Build the case on the mechanism, not the moment, or we are decorating a guess.',
        );
      },
      async () => {
        await this.say(
          'rohan',
          'interjection',
          'Sorry, jumping in because this matters. Both of you are arguing from datasets, and I have lived the operational side of this exact situation. The failure mode is never the thesis. It is the execution seam between month three and month nine. Any framing that ignores that seam is fantasy.',
          this.lastViktorMsg,
        );
      },
      async () => {
        await this.say(
          'marcus',
          'marcus',
          'Good. That is a real disagreement, not a phrasing dispute. Ilsa says the separators decide it, Viktor says the class is wrong, Rohan says both miss the execution seam. I am commissioning research on the comparables so we stop arm wrestling over anecdotes.',
        );
        this.emit({
          type: 'research_started',
          taskId: 'r1',
          question: 'Assemble the ten closest comparable cases with outcomes, timelines, and the stated reason each succeeded or failed.',
        });
        await delay(600);
        this.emit({ type: 'error', message: 'Research agent rate-limited by upstream search provider. Retried and recovered, no data loss.' });
      },
      async () => {
        await this.say(
          'amara',
          'floor',
          'While that runs, let me bring the ground view, because this room is very abstract right now. I spent time with the people who actually live with decisions like this one, and their stated preferences diverge sharply from their behavior. They say they want the ambitious version. They reliably choose the boring version when it costs them anything. Design for the revealed preference, not the interview answer.',
        );
      },
      async () => {
        await this.say(
          'tessa',
          'floor',
          'And from the systems side: every option on the table couples two things that should stay decoupled. If the ambitious path fails, the way it fails contaminates the safe path too. I want an architecture where the failure of one leg does not take out the other. That constraint alone eliminates one of the options we keep discussing as if it were live.',
        );
      },
      async () => {
        this.emit({
          type: 'bids',
          round: 2,
          bids: [
            { speaker: 'viktor', urgency: 9, hook: 'The downside scenario nobody has priced yet' },
            { speaker: 'amara', urgency: 7, hook: 'Field data on how this actually fails' },
            { speaker: 'ilsa', urgency: 4, hook: 'Small correction to the coupling claim' },
          ] satisfies Bid[],
          winner: 'viktor',
        });
        await delay(1600);
      },
      async () => {
        await this.say(
          'viktor',
          'floor',
          'Here is the scenario nobody has priced. Assume the environment turns hostile in the next cycle. Funding dries up, attention moves on. The ambitious path does not degrade gracefully, it snaps. The conservative path degrades into something smaller but alive. Optionality under stress is worth more than upside under sunshine, and right now we are paying nothing for it.',
        );
      },
      async () => {
        const ans = await this.askUser({
          questionId: 'q1',
          question: 'Which loss would you regret more?',
          context:
            'The panel is split between an ambitious build and a conservative wedge. Viktor argues the ambitious path snaps under stress. Ilsa argues the upside is real and the separators are present. Your risk posture decides which recommendation we sharpen.',
          options: [
            { label: 'Missing the upside', description: 'I would rather absorb a hard failure than watch someone else win the ambitious version.' },
            { label: 'An unrecoverable loss', description: 'Protect the downside first. I can live with a smaller win.' },
            { label: 'Losing time', description: 'Speed matters more than either. Optimize for learning per month.' },
          ],
          allowCustom: true,
        });
        await this.say(
          'marcus',
          'marcus',
          `Noted: "${ans}". That is a real constraint and the recommendation gets built around it. Research desk, what came back?`,
        );
      },
      async () => {
        this.emit({
          type: 'research_done',
          taskId: 'r1',
          summary:
            'Ten comparables found. Six failed, three succeeded modestly, one succeeded at scale. The scale success shared two traits: a wedge that was independently profitable early, and a leader who cut ambitious scope in month four rather than month twelve. Failures overwhelmingly cite sequencing, not thesis.',
        });
        await this.say(
          'research',
          'research',
          'RESEARCH DROP. Comparables are in. The pattern is sequencing: winners started narrow and profitable, then widened. Losers started wide and hoped. Six of ten failures cite sequencing errors explicitly, zero cite a wrong thesis. One caveat: the sample skews toward documented failures, survivor data is thinner.',
        );
      },
      async () => {
        await this.say(
          'ilsa',
          'floor',
          'That research moves me and I want to say so explicitly. I came in weighting the separators as static traits. The data says the decisive separator is behavioral: the willingness to cut scope early. So I am revising my position. The ambitious version is fine as a destination and wrong as a starting point. Sequence it.',
        );
        if (this.plan) {
          this.emit({
            type: 'plan',
            plan: {
              revision: this.plan.revision + 1,
              rationale: 'The research reframed the debate from which path to what sequence. Agenda updated to pressure-test sequencing.',
              items: [
                { ...this.plan.items[0], status: 'done' },
                { ...this.plan.items[1], status: 'done' },
                { ...this.plan.items[2], status: 'active' },
                this.plan.items[3],
                this.plan.items[4],
                { id: 'a6', title: 'Stress-test the sequenced path against a hostile cycle', detail: 'Viktor owns this. The consensus must survive his scenario.', status: 'added' },
              ],
            },
          });
        }
      },
      async () => {
        await this.say(
          'rohan',
          'floor',
          'Now we are talking my language. A sequenced path has an operational shape I can actually critique. The wedge needs to be small enough to run with the team you have, not the team you imagine. My rule: if the first slice needs more than one new hire to work, it is not a wedge, it is a bet wearing a wedge costume.',
        );
      },
      async () => {
        this.lastTessaMsg = await this.say(
          'tessa',
          'floor',
          'Agreed, and sequencing also solves my coupling problem, mostly. One warning though. Sequences create their own failure mode: the pivot point. Whoever owns this needs a pre-committed trigger for widening scope, decided now while heads are cool. Leave that call to the moment and the moment will always say not yet.',
        );
      },
      async () => {
        await this.say(
          'amara',
          'interjection',
          'One addition before we sail past it. The trigger cannot be purely quantitative. People on the ground feel a wedge saturating months before the dashboard shows it. Put a human veto in the trigger. The best operators I have studied trusted the frontline smell test over the metric every time it mattered.',
          this.lastTessaMsg,
        );
        this.emit({
          type: 'assumption',
          text: 'Panel assumed the available budget stays fixed through the first sequence. If budget is elastic, the wedge sizing discussed here is conservative.',
        });
        this.emit({ type: 'convergence', verdict: 'continue', note: 'Real convergence forming around a sequenced path, but the hostile-cycle stress test is still open. Continuing.' });
        this.emit({ type: 'round', motionId: 'm1', round: 2, freshArguments: 3, rung: 1, rungName: 'mechanism', note: 'Argument reached mechanism. Causal stories are on the table.' });
        this.live({ type: 'usage', usage: { input: 52000, output: 7400, cacheWrite: 21000, cacheRead: 168000, webSearches: 3, turns: 19, costUsd: 1.87 } });
      },
      async () => {
        await this.say(
          'viktor',
          'floor',
          'Let me stress the sequence the way the cycle will. Wedge revenue in a downturn gets cut last if it is boring and first if it is discretionary. So the wedge choice is not just about speed to profit, it is about which budget line you live in. Pick the boring line. I withdraw my objection to the overall shape if that constraint holds.',
        );
      },
      async () => {
        await this.say(
          'ilsa',
          'floor',
          'Then we have something rare: Viktor and I agree. Let me consolidate. Sequenced path. Boring-budget wedge. Pre-committed widening trigger with a human veto. Scope-cut discipline at month four if the signal is bad. Every clause came from a different person in this room, which is usually the sign of a conclusion worth keeping.',
        );
      },
      async () => {
        await this.say(
          'marcus',
          'marcus',
          'Before we hold hands and call it wisdom, let me attack it once. Consensus this clean usually means we defined the problem to fit our answer. What if the wedge saturates immediately and the widening trigger fires in month two? Does the sequence survive success arriving early? Rohan, thirty seconds.',
        );
      },
      async () => {
        await this.say(
          'rohan',
          'floor',
          'Fair attack. Early saturation is a good problem with a bad default. The default is to widen everything at once. The discipline is to widen one axis at a time and keep the profitable core untouched. Success arriving early breaks teams that celebrate by breaking their focus. Write that into the roadmap.',
        );
      },
      async () => {
        await this.say(
          'tessa',
          'floor',
          'Closing the loop on my end. The decoupled architecture holds under both timelines, early and late. I am satisfied the failure modes are separable, which was my only hard requirement coming in.',
        );
        await this.say(
          'amara',
          'floor',
          'And from the ground: everything we just agreed survives contact with the actual humans involved, which is the test that matters. I checked each clause against behavior I have observed, not behavior people claim. It holds.',
        );
        this.emit({
          type: 'convergence',
          verdict: 'converged',
          note: 'Panel aligned on a sequenced path with a boring-budget wedge and a pre-committed widening trigger. Dissent resolved or documented. Moving to closing statements.',
        });
      },
    ];

    for (const beat of beats) {
      if (this.ended) break;
      await this.gate();
      await beat();
    }

    // Depth climb, an expert called in, then the written ruling.
    if (!this.ended) {
      this.emit({ type: 'round', motionId: 'm1', round: 5, freshArguments: 2, rung: 2, rungName: 'evidence', note: 'Argument reached evidence. Figures attached and graded.' });
      await delay(700);
      this.emit({
        type: 'panel_amended',
        persona: {
          id: 'nadia', name: 'Nadia Farouk', role: 'Regulatory affairs, consumer health',
          tagline: 'The label is the product.', bio: 'Fifteen years steering supplement launches past regulators.',
          expertise: ['labelling law', 'claims compliance'], personality: 'Precise, unhurried.',
          biases: 'Overweights regulatory risk.', style: 'Cites the rule, then the consequence.',
          color: '#c98fd9', initials: 'NF',
        },
        reason: 'Nobody at the table could answer whether sachet-level claims need separate approval.',
      });
      await delay(900);
      this.emit({ type: 'round', motionId: 'm1', round: 7, freshArguments: 1, rung: 3, rungName: 'stress', note: 'Strongest objection made and answered.' });
      await delay(600);
      this.emit({
        type: 'decision',
        decision: {
          motionId: 'm1',
          motionTitle: 'Frame the decision',
          decision: 'Fund and frame this as a retention business: the organizer is the refill vehicle, not the product.',
          owner: 'Founder',
          rationale: 'The 68 vs 41 percent retention gap was the only measured figure in the room, and it only holds if the box drives refills.',
          evidence: 'mixed',
          dependsOn: ['Refill attach rate exceeds 70 percent in pilot'],
          dissents: [
            { expert: 'Leo Marchetti', position: 'The object still carries the brand and should be priced accordingly.', reasoning: 'Counter presence is earned by design, not refill logistics.' },
          ],
          undecidable: { question: 'Whether sachet claims need separate regulatory approval', evidenceNeeded: 'Written opinion from a labelling consultant', who: 'Nadia Farouk' },
        },
      });
      this.emit({ type: 'motion_closed', motionId: 'm1', rounds: 7, messages: 21 });
      this.live({ type: 'usage', usage: { input: 98000, output: 14200, cacheWrite: 33000, cacheRead: 412000, webSearches: 6, turns: 41, costUsd: 4.18 } });
      await delay(800);
    }

    await this.wrapup();
  }

  private lastViktorMsg = '';
  private lastTessaMsg = '';

  private async wrapup() {
    if (TERMINAL.has(this.status)) return;
    this.ended = true;
    this.st('wrapup');
    const closings: Array<[string, string]> = [
      ['ilsa', 'My closing: the evidence says sequence beats selection. The path you start on matters less than the discipline of the cut at month four. Hold that discipline and the base rates bend in your favor.'],
      ['viktor', 'I came to break this and could not, which is my highest compliment. My conditions are recorded: boring budget line, graceful degradation, no heroics in a downturn. Violate them and my no returns.'],
      ['tessa', 'Keep the legs decoupled, pre-commit the trigger, widen one axis at a time. Architecture is destiny here.'],
      ['rohan', 'Size the wedge for the team you have. One new hire maximum. Execute the seam between months three and nine like it is the whole job, because it is.'],
      ['amara', 'Design for revealed preference. The humans will tell you the truth with their behavior long before they say it out loud. Put the human veto in the trigger and listen to it.'],
      ['marcus', 'Session closed. The report carries the full reasoning trail, the dissents, and the conditions attached to this consensus. My honest read: this survived a genuine adversarial pass, which is more than most plans get. Marcus out.'],
    ];
    for (const [speaker, text] of closings) {
      await this.say(speaker, 'closing', text);
    }
    this.st('reporting');
    this.emit({ type: 'system', text: 'Analyst agents drafting the final report.' });
    await delay(2600);
    this.emit({ type: 'report_ready', path: `/api/debates/${this.id}/report` });
    this.st('complete');
  }
}

const TERMINAL = new Set<DebateStatus>(['complete', 'error', 'cancelled']);

/* ------------------------------------------------------------------ */
/* Store + seed                                                        */
/* ------------------------------------------------------------------ */

const debates = new Map<string, MockDebate>();

function seedArchive() {
  const d = new MockDebate(
    'archive-blackwater',
    'Should we open-source the core engine and monetize the hosted control plane, or keep everything proprietary for two more years while the moat is thin?',
    { provider: 'claude', mode: 'directed', autonomy: 'interactive' },
    false,
  );
  d.createdAt = Date.now() - 1000 * 60 * 60 * 26;
  d.st('intake');
  d.emit({ type: 'panel', personas: [MARCUS, ...PANEL], rationale: 'Archived roster.' });
  d.emit({
    type: 'plan',
    plan: {
      revision: 3,
      items: [
        { id: 'b1', title: 'Define the moat honestly', detail: '', status: 'done' },
        { id: 'b2', title: 'Open-source upside, steelmanned', detail: '', status: 'done' },
        { id: 'b3', title: 'Proprietary upside, steelmanned', detail: '', status: 'done' },
        { id: 'b4', title: 'The hybrid licensing option', detail: 'Added mid-debate.', status: 'done' },
        { id: 'b5', title: 'Recommendation and triggers', detail: '', status: 'done' },
      ],
    },
  });
  d.st('meeting');
  d.emit({ type: 'message', id: 'ar-1', speaker: 'marcus', kind: 'marcus', text: 'Archived session. Open the report for the full reasoning trail; the transcript here is truncated for the archive view.' });
  d.emit({ type: 'message', id: 'ar-2', speaker: 'viktor', kind: 'closing', text: 'Open-sourcing a thin moat is not generosity, it is surrender with better branding. The panel chose the hybrid license and I signed off with conditions.' });
  d.emit({ type: 'message', id: 'ar-3', speaker: 'ilsa', kind: 'closing', text: 'The comparables were unambiguous: control-plane monetization works when the engine is genuinely best in class. The verdict is conditional on that bar.' });
  d.st('wrapup');
  d.st('reporting');
  d.emit({ type: 'report_ready', path: `/api/debates/${d.id}/report` });
  d.st('complete');
  debates.set(d.id, d);
}

function rehydrateAll() {
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (!key || !key.startsWith(PERSIST_PREFIX)) continue;
    try {
      const p = JSON.parse(sessionStorage.getItem(key)!) as PersistShape;
      if (!debates.has(p.id)) debates.set(p.id, MockDebate.rehydrate(p));
    } catch {
      /* corrupt entry, skip */
    }
  }
}

seedArchive();
rehydrateAll();

/* ------------------------------------------------------------------ */
/* Mock report HTML                                                    */
/* ------------------------------------------------------------------ */

function reportHtml(d: MockDebate): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Debate Report</title>
<style>
  body{margin:0;background:#0b0f16;color:#d7e0ea;font:16px/1.7 Georgia, 'Times New Roman', serif;padding:56px 24px}
  main{max-width:760px;margin:0 auto}
  h1{font:700 34px/1.2 'Helvetica Neue', Arial, sans-serif;letter-spacing:-0.5px;color:#fff;margin:0 0 6px}
  .sub{color:#7e8ea1;font:13px/1.5 'Courier New', monospace;letter-spacing:.12em;text-transform:uppercase;margin-bottom:40px}
  h2{font:700 15px/1.3 'Courier New', monospace;letter-spacing:.2em;text-transform:uppercase;color:#57c7e3;border-bottom:1px solid #1d2836;padding-bottom:8px;margin:44px 0 16px}
  .verdict{border-left:3px solid #57c7e3;background:#0f1622;padding:18px 22px;font-size:18px}
  ul{padding-left:22px} li{margin-bottom:10px}
  .dissent{border-left:3px solid #e3a857;background:#171308;padding:14px 20px;margin:12px 0}
  .tag{color:#7e8ea1;font:12px 'Courier New', monospace}
</style></head><body><main>
  <h1>${escapeHtml(d.title)}</h1>
  <div class="sub">Final report / mock build / ${new Date(d.updatedAt).toISOString().slice(0, 10)}</div>
  <h2>Verdict</h2>
  <div class="verdict">Take the sequenced path: start with a narrowly scoped, independently profitable wedge in a boring budget line, with a pre-committed widening trigger that includes a human veto.</div>
  <h2>Why the panel landed here</h2>
  <ul>
    <li><b>Ilsa Brandt:</b> comparables show sequencing, not thesis quality, separates winners. Her position moved mid-debate when the research landed.</li>
    <li><b>Viktor Aslanov:</b> withdrew his objection conditional on the wedge living in a non-discretionary budget line and degrading gracefully in a downturn.</li>
    <li><b>Tessa Okonkwo:</b> the sequenced architecture keeps failure modes decoupled, her single hard requirement.</li>
    <li><b>Rohan Mehta:</b> wedge sized for the existing team, one new hire maximum; the month three to nine execution seam is the whole job.</li>
    <li><b>Amara Diallo:</b> every clause was checked against observed behavior rather than stated preference. The human veto in the trigger is hers.</li>
  </ul>
  <h2>Recorded dissent and conditions</h2>
  <div class="dissent">Viktor's approval is conditional. If the wedge drifts into a discretionary budget line, or heroics are required to survive a downturn, his no returns and this verdict should be re-opened.</div>
  <h2>Failure conditions</h2>
  <ul>
    <li>The wedge fails to reach independent profitability by the pre-committed checkpoint.</li>
    <li>The widening trigger fires and scope expands on more than one axis at once.</li>
    <li>Frontline signal (the human veto) is overridden by the dashboard twice in a row.</li>
  </ul>
  <p class="tag">Generated by the DEBATE mock engine. The real pipeline produces the full interactive report.</p>
</main></body></html>`;
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ------------------------------------------------------------------ */
/* Auth state                                                          */
/* ------------------------------------------------------------------ */

/**
 * The bench runs as a default local install: no password. Set
 * `sessionStorage['mock-password'] = '1'` to exercise the sign-in screen
 * (any non-empty password except "wrong" is accepted).
 */
const AUTH_KEY = 'mock-auth';
const passwordMode = () => sessionStorage.getItem('mock-password') === '1';

/**
 * The Connect screen in the dev mock: one door of each state, so every card
 * style can be looked at. Same wording the server probe uses.
 */
function mockDoors(): DoorsInfo {
  const envFile = '/Users/you/debate/.env';
  const openEnv = `touch "${envFile}" && open -e "${envFile}"`;
  const now = Date.now();
  return {
    envFile,
    mock: false,
    doors: [
      {
        id: 'claude', title: 'Claude: sign in', state: 'ready', checkedAt: now, fix: null, note: null,
        blurb: 'Use your Claude subscription (Pro or Max) through Claude Code. No key, and no bill beyond your plan.',
        summary: 'Claude Code is installed and signed in.',
        steps: [
          { text: 'Install Claude Code (one time). In a terminal, run:', copy: 'npm install -g @anthropic-ai/claude-code' },
          { text: 'Start it and sign in with your Claude account. It opens your browser; approve, and come back.', copy: 'claude' },
          { text: 'Once it says you are signed in, type /exit to leave it.' },
          { text: 'Come back here and press Re-check.' },
        ],
      },
      {
        id: 'anthropic', title: 'Claude: API key', state: 'needs_setup', checkedAt: now, note: null,
        blurb: 'Pay as you go with an API key from the Anthropic Console. The same Claude models, billed to your Anthropic account.',
        summary: 'No ANTHROPIC_API_KEY in .env yet.',
        fix: 'Create a key in the Anthropic Console, add ANTHROPIC_API_KEY= and the key to .env, then press Re-check.',
        steps: [
          { text: 'Create a key at https://console.anthropic.com/settings/keys and copy it.', copy: 'https://console.anthropic.com/settings/keys' },
          { text: "Open the app's settings file (.env) in a text editor. This command opens it, and creates it if it is not there yet:", copy: openEnv },
          { text: 'Add this line, paste your key straight after the = sign (no spaces, no quotes), and save the file:', copy: 'ANTHROPIC_API_KEY=' },
          { text: 'This door runs on Claude Code. If it is not installed yet, install it too (no sign-in needed):', copy: 'npm install -g @anthropic-ai/claude-code' },
          { text: 'Come back here and press Re-check. No restart is needed.' },
        ],
      },
      {
        id: 'codex', title: 'ChatGPT: Codex sign-in', state: 'problem', checkedAt: now, note: null,
        blurb: 'Use your ChatGPT plan (Plus or Pro) through the Codex CLI. No key, and no per-token bill.',
        summary: 'Codex is signed in with an API key, not with ChatGPT.',
        fix: 'Run `codex login` and choose "Sign in with ChatGPT", then press Re-check.',
        steps: [
          { text: 'Install the Codex CLI (one time). In a terminal, run:', copy: 'npm install -g @openai/codex' },
          { text: 'Sign in, and choose "Sign in with ChatGPT". It opens your browser; approve, and come back.', copy: 'codex login' },
          { text: 'Come back here and press Re-check.' },
        ],
      },
      {
        id: 'openai', title: 'OpenAI: API key', state: 'ready', checkedAt: now, fix: null,
        blurb: 'Pay as you go with an API key from the OpenAI platform, billed to your OpenAI account.',
        summary: 'An API key is set (it is never shown).',
        note: 'Billed per use to your OpenAI account. The key is only checked for its shape here; if OpenAI refuses it, the debate pauses and says so.',
        steps: [
          { text: 'Create a key at https://platform.openai.com/api-keys and copy it.', copy: 'https://platform.openai.com/api-keys' },
          { text: "Open the app's settings file (.env) in a text editor. This command opens it, and creates it if it is not there yet:", copy: openEnv },
          { text: 'Add this line, paste your key straight after the = sign (no spaces, no quotes), and save the file:', copy: 'OPENAI_API_KEY=' },
          { text: 'Come back here and press Re-check. No restart is needed.' },
        ],
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Api implementation                                                  */
/* ------------------------------------------------------------------ */

export const mockApi: Api = {
  async me() {
    await delay(150);
    const ok = !passwordMode() || sessionStorage.getItem(AUTH_KEY) === '1';
    return {
      ok,
      authRequired: passwordMode(),
      csrfToken: 'mock',
      providers: ok ? { claude: true, anthropic: false, codex: false, openai: true } : null,
      founderName: null,
    };
  },
  async doors(fresh) {
    await delay(fresh ? 600 : 120);
    return mockDoors();
  },
  async login(password: string) {
    await delay(300);
    if (password === 'wrong') throw new ApiError(401, 'Wrong password.');
    sessionStorage.setItem(AUTH_KEY, '1');
  },
  async logout() {
    sessionStorage.removeItem(AUTH_KEY);
  },
  async deleteDebate(id: string) {
    await delay(200);
    debates.delete(id);
    sessionStorage.removeItem('mockdb:' + id);
  },

  async listDebates() {
    await delay(250);
    return [...debates.values()]
      .map((d) => d.summary())
      .sort((a, b) => b.updatedAt - a.updatedAt);
  },

  async createDebate(topic, config, files) {
    await delay(500);
    const id = `dbt-${Date.now().toString(36)}`;
    const d = new MockDebate(id, topic, config);
    if (files && files.length > 0) {
      d.fileCount = files.length;
      d.fileNames = files.map((f) => f.name);
    }
    debates.set(id, d);
    void d.run();
    return { id };
  },

  async getDebate(id, since = 0) {
    await delay(180);
    const d = debates.get(id);
    if (!d) throw new ApiError(404, 'Debate not found.');
    return d.detail(since);
  },

  async answer(id, questionId, answer) {
    const ok = debates.get(id)?.answer(questionId, answer) ?? false;
    // Same wire behavior as the real route: a non-pending question 409s.
    if (!ok) throw new ApiError(409, 'no such pending question');
  },

  async approve(id, _stage, action, feedback) {
    debates.get(id)?.approve(action, feedback);
  },

  async end(id) {
    debates.get(id)?.end();
  },

  async pause(id) {
    debates.get(id)?.pause();
  },

  async resume(id) {
    debates.get(id)?.resume();
  },

  async setProfile() {
    /* the dev mock has no intake to re-size */
  },

  report(id): ReportSource {
    const d = debates.get(id);
    return { srcdoc: d ? reportHtml(d) : '<h1>Report not found</h1>' };
  },

  openStream(id, since, onFrame, _onDown) {
    const d = debates.get(id);
    if (!d) return () => undefined;
    return d.subscribe(since, onFrame);
  },
};
