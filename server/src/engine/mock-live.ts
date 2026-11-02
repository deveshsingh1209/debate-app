/**
 * MOCK=1, the live path (2b-7). The real engine (DebateRun, the floor
 * director, the belief ledger, the linter, the report) runs end to end, and
 * only the models are scripted: every agent call is answered from a mock-v2
 * scenario (mock-scenarios.ts) through the same wireAgents seam the engine
 * test uses. No model call, no network, no quota.
 *
 * What is scripted is the WORDS. Who speaks, in what shape, who cuts in and
 * where, the talking-over, the pauses, the chair's triggers, the concessions
 * and their causes are all decided by the engine itself, exactly as in a real
 * session.
 *
 *   MOCK_SCENARIO=pricing (default) | library
 *   MOCK_SPEED=1 (speaking pace) | 4 | max (no waiting at all)
 *   MOCK_ENGINE=scripted keeps the older fully scripted player (mock.ts).
 *   A topic containing #mock-quota hits a spent allowance once (the quota pause).
 */
import { wireAgents, type AgentTurnOpts, type AgentTurnResult } from '../agents/sdk.ts';
import { wireResearch } from '../research/index.ts';
import type { ResearchProvider } from '../research/types.ts';
import { Debates } from '../db.ts';
import { citationId as mockCitationId, type MockExpert, type Scenario } from './mock-v2.ts';
import { citationId, finalise } from '../research/normalise.ts';
import { SCENARIOS } from './mock-scenarios.ts';
import { providerOfConfig } from '../../../shared/models.ts';
import type { ReportData } from '../../../shared/report-types.ts';

const REGISTERS = ['clipped', 'storyteller', 'combative', 'dry', 'plain', 'technical', 'socratic'] as const;
const TICS = ['look,', 'here is the thing', 'which customer?', 'on the numbers', 'in practice', 'to be concrete'];
const GENERIC_REACTIONS = ['On what base?', 'Which number?', 'No.', 'Says who?', 'That is one account.', 'And the cost?'];

/** Sentences, kept whole: the scenario text is written without abbreviations ending in a period. */
const sentencesOf = (t: string) => t.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/).filter(Boolean);
const usage = { input: 1500, output: 160, cacheWrite: 0, cacheRead: 4000 };

/** One expert's words, from every line the scenario gives them, handed out in order. */
interface Bank {
  setPieces: string[];
  sentences: string[];
  next: number;
  /** Cut-ins this expert makes, with who they were written against. */
  cutIns: { at: string; text: string }[];
  reactions: string[];
  turns: number;
}

function banks(scn: Scenario): Record<string, Bank> {
  const out: Record<string, Bank> = {};
  for (const e of scn.experts) out[e.persona.id] = { setPieces: [], sentences: [], next: 0, cutIns: [], reactions: [], turns: 0 };
  const add = (who: string, text: string, shape: string) => {
    const b = out[who];
    if (!b) return;
    if (shape === 'set_piece') b.setPieces.push(text);
    b.sentences.push(...sentencesOf(text));
  };
  for (const beat of scn.beats) {
    if (beat.t === 'say') add(beat.who, beat.text, beat.shape);
    else if (beat.t === 'cut') {
      add(beat.who, beat.text, beat.shape);
      add(beat.who, beat.resume.text.replace(/^Let me finish\.\s*/, ''), beat.resume.shape);
      add(beat.by, beat.takes.text, beat.takes.shape);
      out[beat.by]?.cutIns.push({ at: beat.who, text: beat.cutIn });
    } else if (beat.t === 'react') out[beat.who]?.reactions.push(beat.text);
  }
  // Their reasons and their closing thought are theirs to say too, so a long checkpoint does not run them dry.
  for (const e of scn.experts) out[e.persona.id].sentences.push(...e.belief.reasons);
  return out;
}

/** A dossier for a scenario expert: distinct registers, lengths, words and habits, so the diversity check passes. */
function dossierFor(scn: Scenario, e: MockExpert, i: number) {
  const p = e.persona;
  const words = [...new Set([...p.expertise.flatMap((x) => x.split(/\s+/)), ...p.role.toLowerCase().split(/[^a-z]+/), p.id, `${p.id}-call`, `${p.id}-line`, `${p.id}-case`]
    .map((w) => w.toLowerCase().replace(/[^a-z-]/g, '')).filter((w) => w.length > 2))].slice(0, 7);
  return {
    publicReputation: `${p.tagline} ${p.bio.split('. ')[0]}.`.slice(0, 280),
    history: [
      { when: 'early career', what: `${p.name} backed a call the numbers did not support`, lesson: 'check the base before the story', kind: 'failure' },
      { when: 'five years ago', what: `${p.name} watched a rollout fail on the customers it ignored`, lesson: 'the angriest customer is a signal', kind: 'failure' },
      { when: 'last year', what: `${p.name} carried a hard decision through a board`, lesson: 'own the number you defend', kind: 'win' },
    ],
    incentives: [`${p.name.split(' ')[0]}'s ${p.expertise[0] ?? 'remit'} is judged on how this lands`, `a reputation for ${p.tagline.toLowerCase().replace(/[.?!]$/, '')}`],
    goalLean: e.belief.stance > 0 ? 1 : e.belief.stance < 0 ? -1 : 0,
    biases: [{ name: p.biases.split(';')[0].slice(0, 60), showsUpAs: p.biases.slice(0, 120) }],
    blindSpots: [`what ${scn.experts[(i + 1) % scn.experts.length].persona.name.split(' ')[0]} sees first`],
    stubbornness: [0.8, 0.72, 0.3, 0.5, 0.6][i % 5],
    temperament: e.temperament,
    speech: { register: REGISTERS[i % REGISTERS.length], typicalWords: [45, 140, 80, 60, 100][i % 5], vocabulary: words.length >= 5 ? words : [...words, 'alpha', 'bravo', 'charlie', 'delta', 'echo'].slice(0, 5), tics: [{ text: TICS[i % TICS.length], maxPerMotion: 1 }], neverSay: [] },
    underPressure: ['go quiet, then come back with a number', 'tell a longer story', 'answer with a question'][i % 3],
    relationships: [],
  };
}

/** The scenario's own report, as the writer would produce it. */
function reportFor(scn: Scenario, founder: string): ReportData {
  const d = scn.decision;
  return {
    title: scn.title,
    subtitle: 'Mock session (scripted models, real engine)',
    generatedAtIso: new Date().toISOString(), topic: scn.topic, goal: scn.goal, model: '', mode: '', autonomy: '',
    panel: [], stats: { messages: 0, interjections: 0, researchTasks: 0, planRevisions: 0, userDecisions: 0, assumptions: 0, durationMin: 0 },
    keyRecommendation: d.decision.replace(/\{founder\}/g, founder),
    executiveSummary: [d.rationale, `Owner: ${d.owner.replace(/\{founder\}/g, founder)}. Evidence: ${d.evidence}.`],
    decisions: [{ topic: d.motionTitle, conclusion: d.decision, proposedBy: scn.experts[0].persona.name, supportedBy: [], challengedBy: [], resolution: d.rationale, dependsOn: d.dependsOn }],
    dissents: d.dissents.map((x) => ({ expert: x.expert, position: x.position, reasoning: x.reasoning })),
    risks: [], charts: [], tables: [], roadmap: [],
    openQuestions: [],
    moderatorNote: 'This is a mock session: every word was scripted, and the engine decided who spoke, when, and who cut in.',
  };
}

/** Pull "by <occasion>" out of a scripted tripwire sentence. */
function byOf(text: string): string {
  return text.match(/\bby ((?:the )?(?:end of )?\d{1,2} [A-Z][a-z]+|\d{1,2} [A-Z][a-z]+|the end of [a-z]+|[A-Z][a-z]+ \d{1,2})/)?.[1] ?? 'the next board meeting';
}

interface DebateScript {
  scn: Scenario;
  banks: Record<string, Bank>;
  intakes: number;
  referee: number;
  checkIns: number;
  chair: number;
  cutBy: Record<string, number>;
  researched: boolean;
  quotaSpent: boolean;
}

/** Put this in a mock debate's topic to have it hit a spent allowance once (the quota pause). */
export const QUOTA_MARK = '#mock-quota';

/**
 * The scripted models, keyed by call label. The same seam and labels as the
 * engine test (runner.selftest.ts).
 */
export function mockAgents(scenarioKey: string, opts: { delayMs?: number } = {}) {
  const scn = SCENARIOS[scenarioKey];
  if (!scn) throw new Error(`MOCK_SCENARIO="${scenarioKey}" is not a scenario. Use one of: ${Object.keys(SCENARIOS).join(', ')}.`);
  const state = new Map<string, DebateScript>();
  const of = (id = '') => {
    let s = state.get(id);
    if (!s) state.set(id, (s = { scn, banks: banks(scn), intakes: 0, referee: 0, checkIns: 0, chair: 0, cutBy: {}, researched: false, quotaSpent: false }));
    return s;
  };
  const nap = () => (opts.delayMs ? new Promise((r) => setTimeout(r, opts.delayMs)) : Promise.resolve());
  const founder = () => process.env.FOUNDER_NAME?.trim() || scn.founder;
  const variance = citationId(scn.sources[1]?.url ?? scn.sources[0].url);
  const researchQ = (scn.beats.find((b) => b.t === 'research') as any)?.question ?? 'What do published benchmarks say about this decision?';

  /** A floor turn: a whole set piece, or one or two sentences of a reply, with the speaker's STANCE line. */
  function floorTurn(s: DebateScript, who: string, prompt: string, system: string): string {
    const b = s.banks[who];
    const e = scn.experts.find((x) => x.persona.id === who);
    if (!b || !e) return 'I will pass for now.\nSTANCE: neutral 0 | confidence: low';
    b.turns++;
    const setPiece = /THIS TURN opens a point/.test(prompt);
    let text: string;
    if (setPiece && b.setPieces.length) {
      text = b.setPieces.shift()!;
      // Its sentences are spoken now; the reply bank skips them.
      const used = new Set(sentencesOf(text));
      b.sentences = b.sentences.filter((x) => !used.has(x));
    } else {
      const n = setPiece ? 3 : /at most 25 words/.test(prompt) ? 1 : 2;
      const pick: string[] = [];
      for (let k = 0; k < n && b.sentences.length; k++) pick.push(b.sentences[b.next++ % b.sentences.length]);
      text = pick.join(' ') || 'I said what I had to say.';
    }
    // Where they stand: the opening belief, until the evidence the scenario says moved them is in the room.
    const heard = system + prompt;
    let stance = `${e.belief.stance > 0 ? `for+${e.belief.stance}` : e.belief.stance < 0 ? `against${e.belief.stance}` : 'neutral 0'} | confidence: ${e.belief.confidence} | crux: ${e.belief.crux.slice(0, 80)}`;
    const conc = scn.beats.find((x) => x.t === 'concede' && x.expert === who) as any;
    if (conc && heard.includes('[c_') && b.turns >= 3) {
      const to = conc.to.stance > 0 ? `for+${conc.to.stance}` : conc.to.stance < 0 ? `against${conc.to.stance}` : 'neutral 0';
      // The scenario names its source by the old player's id; the room heard the real citation id.
      const src = scn.sources.find((x) => mockCitationId(x.url) === conc.movedBy.ref);
      const ref = src ? citationId(src.url) : variance;
      const moved = conc.movedBy.kind === 'evidence' ? ` | moved: evidence ${ref}` : '';
      stance = `${to} | confidence: ${conc.to.confidence} | crux: ${e.belief.crux.slice(0, 80)}${moved} | cost: ${conc.cost} | kind: ${conc.kind}`;
    }
    const claims = (scn.beats.find((x) => x.t === 'say' && x.who === who && (x as any).claims) as any)?.claims ?? [];
    const lines = [`STANCE: ${stance}`];
    if (claims.length && setPiece) lines.push(`CLAIMS: ${claims.map((c: any) => `[${c.grade}] ${c.text}`).join('; ')}`);
    const q = (scn.beats.find((x) => x.t === 'say' && x.who === who && (x as any).question) as any);
    if (q && b.turns === 2) lines.push(`ASK: ${q.to?.[0] ?? scn.experts.find((x) => x.persona.id !== who)!.persona.id} | ${q.question}`);
    // The first expert to make a second point sends the research desk out (once a debate).
    if (!s.researched && b.turns >= 2) {
      s.researched = true;
      lines.push(`RESEARCH: ${researchQ}`);
    }
    return `${text}\n${lines.join('\n')}`;
  }

  function reactions(s: DebateScript, prompt: string) {
    const speaker = scn.experts.find((x) => prompt.startsWith(`${x.persona.name} IS SPEAKING`));
    if (!speaker) return { reactions: [] };
    const sentences = (prompt.match(/^\d+\. /gm) ?? []).length;
    const out: any[] = [];
    // The listener most opposed to the speaker cannot let it stand; the next one grunts.
    const others = scn.experts.filter((x) => x.persona.id !== speaker.persona.id)
      .sort((a, b) => Math.abs(b.belief.stance - speaker.belief.stance) - Math.abs(a.belief.stance - speaker.belief.stance));
    const [hot, cool] = others;
    if (hot) {
      const bank = s.banks[hot.persona.id];
      // A scripted cut-in only against the person it was written for.
      const at = bank.cutIns.findIndex((c) => c.at === speaker.persona.id);
      const cutIn = at >= 0 && sentences >= 3 ? bank.cutIns.splice(at, 1)[0].text : null;
      out.push({ listener: hot.persona.id, intensity: cutIn ? 3 : 2, atSentence: Math.min(Math.max(1, sentences - 2), 3), cutIn, backchannel: cutIn ? null : bank.reactions.shift() ?? GENERIC_REACTIONS[(s.chair + sentences) % GENERIC_REACTIONS.length], wantsFloor: true });
    }
    if (cool) {
      const bank = s.banks[cool.persona.id];
      out.push({ listener: cool.persona.id, intensity: 1 + (sentences % 2), atSentence: 0, cutIn: null, backchannel: bank.reactions.shift() ?? null, wantsFloor: false });
    }
    return { reactions: out };
  }

  function json(opts: AgentTurnOpts): any {
    const label = opts.label ?? '';
    const s = of(opts.debateId);
    const roster = scn.experts.map((e) => e.persona);
    if (label === 'intake' || label === 'intake:auto') {
      s.intakes++;
      if (s.intakes === 1 && label === 'intake' && scn.clarify.length) {
        return { clear: false, questions: scn.clarify, complexity: { decisions: 1, disciplines: scn.experts.length, depth: 'standard', rationale: scn.scopeRationale } };
      }
      const st = scn.stakes;
      return {
        clear: true, title: scn.title, goal: scn.goal,
        complexity: { decisions: 1, disciplines: scn.experts.length, depth: 'standard', rationale: scn.scopeRationale },
        stakes: {
          ...(st.decisionOwner.name === 'FOUNDER' ? {} : { decisionOwner: st.decisionOwner }),
          decideBy: st.decideBy, atRisk: st.atRisk, ifWrong: st.ifWrong, reversibility: st.reversibility,
          from: st.source === 'dossier' ? 'dossier' : 'founder',
        },
      };
    }
    if (label === 'architect' || label === 'architect:reality') return { personas: roster, rationale: scn.panelRationale, research_questions: [] };
    const dm = label.match(/^(\w+):dossier/);
    if (dm) {
      const i = scn.experts.findIndex((e) => e.persona.id === dm[1]);
      if (i < 0) return {};
      const d = dossierFor(scn, scn.experts[i], i);
      // A second draft follows the diversity check's hint, as the persona seat is asked to.
      if (/incentives that gain if the goal goes ahead/.test(opts.prompt)) d.goalLean = 1;
      if (/incentives that lose if the goal goes ahead/.test(opts.prompt)) d.goalLean = -1;
      return d;
    }
    if (label === 'relationships') {
      const ids = roster.map((p) => p.id);
      return { relationships: Object.fromEntries(ids.map((id, i) => [id, [{ with: ids[(i + 1) % ids.length], kind: i % 2 ? 'rival' : 'respect', note: 'they have argued this before' }]])) };
    }
    if (label === 'clerk:stances') return { stances: scn.experts.map((e) => ({ expert: e.persona.id, stance: e.belief.stance, confidence: e.belief.confidence, crux: e.belief.crux.slice(0, 80) })) };
    if (label.endsWith(':position') || label.endsWith(':position:contrarian')) {
      const e = scn.experts.find((x) => label.startsWith(`${x.persona.id}:`))!;
      const rival = scn.experts.find((x) => Math.sign(x.belief.stance) !== Math.sign(e.belief.stance)) ?? scn.experts.find((x) => x !== e)!;
      return { thesis: e.belief.reasons[0] ?? e.belief.crux, load_bearing_claims: e.belief.reasons, red_line: e.belief.crux, falsifier: 'A figure from the founder\'s own data that cuts against my crux.', who_i_expect_to_be_wrong: `${rival.persona.id}, because their crux ignores mine` };
    }
    if (label === 'cards:consensus') return { consensus: false };
    if (label === 'marcus:plan') {
      const say = (scn.beats.find((b) => b.t === 'chair') as any)?.text?.replace(/\{founder\}/g, founder()) ?? 'One motion today.';
      return { say, plan_update: { items: [{ id: scn.motion.id, title: scn.motion.title, motion: scn.motion.motion, detail: scn.plan.items.map((i) => i.title).join('; '), status: 'pending' }], rationale: scn.plan.rationale ?? 'One motion.' } };
    }
    if (label === 'referee') {
      s.referee++;
      const rung = Math.min(4, s.referee);
      return { fresh_arguments: [`checkpoint ${s.referee}: a new point on ${scn.motion.title.toLowerCase()}`], position_changes: [], unresolved: s.referee < 3 ? ['the number nobody has put on the table'] : [], rung, rung_reason: ['', 'mechanisms on the table', 'evidence attached and graded', 'the strongest objection answered', 'each side named what would move it'][rung], missing_expertise: null, ready_to_decide: s.referee >= 3, next_pressure: s.referee < 3 ? 'Put a number on it, or say it is an assumption.' : null, momentum: s.referee >= 3 ? 'exhausted' : 'climbing' };
    }
    if (label === 'marcus:steer') {
      s.checkIns++;
      const dodge = scn.beats.find((b) => b.t === 'say' && (b as any).question) as any;
      const ask = scn.beats.find((b) => b.t === 'ask_founder') as any;
      return {
        say: null,
        why: s.checkIns === 1 ? 'A question is hanging; I am putting it back to the person who owes it.' : 'The room is working; I am asking the founder the one thing only they know.',
        nudge: s.checkIns === 1 && dodge ? { speaker: dodge.to?.[0] ?? roster[0].id, direction: dodge.question } : null,
        research: null, compute: null, plan_update: null, reopen: null,
        ask_user: s.checkIns === 2 && ask ? { question: ask.question, context: ask.context, options: ask.options } : null,
        assumption: s.checkIns === 2 && ask ? ask.assumed : null,
      };
    }
    if (label === 'react') return reactions(s, opts.prompt);
    if (label === 'research:crux') {
      const neg = scn.experts.find((e) => e.belief.stance < 0);
      const pos = scn.experts.find((e) => e.belief.stance > 0);
      return { hits: [...(neg ? [{ expert: neg.persona.id, finding: 2, effect: 'supports' }] : []), ...(pos ? [{ expert: pos.persona.id, finding: 1, effect: 'supports' }] : [])] };
    }
    if (label === 'marcus:ruling') {
      const d = scn.decision;
      return {
        say: 'Here is where I land.',
        decision: {
          ...d, owner: d.owner.replace(/\{founder\}/g, founder()),
          dissents: d.dissents.map((x) => {
            const [trip, cost] = x.reasoning.split(/Cost of ignoring it:\s*/);
            const signal = trip.replace(/^Tripwire:\s*/, '').replace(/,[^,]*$/, '').trim();
            return { expert: x.expert, position: x.position, reasoning: x.reasoning, tripwire: { signal, by: byOf(trip) }, costOfIgnoring: (cost ?? '').trim() };
          }),
        },
      };
    }
    if (label.startsWith('redteam')) return { verdict: 'holds', defeaters: [] };
    if (label === 'report' || label === 'report:revise') return reportFor(scn, founder());
    if (label === 'report:repair') return null;
    if (label === 'audit') return scn.audit ?? { checked: 0, summary: 'Nothing to check.', findings: [] };
    if (label === 'quant') return { computable: false, answer: 'The mock desk computes nothing.', figures: [], method: '', reconciles: null, caveats: [] };
    if (label === 'summon') return {};
    return {};
  }

  function text(opts: AgentTurnOpts): string {
    const label = opts.label ?? '';
    const s = of(opts.debateId);
    const [who, kind] = label.split(':');
    if (label === 'marcus:floor') {
      // The scenario's own chair line for the trigger the engine raised, else the next plain one.
      const chairBeats = scn.beats.filter((b) => b.t === 'chair') as Extract<Scenario['beats'][number], { t: 'chair' }>[];
      const forTrigger = /gave no reason|should not move someone that firm/.test(opts.prompt) ? chairBeats.find((b) => b.expect === 'unexplained')
        : /has been asked/.test(opts.prompt) ? chairBeats.find((b) => b.expect === 'dodge') : undefined;
      const plain = chairBeats.filter((b) => !b.expect);
      const line = forTrigger?.text ?? plain[(1 + s.chair++) % Math.max(1, plain.length)]?.text ?? 'Make your point.';
      return sentencesOf(line.replace(/\{founder\}/g, founder())).slice(0, 2).join(' ');
    }
    if (kind === 'floor') return floorTurn(s, who, opts.prompt, opts.system);
    if (kind === 'closing') return `${scn.closings.find((c) => c.who === who)?.text ?? 'I have said my piece.'}\nSTANCE: neutral 0 | confidence: medium`;
    if (kind === 'lint') return (opts.prompt.split('THE TURN:\n')[1] ?? '').replace(/—/g, ',');
    if (label === 'dossier') return scn.contextBrief;
    return '';
  }

  const fake = {
    async run(opts: AgentTurnOpts): Promise<AgentTurnResult> {
      await nap();
      return { text: text(opts), sessionId: null, costUsd: /:floor$/.test(opts.label ?? '') ? scn.spend.perSpoken / 3 : 0.01, usage, toolCalls: [] } as AgentTurnResult;
    },
    async runJson(opts: AgentTurnOpts) {
      await nap();
      // A topic carrying QUOTA_MARK spends the allowance once, at its first referee call, so the pause can be seen.
      const s = of(opts.debateId);
      if (opts.label === 'referee' && !s.quotaSpent && Debates.get(opts.debateId ?? '')?.topic.includes(QUOTA_MARK)) {
        s.quotaSpent = true;
        throw new Error("You've hit your session limit · resets 11:59pm");
      }
      return { value: json(opts), sessionId: null, usage, costUsd: opts.label === 'react' ? scn.spend.perReaction : 0.04 };
    },
  };

  /**
   * Research through the scenario's own sources, through the real normaliser
   * (so citation ids are the real ones), in the shape of the debate's door:
   * on Codex nothing attests a source.
   */
  const research: ResearchProvider = {
    id: 'fake',
    available: () => true,
    async run(req) {
      const startedAt = Date.now();
      await nap();
      const door = providerOfConfig(Debates.get(req.debateId)?.config);
      const mark = (t: string) => t.replace(/\{(\d)\}/g, (_m, d) => `[${Number(d) + 1}]`);
      return finalise(req, {
        summary: mark(scn.researchSummary),
        spoken: mark(scn.researchSpoken),
        findings: scn.findings.map((f) => ({ claim: f.claim, ...(f.figure ? { figure: f.figure } : {}), sources: [f.source + 1], confidence: f.confidence })),
        sources: scn.sources.map((s, i) => ({ n: i + 1, url: s.url, title: s.title, publisher: s.publisher, publishedAt: s.publishedAt, ...(door === 'codex' ? {} : { quote: s.quote }), provenance: door === 'codex' ? 'model_reported' as const : 'search_result' as const })),
        searches: 3,
        provider: door, model: 'mock', costUsd: 0,
      }, { startedAt });
    },
  };
  return { fake, research };
}

/** Wire the scripted models for MOCK=1 (called once at start-up). */
export function installMockModels(): string {
  const key = (process.env.MOCK_SCENARIO ?? 'pricing').trim();
  const speed = (process.env.MOCK_SPEED ?? '1').trim();
  const delayMs = speed === 'max' ? 0 : Math.round(400 / Math.max(0.1, Number(speed) || 1));
  const { fake, research } = mockAgents(key, { delayMs });
  wireAgents(fake);
  wireResearch(research);
  return key;
}
