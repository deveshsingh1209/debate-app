/**
 * The research desk reads pages itself.
 *
 * Until this change the Claude door handed the model the CLI's WebFetch,
 * which reads up to 100,000 characters of a page per call and, for some
 * hosts, puts the page into the model's context whole. Here the desk fetches
 * only pages a search actually returned and the model cited, extracts the
 * readable text, keeps the passages that bear on the question and the
 * findings, and caps what any model sees at RESEARCH_LIMITS.pageChars per
 * page. The same text supplies a verbatim quote for the citation.
 *
 * The fetch rule is enforced here more tightly than the CLI could: every
 * redirect hop is checked with checkFetchUrl, and the address the socket
 * actually connects to is checked again at connect time, so a public name
 * that re-resolves to a private address is refused too.
 *
 * The transport is injectable (wirePages); while scripted agents are wired
 * and no page transport is, nothing is fetched at all.
 */
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import zlib from 'node:zlib';
import type { LookupFunction } from 'node:net';
import { checkFetchUrl, nonPublic } from './fetchguard.ts';
import { RESEARCH_LIMITS } from './meter.ts';

export const PAGE_FETCH = {
  timeoutMs: 12_000,
  /** Raw bytes read from one page, after decompression. Beyond it the rest is not read. */
  maxBytes: 1_500_000,
  maxRedirects: 4,
} as const;

export interface RawPage { url: string; status: number; contentType: string; body: string }
export type PageTransport = (url: string, signal: AbortSignal) => Promise<RawPage | null>;

export interface Page {
  url: string;
  title: string;
  /** The whole extracted text (kept server-side for quotes; never sent to a model whole). */
  text: string;
}

// ---- transport ----

/** dns.lookup that refuses non-public addresses at connect time. */
export const publicOnlyLookup: LookupFunction =(hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return (callback as any)(err);
    const list = addresses as dns.LookupAddress[];
    const bad = list.find((a) => nonPublic(a.address));
    if (bad || !list.length) return (callback as any)(Object.assign(new Error(`${hostname} resolves to a non-public address`), { code: 'EREFUSED' }));
    if ((options as any)?.all) return (callback as any)(null, list);
    return (callback as any)(null, list[0].address, list[0].family);
  });
};

function getOnce(url: URL, signal: AbortSignal): Promise<{ status: number; location?: string; contentType: string; body: string }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: 'GET',
      lookup: publicOnlyLookup,
      signal,
      timeout: PAGE_FETCH.timeoutMs,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; debate-research-desk/1.0)',
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
        'accept-encoding': 'gzip, deflate, br',
      },
    }, (res) => {
      const status = res.statusCode ?? 0;
      const contentType = String(res.headers['content-type'] ?? '');
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve({ status, location: String(res.headers.location), contentType, body: '' });
      }
      if (status !== 200 || !/text\/html|application\/xhtml|text\/plain/i.test(contentType)) {
        res.resume();
        return resolve({ status, contentType, body: '' });
      }
      const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
      const stream = enc.includes('br') ? res.pipe(zlib.createBrotliDecompress())
        : enc.includes('gzip') ? res.pipe(zlib.createGunzip())
        : enc.includes('deflate') ? res.pipe(zlib.createInflate())
        : res;
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        const charset = /charset=([\w-]+)/i.exec(contentType)?.[1] ?? 'utf-8';
        let body: string;
        try { body = new TextDecoder(charset).decode(Buffer.concat(chunks)); } catch { body = Buffer.concat(chunks).toString('utf8'); }
        resolve({ status, contentType, body });
      };
      stream.on('data', (c: Buffer) => {
        if (done) return;
        size += c.length;
        chunks.push(c);
        // Enough to extract from; the rest of the page is not read.
        if (size >= PAGE_FETCH.maxBytes) { finish(); req.destroy(); }
      });
      stream.on('end', finish);
      stream.on('error', (e) => (done ? undefined : (done = true, reject(e))));
    });
    req.on('timeout', () => req.destroy(new Error('page fetch timed out')));
    req.on('error', reject);
    req.end();
  });
}

type Hop = (url: URL, signal: AbortSignal) => Promise<{ status: number; location?: string; contentType: string; body: string }>;

/**
 * The real transport: GET with the fetch rule on every hop and at connect
 * time. `deps` exists for the selftest (a scripted hop and resolver).
 */
export const guardedGet = async (
  raw: string,
  signal: AbortSignal,
  deps: { check?: (url: string) => ReturnType<typeof checkFetchUrl>; hop?: Hop } = {},
): Promise<RawPage | null> => {
  const check = deps.check ?? ((u: string) => checkFetchUrl(u));
  const hop = deps.hop ?? getOnce;
  let url = raw;
  for (let n = 0; n <= PAGE_FETCH.maxRedirects; n++) {
    const verdict = await check(url);
    if (!verdict.ok) return null;
    const res = await hop(new URL(url), signal);
    if (res.location) {
      url = new URL(res.location, url).toString();
      continue;
    }
    return res.status === 200 && res.body ? { url, status: res.status, contentType: res.contentType, body: res.body } : null;
  }
  return null;
};

let transport: PageTransport | null = null;
let offline: () => boolean = () => false;

/**
 * Tests hand in a transport; `offlineWhen` says when, with no transport wired,
 * nothing may be fetched (sdk.ts passes "scripted agents are wired").
 */
export function wirePages(w: { transport?: PageTransport | null; offlineWhen?: () => boolean }) {
  if ('transport' in w) transport = w.transport ?? null;
  if (w.offlineWhen) offline = w.offlineWhen;
  cache.clear();
}

// ---- extraction ----

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', pound: '£', euro: '€', percnt: '%' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Readable text out of HTML: no scripts, styles or page furniture, one block per line. */
export function extractText(html: string, contentType = 'text/html'): { title: string; text: string } {
  if (/text\/plain/i.test(contentType)) return { title: '', text: html.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() };
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  let s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer|aside|form|button|select|canvas)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre|table|ul|ol|dd|dt|caption|figcaption|header|main)\s*>/gi, '\n')
    .replace(/<(td|th)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  const lines = s.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length >= 30 || (/\d/.test(l) && l.length >= 8));
  return { title, text: lines.join('\n') };
}

const STOP = new Set('the a an and or of to in on for by with at from as is are was were be been it its this that these those what which who whom how why when where do does did has have had not no yes than then there their they them our your you we can could would should will shall may might into over under about per vs more most less least much many any all each other such only also just'.split(' '));

/** Content words, lower-cased, a crude plural fold. */
export function terms(text: string): string[] {
  return [...new Set(text.toLowerCase().replace(/[^\p{L}\p{N}%.\s]/gu, ' ').split(/\s+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ''))
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)))];
}

function score(passage: string, want: string[], figures: string[]): number {
  const have = new Set(terms(passage));
  let s = 0;
  for (const w of want) if (have.has(w)) s += 1;
  for (const f of figures) if (f && passage.includes(f)) s += 3;
  if (/\d/.test(passage)) s += 0.5;
  return s;
}

/** Passages of at most ~600 chars: lines, with long lines split at sentence ends. */
function passages(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (line.length <= 600) { out.push(line); continue; }
    let buf = '';
    for (const sent of line.split(/(?<=[.!?])\s+/)) {
      if ((buf + ' ' + sent).length > 600 && buf) { out.push(buf); buf = sent; } else buf = buf ? `${buf} ${sent}` : sent;
    }
    if (buf) out.push(buf.slice(0, 600));
  }
  return out;
}

/**
 * The passages that bear on what is being checked, each with the passage
 * either side of it for context (a figure's definition, its date, its
 * caveat), in page order, at most `cap` characters. When nothing scores, the
 * opening of the page stands in.
 */
export function relevantExcerpt(text: string, focus: string, figures: string[] = [], cap: number = RESEARCH_LIMITS.pageChars): string {
  const want = terms(focus);
  const ps = passages(text);
  const ranked = ps.map((p, i) => ({ i, s: score(p, want, figures) })).filter((x) => x.s >= 1.5).sort((a, b) => b.s - a.s || a.i - b.i);
  const picked = new Set<number>();
  let used = 0;
  const take = (i: number) => {
    if (i < 0 || i >= ps.length || picked.has(i) || used + ps[i].length + 7 > cap) return;
    picked.add(i);
    used += ps[i].length + 7;
  };
  for (const r of ranked) take(r.i);
  for (const r of ranked) { take(r.i - 1); take(r.i + 1); }
  if (!picked.size) return text.slice(0, Math.min(cap, 1_500)).trim();
  const order = [...picked].sort((a, b) => a - b);
  return order.map((i, x) => (x && i !== order[x - 1] + 1 ? `[...]\n${ps[i]}` : ps[i])).join('\n').slice(0, cap);
}

/** A verbatim sentence from the page (at most 300 chars) that best carries a claim, or undefined. */
export function bestQuote(text: string, claim: string, figure?: string): string | undefined {
  const want = terms(claim);
  let best: { s: string; v: number } | null = null;
  for (const p of passages(text)) {
    for (const sent of p.split(/(?<=[.!?])\s+/)) {
      const s = sent.trim();
      if (s.length < 20 || s.length > 300) continue;
      const v = score(s, want, figure ? [figure] : []);
      if (!best || v > best.v) best = { s, v };
    }
  }
  // Two shared content words, or the figure itself plus one.
  return best && best.v >= 2.5 ? best.s : undefined;
}

// ---- reading, cached ----

/** Pages already read in this process, by URL: a page cited twice is fetched once. */
const cache = new Map<string, Promise<Page | null>>();
const CACHE_MAX = 128;

/** True when no page can be read (scripted agents and no page transport). */
export function pagesOffline(): boolean {
  return !transport && offline();
}

export async function readPage(url: string, signal: AbortSignal): Promise<Page | null> {
  if (pagesOffline()) return null;
  const hit = cache.get(url);
  if (hit) return hit;
  const t: PageTransport = transport ?? ((u, s) => guardedGet(u, s));
  const p = (async () => {
    try {
      const raw = await t(url, signal);
      if (!raw?.body) return null;
      const { title, text } = extractText(raw.body, raw.contentType);
      return text.length >= 200 ? { url: raw.url, title, text } : null;
    } catch {
      return null;
    }
  })();
  cache.set(url, p);
  // A failure is not remembered: the next citation of the page may try again.
  void p.then((v) => { if (!v) cache.delete(url); });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return p;
}
