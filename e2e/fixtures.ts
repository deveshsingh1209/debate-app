/**
 * The test fixture every spec uses. It does two things on every page:
 *
 *  1. Blocks the whole internet. Any request to a host other than 127.0.0.1
 *     (a font CDN, an analytics beacon, a model API) is aborted and fails the
 *     test, whether it came from the app, the report frame or a redirect.
 *     WebSockets are refused the same way.
 *  2. Fails the test on an uncaught error in the page.
 *
 * It also installs probes the sound and notification tests read: how many
 * AudioContexts exist and how many oscillators started, and how often the
 * notification permission was asked for, with a stand-in Notification so the
 * prompt can be counted in a headless browser.
 */
import { test as base, expect, type Page } from '@playwright/test';

export interface Probes {
  audioContexts: number;
  oscillators: number;
  masterGain: number | null;
  permissionAsks: number;
}

export const test = base.extend<{ guard: void; offsite: string[]; pageErrors: string[] }>({
  offsite: async ({}, use) => use([]),
  pageErrors: async ({}, use) => use([]),
  guard: [
    async ({ context, offsite, pageErrors }, use) => {
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.hostname === '127.0.0.1' && (url.protocol === 'http:' || url.protocol === 'ws:')) return route.continue();
        offsite.push(route.request().url());
        return route.abort('blockedbyclient');
      });
      await context.routeWebSocket(/.*/, (ws) => {
        const url = new URL(ws.url());
        if (url.hostname === '127.0.0.1') return ws.connectToServer();
        offsite.push(ws.url());
        return ws.close();
      });
      context.on('page', (p) => p.on('pageerror', (e) => pageErrors.push(`${p.url()}: ${e.message}`)));
      await context.addInitScript(() => {
        const w = window as unknown as { __probe: Record<string, number | null> } & Window & typeof globalThis;
        w.__probe = { audioContexts: 0, oscillators: 0, masterGain: null, permissionAsks: 0 };
        const AC = w.AudioContext;
        if (AC) {
          w.AudioContext = class extends AC {
            constructor(...a: ConstructorParameters<typeof AudioContext>) {
              super(...a);
              w.__probe.audioContexts = (w.__probe.audioContexts as number) + 1;
              const gain = this.createGain.bind(this);
              let first = true;
              this.createGain = () => {
                const g = gain();
                if (first) {
                  first = false;
                  // The first gain node is the master: read its level once it is set.
                  queueMicrotask(() => { w.__probe.masterGain = g.gain.value; });
                }
                return g;
              };
              const osc = this.createOscillator.bind(this);
              this.createOscillator = () => {
                const o = osc();
                const start = o.start.bind(o);
                o.start = (...s: Parameters<OscillatorNode['start']>) => {
                  w.__probe.oscillators = (w.__probe.oscillators as number) + 1;
                  start(...s);
                };
                return o;
              };
            }
          } as typeof AudioContext;
        }
        // A stand-in for the browser's Notification: headless Chromium denies by default.
        let permission: NotificationPermission = 'default';
        class FakeNotification {
          static get permission() { return permission; }
          static requestPermission() {
            w.__probe.permissionAsks = (w.__probe.permissionAsks as number) + 1;
            permission = 'granted';
            return Promise.resolve(permission);
          }
          onclick: (() => void) | null = null;
          close() {}
        }
        Object.defineProperty(w, 'Notification', { value: FakeNotification, configurable: true, writable: true });
      });
      await use();
      expect(offsite, 'requests that tried to leave 127.0.0.1').toEqual([]);
      expect(pageErrors, 'uncaught errors in the page').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export async function probes(page: Page): Promise<Probes> {
  return page.evaluate(() => (window as unknown as { __probe: Probes }).__probe);
}
