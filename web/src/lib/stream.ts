/**
 * Debate live-state: bootstrap via GET /api/debates/:id, then fold the
 * SSE WireFrame stream into DebateState with a pure reducer.
 * Reconnect = exponential backoff + re-bootstrap with ?since=lastSeq.
 * A page refresh mid-debate fully reconstructs from the event log.
 *
 * The reducer itself lives in debate-state.ts, free of React and the network,
 * so it can be tested on its own.
 */
import { useEffect, useMemo, useReducer, useRef } from 'react';
import { api } from './api';
import { initialState, reducer, type DebateState } from './debate-state';
import type { BudgetProfile } from '../../../shared/types';

export * from './debate-state';

export interface DebateActions {
  answer(questionId: string, answer: string): Promise<void>;
  approve(stage: 'goal' | 'panel' | 'plan', action: 'approve' | 'revise', feedback?: string): Promise<void>;
  end(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  setProfile(profile: BudgetProfile): Promise<void>;
}

export function useDebate(id: string): { state: DebateState; actions: DebateActions } {
  const [state, dispatch] = useReducer(reducer, initialState);
  const lastSeqRef = useRef(0);

  useEffect(() => {
    lastSeqRef.current = 0;
    let closed = false;
    let closeStream: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let retry = 0;

    async function connect() {
      if (closed) return;
      dispatch({ type: 'conn', v: retry === 0 ? 'connecting' : 'reconnecting' });
      /**
       * Nothing to hand back any more. A server restart used to park an
       * own-token debate until the browser re-supplied the credential it was
       * holding; the sealed server copy is now reopened by the session itself,
       * so a reconnect is just a reconnect.
       */
      try {
        const since = lastSeqRef.current;
        const detail = await api.getDebate(id, since || undefined);
        if (closed) return;
        dispatch({ type: since ? 'merge' : 'bootstrap', detail });
        const maxSeq = detail.events.reduce((m, e) => Math.max(m, e.seq), since);
        lastSeqRef.current = maxSeq;
        closeStream = api.openStream(
          id,
          maxSeq,
          (frame) => {
            if ('seq' in frame) lastSeqRef.current = Math.max(lastSeqRef.current, frame.seq);
            dispatch({ type: 'frame', frame });
          },
          () => {
            closeStream?.();
            closeStream = null;
            if (closed) return;
            retry++;
            timer = setTimeout(connect, Math.min(15000, 1000 * 2 ** Math.min(retry, 4)));
          },
        );
        retry = 0;
        dispatch({ type: 'conn', v: 'live' });
      } catch (e) {
        if (closed) return;
        const status = e instanceof Error && 'status' in e ? (e as { status: number }).status : 0;

        /**
         * The boot splash has no controls, so anything that stops `loaded` from
         * flipping traps the user with a blinking line and no way out. Only 404
         * used to break the loop, which meant a 401 or 403 retried forever
         * against a deterministic refusal.
         *
         * A 4xx is a verdict, not a blip: surface it immediately. A 5xx or a
         * network drop is worth retrying, but not silently forever.
         */
        if (status === 404) {
          dispatch({ type: 'fatal', message: 'Debate not found.' });
          return;
        }
        if (status === 403) {
          dispatch({ type: 'fatal', message: 'This debate belongs to another account.' });
          return;
        }
        if (status >= 400 && status < 500) {
          dispatch({ type: 'fatal', message: e instanceof Error ? e.message : 'The engine refused that request.' });
          return;
        }

        retry++;
        if (retry >= 4) {
          dispatch({
            type: 'fatal',
            message: 'Could not reach the debate engine. Your session is safe on the server — try again in a moment.',
          });
          return;
        }
        timer = setTimeout(connect, Math.min(15000, 1000 * 2 ** Math.min(retry, 4)));
      }
    }

    void connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      closeStream?.();
    };
  }, [id]);

  const actions = useMemo<DebateActions>(
    () => ({
      answer: (questionId, answer) => api.answer(id, questionId, answer),
      approve: (stage, action, feedback) => api.approve(id, stage, action, feedback),
      end: () => api.end(id),
      pause: () => api.pause(id),
      resume: () => api.resume(id),
      setProfile: (profile) => api.setProfile(id, profile),
    }),
    [id],
  );

  return { state, actions };
}
