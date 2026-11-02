import type {
  BudgetProfile,
  DebateConfig,
  DebateDetail,
  DebateSummary,
  DoorsInfo,
  WireFrame,
  SessionInfo,
} from '../../../shared/types';

export const IS_MOCK = import.meta.env.VITE_MOCK === '1';

export class ApiError extends Error {
  status: number;
  retryAfter?: number;
  constructor(status: number, message: string, extra?: { retryAfter?: number }) {
    super(message);
    this.status = status;
    this.retryAfter = extra?.retryAfter;
  }
}

export interface ReportSource {
  /** URL to load in an iframe (real server). */
  src?: string;
  /** Inline HTML (mock mode). */
  srcdoc?: string;
  /** URL for the download anchor; undefined in mock (blob is built on demand). */
  downloadUrl?: string;
}

export interface Api {
  /** Session, CSRF token, and which provider doors this machine can run. */
  me(): Promise<SessionInfo>;
  /** Readiness of the four doors, with the exact fix for each. `fresh` re-checks now instead of using the ~30 s cache. */
  doors(fresh?: boolean): Promise<DoorsInfo>;
  /** Only needed when the server has ACCESS_PASSWORD set. */
  login(password: string): Promise<void>;
  logout(): Promise<void>;
  listDebates(): Promise<DebateSummary[]>;
  /** With files: multipart/form-data (topic + config JSON string + files). Without: plain JSON POST. */
  createDebate(topic: string, config: DebateConfig, files?: File[]): Promise<{ id: string }>;
  getDebate(id: string, since?: number): Promise<DebateDetail>;
  answer(id: string, questionId: string, answer: string): Promise<void>;
  approve(id: string, stage: 'goal' | 'panel' | 'plan', action: 'approve' | 'revise', feedback?: string): Promise<void>;
  end(id: string): Promise<void>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  /** Override the room's depth before the panel is designed. */
  setProfile(id: string, profile: BudgetProfile): Promise<void>;
  deleteDebate(id: string): Promise<void>;
  report(id: string): ReportSource;
  /**
   * Open the live frame stream. Returns a close function.
   * onDown fires once when the stream drops (caller reconnects + re-bootstraps).
   */
  openStream(id: string, since: number, onFrame: (f: WireFrame) => void, onDown: () => void): () => void;
}

/* ---------------- real implementation ---------------- */

/**
 * The CSRF token from GET /api/me, sent as `x-csrf-token` on every request
 * that changes something. Fetched lazily, and refreshed after sign-in because
 * the server binds it to the session.
 */
let csrf: string | null = null;

async function fetchMe(): Promise<SessionInfo> {
  const res = await fetch('/api/me', { credentials: 'same-origin' });
  if (!res.ok) throw new ApiError(res.status, `Request failed (${res.status})`);
  const me = (await res.json()) as SessionInfo;
  csrf = me.csrfToken;
  return me;
}

async function csrfHeader(): Promise<Record<string, string>> {
  if (!csrf) await fetchMe();
  return csrf ? { 'x-csrf-token': csrf } : {};
}

async function fail(res: Response): Promise<never> {
  let body: Record<string, unknown> = {};
  try {
    body = await res.json();
  } catch {
    /* non-JSON error body */
  }
  const msg =
    (typeof body.error === 'string' && body.error) ||
    (typeof body.message === 'string' && body.message) ||
    `Request failed (${res.status})`;
  throw new ApiError(res.status, msg, { retryAfter: typeof body.retryAfter === 'number' ? body.retryAfter : undefined });
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const mutating = method !== 'GET' && method !== 'HEAD';
  const send = async () =>
    fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: {
        ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...(mutating ? await csrfHeader() : {}),
      },
    });
  let res = await send();
  // A stale token (server restarted, or signed in since) gets one refresh.
  if (res.status === 403 && mutating) {
    csrf = null;
    res = await send();
  }
  if (!res.ok) return fail(res);
  return res.json() as Promise<T>;
}

const realApi: Api = {
  me: fetchMe,
  doors: (fresh) => req(`/api/doors${fresh ? '?fresh=1' : ''}`),
  async login(password) {
    await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) });
    csrf = null;
  },
  async logout() {
    await req('/api/auth/logout', { method: 'POST', body: '{}' });
    csrf = null;
  },
  listDebates: () => req('/api/debates'),
  async deleteDebate(id) {
    await req(`/api/debates/${id}`, { method: 'DELETE' });
  },
  createDebate: (topic, config, files) => {
    if (files && files.length > 0) {
      const fd = new FormData();
      fd.append('topic', topic);
      fd.append('config', JSON.stringify(config));
      for (const f of files) fd.append('files', f, f.name);
      // No Content-Type header: the browser sets the multipart boundary.
      return req('/api/debates', { method: 'POST', body: fd });
    }
    return req('/api/debates', { method: 'POST', body: JSON.stringify({ topic, config }) });
  },
  getDebate: (id, since) => req(`/api/debates/${id}${since ? `?since=${since}` : ''}`),
  async answer(id, questionId, answer) {
    await req(`/api/debates/${id}/answer`, { method: 'POST', body: JSON.stringify({ questionId, answer }) });
  },
  async approve(id, stage, action, feedback) {
    await req(`/api/debates/${id}/approve`, { method: 'POST', body: JSON.stringify({ stage, action, feedback }) });
  },
  async end(id) {
    await req(`/api/debates/${id}/end`, { method: 'POST', body: '{}' });
  },
  async pause(id) {
    await req(`/api/debates/${id}/pause`, { method: 'POST', body: '{}' });
  },
  async resume(id) {
    await req(`/api/debates/${id}/resume`, { method: 'POST', body: '{}' });
  },
  async setProfile(id, profile) {
    await req(`/api/debates/${id}/profile`, { method: 'POST', body: JSON.stringify({ profile }) });
  },
  report(id) {
    const url = `/api/debates/${id}/report`;
    return { src: url, downloadUrl: url };
  },
  openStream(id, since, onFrame, onDown) {
    const es = new EventSource(`/api/debates/${id}/stream?since=${since}`);
    let downFired = false;
    es.onmessage = (ev) => {
      try {
        onFrame(JSON.parse(ev.data) as WireFrame);
      } catch {
        /* malformed frame, skip */
      }
    };
    es.onerror = () => {
      // Take over reconnection ourselves so we can re-bootstrap with ?since.
      es.close();
      if (!downFired) {
        downFired = true;
        onDown();
      }
    };
    return () => es.close();
  },
};

/* ---------------- export (mock swap) ---------------- */

import { mockApi } from '../dev/mock';

export const api: Api = IS_MOCK ? mockApi : realApi;
