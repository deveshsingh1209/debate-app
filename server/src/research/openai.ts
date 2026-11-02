/**
 * Research on the OpenAI API door (docs/PHASE2-PLAN.md 3.2).
 *
 * Step one: a Responses request on the balanced tier with the `web_search`
 * tool, asking for a prose brief. Its `url_citation` annotations are the
 * citations (provenance `search_result`: the tool attached them, the model
 * did not type them), and `include` asks for each search's own source list.
 * Step two: a tool-free call on the fast tier turns the brief into the
 * findings shape, referencing those citations by number; it cannot add a
 * source, because the numbered list is ours.
 *
 * Two steps because it could not be verified offline whether structured
 * output and search annotations combine cleanly in one response; the first
 * owner-approved probe (R2) settles it and may collapse this to one call.
 */
import { runAgent, runJsonAgent } from '../agents/sdk.ts';
import { researchBriefSystem, researchPrompt, researchStructurePrompt, researchStructureSystem } from '../agents/prompts.ts';
import { modelFor } from '../../../shared/models.ts';
import { finalise, normaliseUrl, parseModelResearch } from './normalise.ts';
import { RESEARCH_LIMITS, ResearchMeter } from './meter.ts';
import type { Draft, ResearchCtx, ResearchProvider, ResearchRequest } from './types.ts';

/** Strict JSON schema for step two (Responses structured outputs: every key required, no extras). */
const STRUCTURE_SCHEMA = {
  name: 'research_findings',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'spoken', 'findings'],
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
            figure: {
              anyOf: [
                { type: 'null' },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['value', 'unit', 'as_of'],
                  properties: { value: { type: 'string' }, unit: { type: 'string' }, as_of: { type: 'string' } },
                },
              ],
            },
            sources: { type: 'array', items: { type: 'integer' } },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
        },
      },
    },
  },
};

export interface BriefCitations {
  /** The brief with each annotated span replaced by its source number, "[n]". */
  brief: string;
  sources: { n: number; url: string; title: string }[];
  searches: number;
}

/**
 * Read the step-one Responses object: number the url_citation annotations by
 * first appearance (one number per page), and put "[n]" where each one was.
 */
export function briefFromResponse(raw: any, fallbackText: string): BriefCitations {
  const output: any[] = Array.isArray(raw?.output) ? raw.output : [];
  const searches = output.filter((o) => o?.type === 'web_search_call').length;
  const numbers = new Map<string, number>();
  const sources: BriefCitations['sources'] = [];
  const parts: string[] = [];
  for (const item of output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const c of item.content) {
      if (c?.type !== 'output_text' || typeof c.text !== 'string') continue;
      const anns = (Array.isArray(c.annotations) ? c.annotations : [])
        .filter((a: any) => a?.type === 'url_citation' && typeof a.url === 'string')
        .sort((a: any, b: any) => (a.start_index ?? 0) - (b.start_index ?? 0));
      // Number in reading order, then splice from the end so indices stay valid.
      const marks = anns.map((a: any) => {
        const key = normaliseUrl(a.url);
        if (!key) return null;
        if (!numbers.has(key)) {
          numbers.set(key, sources.length + 1);
          sources.push({ n: sources.length + 1, url: a.url, title: String(a.title ?? '').trim() });
        }
        return { start: Number(a.start_index ?? 0), end: Number(a.end_index ?? 0), n: numbers.get(key)! };
      }).filter(Boolean) as { start: number; end: number; n: number }[];
      let text: string = c.text;
      for (const m of [...marks].sort((a, b) => b.start - a.start)) {
        if (m.end > m.start && m.end <= text.length) text = `${text.slice(0, m.start)} [${m.n}]${text.slice(m.end)}`;
        else text = `${text.slice(0, m.end)} [${m.n}]${text.slice(m.end)}`;
      }
      parts.push(text);
    }
  }
  return { brief: (parts.join('\n\n') || fallbackText).trim(), sources, searches };
}

export const OpenAIResearch: ResearchProvider = {
  id: 'openai',
  available: () => true,
  async run(req, ctx) {
    const meter = new ResearchMeter(req, 'openai');
    try {
      return await runOpenAI(req, ctx, meter);
    } catch (err) {
      meter.finish();
      throw err;
    }
  },
};

/**
 * The same flaw as the Claude door's, checked here: a web_search response
 * could search as often as the model liked, and every search's retrieved
 * text is billed as input. `max_tool_calls` now caps it at the desk's
 * allowance. Both steps were already lean (the question and the goal; then
 * the brief and our numbered list), so nothing else changes.
 */
async function runOpenAI(req: ResearchRequest, ctx: ResearchCtx, meter: ResearchMeter) {
  const startedAt = Date.now();
  const model = modelFor('openai', 'research');
  const maxSearches = Math.min(req.budget.maxSearches, RESEARCH_LIMITS.searches);
  ctx.onProgress?.('searching');
  const step1 = await runAgent({
    model,
    system: researchBriefSystem(),
    prompt: researchPrompt(req.question, ctx.goal, { maxSources: req.maxSources, recencyDays: req.recencyDays, maxSearches }),
    openaiTools: [{ type: 'web_search' }],
    openaiInclude: ['web_search_call.action.sources'],
    openaiMaxToolCalls: maxSearches,
    thinking: 4_000,
    timeoutMs: req.budget.timeoutMs + 60_000,
    debateId: req.debateId,
    label: 'research',
    job: 'research',
    signal: ctx.signal,
  });
  meter.step('search', model, step1.usage, step1.costUsd ?? 0);
  const { brief, sources, searches } = briefFromResponse(step1.raw, step1.text);
  meter.searches = searches;

  ctx.onProgress?.('structuring');
  const step2 = await runJsonAgent<any>({
    model: modelFor('openai', 'clerk'),
    system: researchStructureSystem(),
    prompt: researchStructurePrompt(req.question, brief, sources),
    schema: STRUCTURE_SCHEMA,
    thinking: 0,
    timeoutMs: 120_000,
    debateId: req.debateId,
    label: 'research:structure',
    signal: ctx.signal,
  });
  meter.step('structure', modelFor('openai', 'clerk'), step2.usage, step2.costUsd ?? 0);
  const parsed = parseModelResearch(step2.value);
  const draft: Draft = {
    summary: parsed.summary || brief,
    spoken: parsed.spoken,
    findings: parsed.findings,
    sources: sources.map((s) => ({ ...s, provenance: 'search_result' as const })),
    searches,
    costUsd: (step1.costUsd ?? 0) + (step2.costUsd ?? 0),
    model,
    provider: 'openai',
  };
  meter.finish();
  return finalise(req, draft, { startedAt });
}
