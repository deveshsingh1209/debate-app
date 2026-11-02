/**
 * The provider-neutral research interface (docs/PHASE2-PLAN.md 3.1).
 * The result shape every door returns is shared/research.ts; this is the
 * server-side request and the adapter contract.
 */
import type { Citation, Finding, ResearchResult } from '../../../shared/research.ts';
import type { Provider } from '../../../shared/models.ts';

export interface ResearchRequest {
  id: string;
  debateId: string;
  question: string;
  /** Persona id, 'marcus', or 'architect'. */
  askedBy: string;
  motionId?: string;
  /** `landscape`: the architect's survey of the domain before the panel is designed. */
  purpose: 'pre_session' | 'crux' | 'number' | 'fact_check' | 'landscape';
  maxSources: number;
  recencyDays?: number;
  budget: { maxSearches: number; timeoutMs: number };
}

/**
 * Research the debate already holds (the architect's landscape, the
 * pre-session briefs, answers that landed), which a new question may reuse
 * instead of searching the same ground. Passed in by the runner from the
 * persisted meta, so reuse survives a restart.
 */
export interface KnownBrief {
  /** The request id it answered, or a stable label (`architect-scout`). */
  id: string;
  question: string;
  summary: string;
  citations: Citation[];
  status: ResearchResult['status'];
}

export interface ResearchCtx {
  signal: AbortSignal;
  onProgress?: (note: string) => void;
  /** The panel's goal: the only context a research prompt may carry besides the question. */
  goal: string;
}

export interface ResearchProvider {
  id: Provider | 'fake';
  available(debateId: string): boolean;
  run(req: ResearchRequest, ctx: ResearchCtx): Promise<ResearchResult>;
}

/**
 * What an adapter hands the shared normaliser: the model's findings with
 * sources referenced by number, and what the tools attested about each
 * source. Every door produces one of these; finalise() does the rest the same
 * way for all of them, which is what makes golden equivalence possible.
 */
export interface Draft {
  summary: string;
  spoken: string;
  findings: { claim: string; figure?: Finding['figure']; sources: number[]; confidence: Finding['confidence'] }[];
  sources: {
    n: number;
    url: string;
    title: string;
    publisher?: string;
    publishedAt?: string;
    quote?: string;
    provenance: Citation['provenance'];
  }[];
  searches: number;
  costUsd: number;
  model: string;
  provider: Provider;
}
