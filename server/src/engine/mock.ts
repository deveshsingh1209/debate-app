import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CFG, debateDir } from '../config.ts';
import { Debates, Events, type DebateRow } from '../db.ts';
import { Hub } from '../sse.ts';
import { MARCUS } from '../agents/prompts.ts';
import { appendTranscriptFile, founderLine, initTranscriptFile } from './transcript.ts';
import { decideInterruption, newFloor, type DirectorSeat } from './director.ts';
import { budgetSnapshot, profileOf } from '../budget.ts';
import { estimateCost } from '../scope.ts';
import { fakeResearch } from '../research/fake.ts';
import type { DebateConfig, DebateStatus, Persona, Plan } from '../../../shared/types.ts';
import { playScenario } from './mock-v2.ts';
import { SCENARIOS } from './mock-scenarios.ts';
import { modelFor, providerOfConfig, PROVIDER_LABEL, SEAT_TIER, type Seat } from '../../../shared/models.ts';

/**
 * MOCK=1 engine: drives a fully scripted debate through the real DB + SSE hub,
 * so the whole stack (API, streaming, UI) can be exercised without one Claude call.
 */

const rid = (p: string) => `${p}_${crypto.randomBytes(6).toString('base64url')}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CAST: Persona[] = [
  { id: 'sana', name: 'Dr. Sana Kapoor', role: 'Nutraceutical scientist', tagline: 'If the compound degrades, the box failed.', bio: 'Two decades in supplement formulation and stability testing.', expertise: ['formulation', 'stability'], personality: 'Precise, allergic to marketing claims.', biases: 'Overweights degradation risk.', style: 'Clinical, numbers first.', color: '#22d3ee', initials: 'SK' },
  { id: 'leo', name: 'Leo Marchetti', role: 'Industrial designer', tagline: 'People abandon ugly routines.', bio: 'Designed award-winning consumer health hardware.', expertise: ['CMF', 'ergonomics'], personality: 'Romantic about objects.', biases: 'Overweights aesthetics.', style: 'Visual, metaphor heavy.', color: '#a78bfa', initials: 'LM' },
  { id: 'mei', name: 'Mei-Lin Zhou', role: 'Supply chain strategist', tagline: 'Beautiful prototypes die in tooling.', bio: 'Scaled three hardware startups through Shenzhen.', expertise: ['tooling', 'unit economics'], personality: 'Blunt, practical.', biases: 'Kills anything under 40 percent margin.', style: 'Short declarative sentences.', color: '#34d399', initials: 'MZ' },
  { id: 'ravi', name: 'Ravi Menon', role: 'D2C growth operator', tagline: 'Distribution beats product, twice on Sundays.', bio: 'Built two eight-figure subscription brands.', expertise: ['CAC', 'retention'], personality: 'Energetic, impatient.', biases: 'Believes everything is a funnel.', style: 'Talks in cohorts.', color: '#f472b6', initials: 'RM' },
  { id: 'ines', name: 'Dr. Ines Farrow', role: 'Behavioral scientist', tagline: 'Habit is the product.', bio: 'Researches adherence and habit loops in health.', expertise: ['habit design', 'adherence'], personality: 'Calm, socratic.', biases: 'Suspicious of gadgets solving human problems.', style: 'Asks questions back.', color: '#fb923c', initials: 'IF' },
];

const SCRIPT: [string, string, string][] = [
  ['marcus', 'marcus', 'Let us start with the only question that matters: is this a packaging business or a habit business? Ines, frame it.'],
  ['ines', 'floor', 'It is a habit business wearing a packaging costume. The organizer is a trigger object, its job is to sit where coffee is made and make skipping feel like breaking a streak. If we design for shelf beauty instead of counter presence, we lose.'],
  ['leo', 'floor', 'I agree with the counter presence framing, but Ines undersells the object. A beautiful object earns the counter. Ugly pill boxes get hidden in drawers, and drawers are where habits go to die.'],
  ['mei', 'interjection', 'Before we fall in love, weekly-fill mechanisms with 28 cavities double tooling cost. Beauty has a mold budget.'],
  ['ravi', 'floor', 'Numbers, since Mei opened the door. Subscription supplement churn is brutal, month four is the cliff. A physical organizer cuts churn if and only if it is the refill vehicle. The box is the retention asset, not the product.'],
  ['marcus', 'marcus', 'Ravi just redefined the business model. Sana, does the refill-pouch model survive stability testing?'],
  ['sana', 'floor', 'Partially. Probiotics and omegas degrade fast outside blister packs, so loose-fill cavities are a stability lie for a third of the catalog. Refill pouches with weekly sachets work, but that changes the cavity geometry completely.'],
  ['leo', 'floor', 'Sachets actually free the design. If cavities hold sachets, not loose pills, I can shrink the footprint and make the lid the ritual surface. I am revising my concept from tray to tower.'],
  // Answered live by the fake research provider (see research()); the text here is unused.
  ['research', 'research', ''],
  ['ravi', 'floor', 'That 68 versus 41 retention gap is the whole pitch. We are not selling a box, we are buying churn insurance with injection molding.'],
  ['mei', 'floor', 'Then the box should be sold at cost, 19 to 24 dollars landed, and margin lives in refills. I withdraw my tooling objection if we standardize one sachet size across all SKUs.'],
  ['marcus', 'marcus', 'Sana, one sachet size across the catalog, can formulation live with that constraint?'],
  ['sana', 'floor', 'Yes, with a 4ml sachet envelope we cover 90 percent of formats. The remaining 10 percent, mostly gummies, should be cut from launch anyway. Constraint accepted.'],
  ['ines', 'closing', 'Design the streak, not the box. Counter presence, one visible empty row as the nudge, refills as the heartbeat. What would change my mind: adherence data showing no lift after 90 days.'],
  ['sana', 'closing', 'Sachet-first, stability-safe, cut gummies at launch. I fold if third-party stability tests pass loose-fill for the full catalog.'],
  ['leo', 'closing', 'Tower form, lid as ritual surface, sold at cost. I fold if counter-presence testing shows drawer storage anyway.'],
  ['mei', 'closing', 'One sachet size, box at cost, margin in refills, 40 percent floor. I fold if refill attach rate is under 70 percent in pilot.'],
  ['ravi', 'closing', 'The box is churn insurance. Pilot with 500 units, measure month-four retention delta, scale only past 15 points of lift. Nothing changes my mind except that number.'],
];

/**
 * Phase 2b-3, scripted: graded claims beside the speech (the trailer's CLAIMS
 * line, already parsed) and a lint record, keyed by SCRIPT index. The grades
 * render as chips under the bubble; nobody says them.
 */
const SCRIPT_EXTRAS: Record<number, Record<string, unknown>> = {
  4: { shape: 'set_piece', claims: [{ text: 'subscription supplement churn peaks around month four', grade: 'observed' }, { text: 'a refill organizer cuts churn only as the refill vehicle', grade: 'assumed' }], lint: { score: 0, rewrote: false, rules: [] } },
  6: { shape: 'reply', claims: [{ text: 'probiotics and omegas degrade outside blister packs', grade: 'measured' }], lint: { score: 3, rewrote: true, rules: ['banned:meta_speech'] } },
  9: { shape: 'reply', to: ['mei'], claims: [{ text: 'the 68 versus 41 retention gap holds for this category', grade: 'assumed' }], lint: { score: 0, rewrote: false, rules: [] } },
};

class MockRun {
  readonly id: string;
  row: DebateRow;
  private waiter: ((v: any) => void) | null = null;
  killed = false;
  pausedFlag = false;
  endedFlag = false;

  constructor(id: string) {
    this.id = id;
    this.row = Debates.get(id)!;
  }

  pub(ev: any) { if (!this.killed) return Hub.publish(this.id, ev); }
  live(f: any) { if (!this.killed) Hub.live(this.id, f); }
  setStatus(status: DebateStatus) {
    Debates.patch(this.id, { status });
    this.row.status = status;
    this.pub({ type: 'status', status });
  }
  private signalQueue: any[] = [];
  wait(): Promise<any> {
    const q = this.signalQueue.shift();
    if (q) return Promise.resolve(q);
    return new Promise((r) => (this.waiter = r));
  }
  private signal(v: any) {
    const w = this.waiter;
    if (w) { this.waiter = null; w(v); }
    else this.signalQueue.push(v);
  }
  meta() { return this.row.meta; }
  saveMeta() { Debates.patch(this.id, { meta: this.row.meta }); }

  answer(questionId: string, answer: string): boolean {
    const m = this.meta();
    if (m.pendingClarify.includes(questionId)) {
      m.pendingClarify = m.pendingClarify.filter((x) => x !== questionId);
      this.saveMeta();
      this.pub({ type: 'answer', questionId, answer });
      if (!m.pendingClarify.length) this.signal({ kind: 'answers' });
      return true;
    }
    if (m.pendingQuestionId === questionId) {
      m.pendingQuestionId = null;
      this.saveMeta();
      this.pub({ type: 'answer', questionId, answer });
      appendTranscriptFile(this.id, `**${founderLine(CFG.founderName)}:** ${answer}`);
      this.signal({ kind: 'answer' });
      return true;
    }
    return false;
  }

  approve(stage: string, action: string, feedback?: string): boolean {
    if (this.meta().pendingApproval !== stage) return false;
    this.meta().pendingApproval = null;
    this.saveMeta();
    this.signal({ kind: 'approve', stage, action, feedback });
    return true;
  }

  end() { this.endedFlag = true; this.signal({ kind: 'end' }); }
  pause(): boolean { if (this.row.status !== 'meeting') return false; this.pausedFlag = true; this.setStatus('paused'); return true; }
  resumeMeeting(): boolean { if (this.row.status !== 'paused') return false; this.pausedFlag = false; this.setStatus('meeting'); this.signal({ kind: 'resume' }); return true; }
  kill() { this.killed = true; this.signal({ kind: 'end' }); }

  async gate(stage: 'goal' | 'panel' | 'plan'): Promise<void> {
    if (this.row.config.autonomy === 'autonomous') {
      this.pub({ type: 'system', text: `Auto-approved ${stage} (autonomous session).` });
      return;
    }
    this.meta().pendingApproval = stage;
    this.saveMeta();
    while (true) {
      const sig = await this.wait();
      if (sig.kind === 'end') throw new Error('cancelled');
      if (sig.kind === 'approve') {
        if (sig.action === 'approve') return;
        this.pub({ type: 'system', text: `Revision requested: "${sig.feedback ?? ''}". Mock engine re-emits with a tweak.` });
        this.meta().pendingApproval = stage;
        this.saveMeta();
        if (stage === 'goal') this.pub({ type: 'goal', title: this.row.title, goal: `${this.row.goal} (revised: ${sig.feedback ?? 'tightened'})` });
        if (stage === 'panel') this.pub({ type: 'panel', personas: this.row.personas, rationale: 'Revised roster (mock: same seats, sharper knives).' });
        if (stage === 'plan') this.pub({ type: 'plan', plan: this.row.plan! });
      }
    }
  }

  /**
   * A silence with a stage on it, exactly as the real engine produces one.
   * The bench exists so the room's waiting states can be checked without
   * spending a real debate on them, so it has to fake the thinking too.
   */
  private async think(
    actor: 'marcus' | 'referee' | 'chair' | 'research' | 'panel' | 'report',
    label: string,
    detail: string,
    reasoning: string,
    ms = 6000
  ) {
    const st = Hub.stage(this.id, actor, label, detail);
    const words = reasoning.split(' ');
    const step = Math.max(1, Math.ceil(words.length / Math.max(1, ms / 550)));
    for (let i = 0; i < words.length && !this.killed; i += step) {
      st.think((i ? ' ' : '') + words.slice(i, i + step).join(' '));
      await sleep(550);
    }
    st.close();
  }

  /** A fake spend ledger, so the budget meter can be looked at without spending anything. */
  private ledger = { usd: 0, output: 0, flagshipCalls: 0, calls: 0, turns: 0 };
  private profile() {
    return profileOf(this.row.config);
  }
  private meter(spokenTurn: boolean, persist = false) {
    const p = this.profile();
    if (!p) return;
    this.ledger.calls += 1;
    this.ledger.flagshipCalls += 1;
    this.ledger.usd += 0.11;
    this.ledger.output += 900;
    if (spokenTurn) this.ledger.turns += 1;
    const snap = budgetSnapshot(p, providerOfConfig(this.row.config), this.ledger, {
      expectedTurns: 30,
      estimate: { lowUsd: 4.48, highUsd: 8.4 },
      ceilingUsd: this.row.config.ceilingUsd ?? CFG.budgetCeilingUsd,
    });
    this.live({ type: 'budget', budget: snap });
    if (persist) this.pub({ type: 'budget', budget: snap });
  }

  private async stream(speaker: string, kind: string, text: string, extra: Record<string, unknown> = {}) {
    const messageId = rid('m');
    this.live({ type: 'speaking', speaker, phase: 'thinking' });
    await sleep(700);
    this.live({ type: 'speaking', speaker, phase: 'talking' });
    const words = text.split(' ');
    for (let i = 0; i < words.length; i += 3) {
      if (this.killed) return;
      this.live({ type: 'delta', messageId, speaker, kind, textDelta: (i ? ' ' : '') + words.slice(i, i + 3).join(' ') });
      await sleep(90);
    }
    this.pub({ type: 'message', id: messageId, speaker, kind, text, ...extra });
    const name = this.row.personas.find((p) => p.id === speaker)?.name ?? (speaker === 'research' ? 'RESEARCH DESK' : speaker);
    appendTranscriptFile(this.id, `**${name}${kind === 'interjection' ? ' (interrupting)' : kind === 'closing' ? ' (closing)' : ''}:** ${text}`);
    this.live({ type: 'speaking', speaker: null, phase: null });
    this.meta().floorCount++;
    this.saveMeta();
    this.meter(kind === 'floor' || kind === 'interjection');
  }

  /**
   * Phase 2b-4: a research request answered by the fake provider, which runs
   * through the same normaliser as the real doors, so the citations, the
   * spoken line and the provenance labels look exactly as a real answer
   * would on this debate's door (an OpenAI-door mock shows search_result
   * sources, a Codex-door mock shows them as reported by the model).
   */
  private async research(question: string, speak: boolean) {
    const door = providerOfConfig(this.row.config);
    const req = { id: rid('r'), debateId: this.id, question, askedBy: 'marcus', purpose: 'fact_check' as const, maxSources: 4, budget: { maxSearches: 4, timeoutMs: 10_000 } };
    this.pub({ type: 'research_started', taskId: req.id, question });
    const result = await fakeResearch(door, 1500).run(req, { signal: new AbortController().signal, goal: this.row.goal ?? '' });
    if (this.killed) return;
    this.meta().researchBriefs.push({ question, summary: result.summary, citations: result.citations, status: result.status, askedBy: 'marcus', motionId: null });
    this.saveMeta();
    if (speak) {
      this.pub({ type: 'message', id: rid('m'), speaker: 'research', kind: 'research', text: result.spoken });
      appendTranscriptFile(this.id, `**RESEARCH DESK (${question}):** ${result.spoken}`);
    }
    this.pub({ type: 'research_done', taskId: req.id, summary: result.summary.slice(0, 280), result });
  }

  /**
   * Phase 2b, scripted: a set piece cut off mid-sentence by a cut-in that is
   * spoken over its last words, a pause, and the speaker taking the floor back.
   * Where the cut lands is decided by the real FloorDirector from a scripted
   * reaction, not hard-coded. Both turns stream at once for a few seconds, so
   * a browser refresh in that window has two partial messages to rebuild.
   */
  private async overlapScene() {
    const speakerText = 'Probiotics survive fine in sachets, and the omega data is clean as long as the sachet is foil-lined. The weekly refill lands inside the margin floor at nineteen dollars landed, which is why I keep saying the box is the cheap part.';
    const cutIn = 'Nineteen landed? On what volume?';
    const seats: DirectorSeat[] = CAST.map((p) => ({ id: p.id, temperament: { heatGain: 0.3, heatDecay: 0.1, interruptThreshold: 0.6, dominance: p.id === 'sana' ? 0.7 : 0.5 } }));
    const floor = newFloor('a2', seats, `${this.id}:overlap`);
    floor.heat.mei = 0.6;
    const cut = decideInterruption(floor, seats, 'sana', speakerText, [{ listener: 'mei', intensity: 3, atSentence: 1, cutIn }]);
    if (!cut) return; // the director said no; the scene is skipped rather than faked
    const spoken = speakerText.slice(0, cut.atChar);
    const sanaId = rid('m');
    const meiId = rid('m');
    const sanaWords = spoken.split(' ');
    const meiWords = cutIn.split(' ');
    const overlapFrom = Math.max(0, sanaWords.length - 3);  // the cut-in starts over the last few words
    const delta = (messageId: string, speaker: string, kind: string, text: string) =>
      this.live({ type: 'delta', messageId, speaker, kind, textDelta: text });

    this.live({ type: 'speaking', speaker: 'sana', phase: 'talking' });
    let m = 0;
    for (let i = 0; i < sanaWords.length; i++) {
      if (this.killed) return;
      delta(sanaId, 'sana', 'floor', (i ? ' ' : '') + sanaWords[i]);
      if (i >= overlapFrom && m < meiWords.length) {
        delta(meiId, 'mei', 'reaction', (m ? ' ' : '') + meiWords[m++]);
      }
      await sleep(110);
    }
    // Both turns are open now: the window a refresh test looks for.
    await sleep(3000);
    const fromChar = sanaWords.slice(0, overlapFrom).join(' ').length;
    this.pub({ type: 'message', id: sanaId, speaker: 'sana', kind: 'floor', shape: 'set_piece', text: spoken, cutOff: { atChar: cut.atChar, by: 'mei' } });
    appendTranscriptFile(this.id, `**${CAST[0].name}:** ${spoken}— [cut off by ${CAST[2].name}]`);
    while (m < meiWords.length) {
      delta(meiId, 'mei', 'reaction', (m ? ' ' : '') + meiWords[m++]);
      await sleep(110);
    }
    this.pub({ type: 'message', id: meiId, speaker: 'mei', kind: 'reaction', shape: 'reaction', to: ['sana'], text: cutIn, overlap: { with: sanaId, fromChar } });
    appendTranscriptFile(this.id, `**${CAST[2].name} (over ${CAST[0].name}):** ${cutIn}`);
    this.live({ type: 'speaking', speaker: null, phase: null });
    this.pub({ type: 'pause', ms: 2000, reason: 'tension' });
    await sleep(800);
    await this.stream('sana', 'floor', 'Let me finish. On a ten-thousand-unit run, yes. Below that it is twenty-three, and that is the number we should be arguing about.');
  }

  async run() {
    try {
      // MOCK_SCENARIO=legacy keeps the original five-expert script below; anything else is mock v2.
      const key = (process.env.MOCK_SCENARIO ?? 'pricing').trim();
      if (key !== 'legacy') {
        const scn = SCENARIOS[key];
        if (!scn) throw new Error(`MOCK_SCENARIO="${key}" is not a scenario. Use one of: ${Object.keys(SCENARIOS).join(', ')}, legacy.`);
        await playScenario(this, scn);
        return;
      }
      // Intake
      if (this.meta().contextFiles > 0) {
        this.pub({ type: 'system', text: `Dossier analyst reading your uploaded context (${this.meta().contextFiles} files).` });
        await sleep(1500);
        this.pub({ type: 'context_brief', files: this.meta().contextFiles, brief: 'The uploaded material covers a prior brainstorm on supplement packaging: a decision to target urban wellness buyers was already made, a 40 percent margin floor was agreed with the cofounder, and an unresolved thread questions whether refills ship monthly or quarterly. One spreadsheet estimates landed cost at $19.40 for the tray concept.' });
      }
      this.pub({ type: 'system', text: 'Intake analysis running. Assessing whether the mission is clear enough to brief a panel.' });
      await sleep(1200);
      const q1 = rid('q'), q2 = rid('q');
      this.pub({ type: 'clarify', questionId: q1, question: 'Is this a physical product business or a subscription service with a physical anchor?', options: ['Physical product', 'Subscription with refills', 'Undecided, panel should weigh in'], allowCustom: true });
      this.pub({ type: 'clarify', questionId: q2, question: 'Which market first?', options: ['India', 'US', 'Global from day one'], allowCustom: true });
      this.meta().pendingClarify = [q1, q2];
      this.saveMeta();
      this.setStatus('clarifying');
      await this.wait();

      this.setStatus('intake');
      await sleep(900);
      Debates.patch(this.id, { title: 'THE SUPPLEMENT BOX WAR', goal: 'Decide whether a premium supplement organizer is a viable D2C wedge: the product architecture (organizer vs refill system), target market, unit economics floor, and a go/no-go pilot plan with kill metrics.' });
      this.row = Debates.get(this.id)!;
      this.pub({ type: 'goal', title: this.row.title, goal: this.row.goal! });
      this.pub({
        type: 'scope',
        scope: {
          experts: 5, motions: 3, roundsPerMotion: 3, depth: 'standard',
          rationale: 'I count three genuinely separate calls here: the product architecture, the unit-economics floor, and the pilot design. Everything else is downstream of those. Five voices cover the disciplines without padding, and standard depth answers the strongest objection on each without pretending this is a board fight.',
          // The real estimate for this shape: informational, never a limit.
          estimate: {
            ...estimateCost({ experts: 5, motions: 3, roundsPerMotion: 3, depth: 'standard', rationale: '' }, providerOfConfig(this.row.config), false, this.profile(), this.row.config.ceilingUsd ?? CFG.budgetCeilingUsd),
            ...(this.row.config.profile === 'auto' ? { profileReason: 'A contained call: the standard room argues it fully. (mock)' } : {}),
          },
        },
      });
      this.setStatus('goal_approval');
      await this.gate('goal');

      // Panel
      this.setStatus('panel_design');
      this.pub({ type: 'system', text: 'Panel architect at work. Researching the domain and designing the expert roster.' });
      await sleep(2000);
      const roster = [MARCUS, ...CAST];
      Debates.patch(this.id, { personas: roster });
      this.row.personas = roster;
      this.pub({ type: 'panel', personas: roster, rationale: 'Five seats, four friction lines: science vs design, design vs manufacturing, growth vs behavior, everyone vs the spreadsheet.' });
      this.setStatus('panel_approval');
      await this.gate('panel');

      // Planning + pre-research, through the fake research provider and the real normaliser.
      this.setStatus('planning');
      await this.research('Current D2C supplement organizer market: leaders, pricing, retention data.', false);
      const plan: Plan = {
        revision: 1,
        rationale: 'Opening agenda.',
        items: [
          { id: 'a1', title: 'Frame the business', detail: 'Packaging vs habit vs retention asset.', status: 'active' },
          { id: 'a2', title: 'Product architecture', detail: 'Loose-fill vs sachet, stability constraints.', status: 'pending' },
          { id: 'a3', title: 'Unit economics', detail: 'Tooling, landed cost, margin floor.', status: 'pending' },
          { id: 'a4', title: 'Retention math', detail: 'Churn insurance thesis, attach rates.', status: 'pending' },
          { id: 'a5', title: 'Pilot design', detail: 'Kill metrics and go/no-go.', status: 'pending' },
        ],
      };
      Debates.patch(this.id, { plan });
      this.row.plan = plan;
      this.pub({ type: 'plan', plan });
      this.setStatus('plan_approval');
      await this.gate('plan');

      // The fixed casting sheet, same shape the real engine emits.
      const provider = providerOfConfig(this.row.config);
      const seats: Seat[] = ['chair', 'floor', 'ruling', 'referee', 'report', 'quant', 'summon', 'research', 'dossier', 'lint'];
      this.pub({
        type: 'casting',
        casting: {
          chair: modelFor(provider, 'chair'),
          revision: 1,
          strategy: `${PROVIDER_LABEL[provider]} session (mock). Seats are cast by the product, not chosen per debate.`,
          entries: seats.map((role) => ({ role, model: modelFor(provider, role), why: `Runs on the ${SEAT_TIER[role]} tier.` })),
        },
      });

      // Meeting
      this.setStatus('meeting');
      initTranscriptFile(this.row, Events.since(this.id, 0), CFG.founderName);
      let round = 0;
      for (const [line, [speaker, kind, text]] of SCRIPT.entries()) {
        if (this.endedFlag || this.killed) break;
        while (this.pausedFlag) await this.wait();
        if (kind === 'closing') break;

        // Every third turn, the chair stops to choose the next voices — the
        // real engine's longest and most common silence.
        if (round > 0 && round % 3 === 0) {
          await this.think(
            'marcus',
            'Marcus is deciding who speaks next',
            `Round ${round}. Weighing what is still unresolved and who can move it.`,
            'Ravi has the retention argument but he has had the floor twice and is starting to repeat himself. Mei contradicted his churn figure directly and has not been made to defend it, so I want them adjacent rather than separated by a third voice. Sana has been quiet for two rounds and her stability caveat is the only thing that would break either of them. Put Mei up first to force the collision, Ravi to answer it, Sana to referee the evidence.'
          );
          this.pub({
            type: 'floor_set',
            motionId: 'm1',
            round,
            why: 'Mei contradicted Ravi\'s churn figure and has not been made to defend it, so I am putting them adjacent rather than separated. Sana has been quiet two rounds and her caveat is the only thing that breaks either of them.',
            slate: [
              { speaker: 'mei', direction: 'Defend the churn figure you attacked, with the source.' },
              { speaker: 'ravi', direction: 'Answer Mei directly. Do not restate the retention case.' },
              { speaker: 'sana', direction: 'Referee the evidence: whose number survives?' },
            ],
          });
        }

        // The research desk lands as a moment (one spoken line with its sources), on every door.
        if (kind === 'research') await this.research('Supplement organizer retention: category leader versus industry average.', true);
        else await this.stream(speaker, kind, text, SCRIPT_EXTRAS[line]);
        await sleep(400);

        // The referee judging the round: shorter, but it happens every round.
        if (round > 0 && round % 4 === 2) {
          await this.think(
            'referee',
            'The referee is judging the round',
            'Deciding what was genuinely new, and whether the argument climbed past mechanism.',
            'Two claims are new this round. The landed-cost figure is now sourced rather than asserted, which is a climb from mechanism to evidence. The churn number is still contested and neither side has produced a falsifier for it, so that stays open and becomes the pressure for the next round.',
            4500
          );
        }

        if (++round === 4) {
          this.pub({ type: 'bids', round, bids: [
            { speaker: 'ravi', urgency: 8, hook: 'Retention math changes everything here' },
            { speaker: 'mei', urgency: 9, hook: 'Tooling cost objection, right now' },
            { speaker: 'sana', urgency: 3, hook: 'Stability caveat when relevant' },
          ], winner: this.row.config.mode === 'freeforall' ? 'mei' : undefined });
        }
        if (round === 7) {
          const uq = rid('uq');
          this.pub({ type: 'question', questionId: uq, question: 'The panel is split: premium object ($45+) or at-cost box with refill margin?', context: 'Mei and Ravi want the box at cost. Leo argues premium pricing funds the design that earns the counter.', options: [
            { label: 'At-cost box', description: 'Margin lives in refills, box is churn insurance.' },
            { label: 'Premium object', description: 'The box itself carries margin and brand.' },
            { label: 'Test both', description: 'Split the pilot cohort.' },
          ], allowCustom: true });
          appendTranscriptFile(this.id, '**Marcus asks the founder:** The panel is split: premium object ($45+) or at-cost box with refill margin?');
          this.meta().pendingQuestionId = uq;
          this.saveMeta();
          if (this.row.config.autonomy === 'autonomous') {
            await sleep(1500);
            this.meta().pendingQuestionId = null;
            this.saveMeta();
            this.pub({ type: 'assumption', text: 'Went with the at-cost box: the retention data made refill margin the safer default.' });
            appendTranscriptFile(this.id, '**Marcus, deciding for the founder:** Went with the at-cost box: the retention data made refill margin the safer default.');
          } else {
            await this.wait();
          }
        }
        if (round === 10) {
          const p2: Plan = { ...this.row.plan!, revision: 2, rationale: 'Sachet pivot discovered mid-debate.', items: this.row.plan!.items.map((i) => i.id === 'a2' ? { ...i, status: 'done' as const } : i.id === 'a3' ? { ...i, status: 'active' as const } : i).concat([{ id: 'a6', title: 'Sachet standardization', detail: 'One sachet envelope across catalog.', status: 'added' as const }]) };
          Debates.patch(this.id, { plan: p2 });
          this.row.plan = p2;
          this.pub({ type: 'plan', plan: p2 });
        }
        /**
         * The quant desk, scripted. The real desk costs money and an hour to
         * reach; this exists so the highest-value surface in the app (a
         * computed figure, and the audit that checks the panel's arithmetic)
         * can be looked at, restyled and regression-tested for free.
         */
        if (round === 8) {
          const qid = rid('q');
          this.pub({ type: 'compute_started', taskId: qid, question: 'What is landed cost per unit for the tray concept, and does it reconcile with the 40 percent margin floor at the prices on the table?' });
          const st = Hub.stage(this.id, 'quant', 'The quant desk is computing', 'Landed cost per unit for the tray concept, against the agreed margin floor.');
          await sleep(3200);
          st.close();
          this.pub({
            type: 'compute_done', taskId: qid,
            question: 'What is landed cost per unit for the tray concept, and does it reconcile with the 40 percent margin floor at the prices on the table?',
            answer: 'Landed cost is $19.40 per unit, so the 40 percent margin floor the cofounder agreed puts the minimum viable price at $32.33, not the $29 the room has been arguing over. The at-cost box only clears the floor if refill attach exceeds 1.8 per customer per year, and the pack has no retention data to check that against.',
            computable: true,
            figures: [
              { label: 'Landed cost, tray concept', value: '$19.40 / unit', source: 'costing.xlsx, "tray" row, landed column' },
              { label: 'Minimum price at a 40% floor', value: '$32.33', source: 'computed: 19.40 / (1 - 0.40)' },
              { label: 'Gap to the price on the table', value: '$3.33 short', source: 'computed: 32.33 - 29.00' },
            ],
            method: 'Read costing.xlsx, took the tray row landed column ($19.40). floor_price = landed / (1 - margin) with margin = 0.40 from the brief. Compared against the $29 figure used in rounds 4 through 7.',
            reconciles: false,
            caveats: ['No retention or attach-rate file in the pack, so the refill-margin case cannot be checked, only stated as a condition.'],
          });
        }
        if (round === 12) this.pub({ type: 'convergence', verdict: 'continue', note: 'Architecture settled, economics converging, pilot design open.' });
        // ---- Phase 2b surfaces, scripted ----
        if (round === 5) await this.overlapScene();
        if (round === 6) this.pub({ type: 'aside', id: rid('as'), from: 'ravi', to: 'mei', text: 'If attach comes in under seventy, Leo folds. Watch for it.' });
        if (round === 11) {
          this.pub({ type: 'pause', ms: 2500, reason: 'after_concession' });
          this.pub({
            type: 'concession',
            concession: {
              motionId: 'a3', expert: 'mei',
              from: { stance: -2, confidence: 'high' }, to: { stance: 1, confidence: 'medium' },
              kind: 'conditional', movedBy: { kind: 'evidence', ref: 'research: category leader retention', who: 'research' },
              cost: 'the tooling red line', messageId: '',
            },
          });
        }
      }

      // Wrapup
      this.meter(false, true);   // the per-motion budget checkpoint
      this.pub({ type: 'convergence', verdict: 'converged', note: 'Key questions answered; dissents crystallized.' });
      this.setStatus('wrapup');
      for (const [speaker, kind, text] of SCRIPT) {
        if (kind !== 'closing' || this.killed) continue;
        await this.stream(speaker, kind, text);
      }

      // Report
      this.setStatus('reporting');
      this.pub({
        type: 'audit', checked: 3,
        summary: 'Two of the three figures the panel committed to hold. The $29 price point does not: at the agreed margin floor it is $3.33 short, which the room never reconciled before ruling on it.',
        findings: [
          { figure: 'Landed cost of $19.40 per unit', verdict: 'holds', recomputed: '$19.40 from costing.xlsx, tray row', impact: '' },
          { figure: '$29 clears the 40 percent margin floor', verdict: 'wrong', recomputed: 'The floor price is $32.33; $29 gives a 33.1 percent margin', impact: 'The pricing ruling was made against a floor the price does not meet.' },
          { figure: 'Refill attach rate makes the at-cost box work', verdict: 'uncheckable', recomputed: 'No retention or attach data in the pack', impact: '' },
        ],
      });
      await sleep(2500);
      const dir = debateDir(this.id);
      fs.writeFileSync(path.join(dir, 'report.html'), `<!doctype html><html><head><meta charset="utf-8"><title>Mock Report</title><style>body{background:#060a12;color:#dbe7f3;font:16px/1.6 system-ui;max-width:800px;margin:40px auto;padding:0 20px}h1{color:#22d3ee}</style></head><body><h1>THE SUPPLEMENT BOX WAR</h1><p>Mock report placeholder. The real engine renders the full interactive report here.</p></body></html>`);
      this.pub({ type: 'report_ready', path: `/api/debates/${this.id}/report` });
      this.setStatus('complete');
    } catch (err) {
      if (String(err).includes('cancelled')) {
        this.setStatus('cancelled');
      } else {
        this.pub({ type: 'error', message: String(err) });
        this.setStatus('error');
      }
    }
  }
}

const runs = new Map<string, MockRun>();

export const MockEngine = {
  create(topic: string, config: DebateConfig, files?: { filename: string; buffer: Buffer }[]): string {
    const id = rid('d');
    const row = Debates.create(id, topic, config);
    if (files?.length) {
      row.meta.contextFiles = files.length;
      Debates.patch(id, { meta: row.meta });
    }
    const run = new MockRun(id);
    runs.set(id, run);
    void run.run();
    return id;
  },
  get(id: string) {
    return runs.get(id) ?? (Debates.get(id) ? (runs.set(id, new MockRun(id)), runs.get(id)!) : null);
  },
  resumeAll() {},
  remove(id: string) {
    runs.get(id)?.kill();
    runs.delete(id);
    Debates.remove(id);
    fs.rmSync(debateDir(id), { recursive: true, force: true });
  },
};
