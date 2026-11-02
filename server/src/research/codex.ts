/**
 * Research on the ChatGPT (Codex) door (docs/PHASE2-PLAN.md 3.2).
 *
 * A dedicated thread with Codex's own web search switched to live (every
 * other turn on this door keeps it disabled) and a strict output schema. The
 * Codex SDK's web_search item carries the query and no result URLs, so no
 * tool attests any source: every citation from this door is
 * `model_reported`, kept (dropping them would leave the door with no research
 * at all) and labelled everywhere it is shown as "reported by the model, not
 * attested by the tool". The owner's decision: shown honestly, never faked.
 *
 * Codex turns are serialised per credential, so while this runs the floor
 * waits; the runner gives it a shorter budget and fewer requests for that.
 */
import { runJsonAgent } from '../agents/sdk.ts';
import { researchPrompt, researchSystem } from '../agents/prompts.ts';
import { modelFor } from '../../../shared/models.ts';
import { finalise, parseModelResearch } from './normalise.ts';
import { RESEARCH_LIMITS, ResearchMeter } from './meter.ts';
import type { Draft, ResearchProvider } from './types.ts';

const FIGURE = {
  anyOf: [
    { type: 'null' },
    { type: 'object', additionalProperties: false, required: ['value', 'unit', 'as_of'], properties: { value: { type: 'string' }, unit: { type: 'string' }, as_of: { type: 'string' } } },
  ],
};

export const CODEX_RESEARCH_SCHEMA = {
  name: 'research',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'spoken', 'findings', 'sources'],
    properties: {
      summary: { type: 'string' },
      spoken: { type: 'string' },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['claim', 'figure', 'sources', 'confidence'],
          properties: {
            claim: { type: 'string' },
            figure: FIGURE,
            sources: { type: 'array', items: { type: 'integer' } },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
        },
      },
      sources: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['n', 'url', 'title', 'publisher', 'published'],
          properties: { n: { type: 'integer' }, url: { type: 'string' }, title: { type: 'string' }, publisher: { type: 'string' }, published: { type: 'string' } },
        },
      },
    },
  },
};

export const CodexResearch: ResearchProvider = {
  id: 'codex',
  available: () => true,
  async run(req, ctx) {
    const startedAt = Date.now();
    const model = modelFor('codex', 'research');
    /**
     * The same flaw, checked here: Codex exposes no per-search hook and no
     * tool-call cap, so the allowance is stated in the prompt and the meter
     * records what the thread actually did. The prompt was already lean (the
     * question and the goal). Spend is the user's plan allowance, not dollars.
     */
    const maxSearches = Math.min(req.budget.maxSearches, RESEARCH_LIMITS.searches);
    const meter = new ResearchMeter(req, 'codex');
    ctx.onProgress?.('searching');
    const out = await runJsonAgent<any>({
      model,
      system: researchSystem(),
      prompt: researchPrompt(req.question, ctx.goal, { maxSources: req.maxSources, recencyDays: req.recencyDays, maxSearches }),
      web: true,
      schema: CODEX_RESEARCH_SCHEMA,
      thinking: 4_000,
      timeoutMs: req.budget.timeoutMs + 60_000,
      debateId: req.debateId,
      label: 'research',
      job: 'research',
      signal: ctx.signal,
    });
    meter.step('search', model, out.usage, 0);
    meter.searches = out.toolCalls.filter((t) => t.name === 'web_search').length;
    meter.finish();
    if (meter.searches > maxSearches) console.warn(`[research] ${req.id} codex searched ${meter.searches} times against an allowance of ${maxSearches}`);
    const parsed = parseModelResearch(out.value);
    const draft: Draft = {
      summary: parsed.summary,
      spoken: parsed.spoken,
      findings: parsed.findings,
      sources: parsed.sources.map((s) => ({ ...s, provenance: 'model_reported' as const })),
      searches: out.toolCalls.filter((t) => t.name === 'web_search').length,
      costUsd: 0,
      model,
      provider: 'codex',
    };
    return finalise(req, draft, { startedAt });
  },
};
