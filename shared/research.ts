/**
 * The provider-neutral research result (docs/PHASE2-PLAN.md, section 3).
 * One citation schema for every door; the adapters arrive in 2b-4.
 */
import type { Provider } from './models.ts';

export interface Citation {
  /** 'c_' + short hash of the normalised URL; stable across the session. */
  id: string;
  url: string;
  title: string;
  publisher?: string;
  publishedAt?: string;
  retrievedAt: number;
  /** At most 300 chars, verbatim, and only when the provider exposes source text. */
  quote?: string;
  provenance: 'fetched' | 'search_result' | 'model_reported';
  provider: Provider;
}

export interface Finding {
  claim: string;
  figure?: { value: string; unit?: string; asOf?: string };
  /** At least one, or the finding is dropped. */
  citationIds: string[];
  confidence: 'high' | 'medium' | 'low';
}

export interface ResearchResult {
  requestId: string;
  status: 'ok' | 'partial' | 'failed' | 'unavailable';
  /** At most 220 words, with citation markers like [c_ab12]. */
  summary: string;
  /** At most 60 words: what the desk says aloud in the room. */
  spoken: string;
  findings: Finding[];
  citations: Citation[];
  searches: number;
  durationMs: number;
  costUsd: number;
  provider: Provider;
  model: string;
}
