/**
 * The fake research provider (docs/PHASE2-PLAN.md 3.2): deterministic results
 * from fixtures, for MOCK=1, the contract suite and the eval harness. It goes
 * through the same normaliser as the real doors, so what the mock shows is
 * what a real result looks like.
 */
import type { Provider } from '../../../shared/models.ts';
import { finalise } from './normalise.ts';
import { fakeGoldenDraft, GOLDEN_QUESTION } from './fixtures.ts';
import type { Draft, ResearchProvider } from './types.ts';

/** A fixture-shaped answer for any question, on example domains. */
function genericDraft(question: string): Omit<Draft, 'provider' | 'model' | 'costUsd'> {
  const slug = question.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'question';
  return {
    summary: `The desk found one survey on this [1] and a news report on what changed recently [2]. Both are fixtures: the mock engine makes no web calls.`,
    spoken: `Two sources on this: a survey [1] and a recent news report [2].`,
    findings: [
      { claim: `A survey addresses: ${question.slice(0, 160)}`, sources: [1], confidence: 'medium' },
      { claim: 'A news report covers the most recent change', sources: [2], confidence: 'low' },
    ],
    sources: [
      { n: 1, url: `https://www.example.org/survey/${slug}`, title: 'Fixture survey', publisher: 'Example Trade Body', provenance: 'search_result' },
      { n: 2, url: `https://example.com/news/${slug}`, title: 'Fixture news report', publisher: 'Example News', provenance: 'search_result' },
    ],
    searches: 1,
  };
}

export function fakeResearch(door: Provider, delayMs = 0): ResearchProvider {
  return {
    id: 'fake',
    available: () => true,
    async run(req, ctx) {
      const startedAt = Date.now();
      if (delayMs) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, delayMs);
          ctx.signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
        });
      }
      const base = req.question === GOLDEN_QUESTION ? fakeGoldenDraft() : genericDraft(req.question);
      // On the Codex door nothing attests a source; the fake behaves the same way.
      const sources = door === 'codex' ? base.sources.map((s) => ({ ...s, provenance: 'model_reported' as const })) : base.sources;
      return finalise(req, { ...base, sources, provider: door, model: 'fake', costUsd: 0 }, { startedAt });
    },
  };
}
