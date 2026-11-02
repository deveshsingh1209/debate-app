/**
 * The fetch rule (docs/PHASE2-PLAN.md 3.3): a research seat may read public
 * web pages and nothing on this machine or its network.
 *
 * The URL's host is resolved and EVERY address it resolves to must be public.
 * A pattern rule on the hostname alone cannot catch `foo.example` pointing at
 * 127.0.0.1, so the resolved addresses are what is judged. The CLI performs
 * the fetch itself, so this runs twice (sdk.ts): before the fetch, and again
 * on where it landed afterwards, which catches a redirect or a re-resolution
 * to a private address after the fact and stops the turn. An answer that
 * differs only for the CLI's own lookup is the residual (SECURITY.md).
 *
 * No side effects at import; the resolver is injectable for tests.
 */
import dns from 'node:dns';
import net from 'node:net';

export type Lookup = (host: string) => Promise<string[]>;

const systemLookup: Lookup = async (host) => (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

function v4Private(ip: string): string | null {
  const [a, b] = ip.split('.').map(Number);
  if (a === 0) return 'an unspecified address';
  if (a === 10) return 'a private address';
  if (a === 127) return 'a loopback address';
  if (a === 169 && b === 254) return 'a link-local address (cloud metadata lives here)';
  if (a === 172 && b >= 16 && b <= 31) return 'a private address';
  if (a === 192 && b === 168) return 'a private address';
  if (a === 100 && b >= 64 && b <= 127) return 'a carrier-grade NAT address';
  if (a === 192 && b === 0 && ip.split('.')[2] === '0') return 'a reserved address';
  if (a === 198 && (b === 18 || b === 19)) return 'a benchmarking address';
  if (a >= 224) return 'a multicast or reserved address';
  return null;
}

function v6Private(ip: string): string | null {
  const s = ip.toLowerCase().split('%')[0];
  if (s === '::') return 'an unspecified address';
  if (s === '::1') return 'a loopback address';
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return v4Private(mapped[1]);
  // The URL parser writes a v4-mapped address in hex: [::ffff:127.0.0.1] becomes ::ffff:7f00:1.
  const hex = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return v4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (/^fe[89ab]/.test(s)) return 'a link-local address';
  if (/^f[cd]/.test(s)) return 'a unique-local (private) address';
  if (/^ff/.test(s)) return 'a multicast address';
  return null;
}

/** Why an address is not public, or null when it is. */
export function nonPublic(ip: string): string | null {
  if (net.isIPv4(ip)) return v4Private(ip);
  if (net.isIPv6(ip)) return v6Private(ip);
  return 'not an IP address';
}

export async function checkFetchUrl(raw: string, lookup: Lookup = systemLookup): Promise<{ ok: true } | { ok: false; reason: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: `the ${url.protocol} scheme is not allowed` };
  if (url.username || url.password) return { ok: false, reason: 'URLs carrying credentials are not allowed' };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, reason: 'no host' };
  if (/^localhost$|\.localhost$|\.local$|\.internal$|\.lan$|\.home\.arpa$/i.test(host)) return { ok: false, reason: `${host} is a local name` };
  let addresses: string[];
  if (net.isIP(host)) addresses = [host];
  else {
    try {
      addresses = await lookup(host);
    } catch {
      return { ok: false, reason: `${host} does not resolve` };
    }
  }
  if (!addresses.length) return { ok: false, reason: `${host} does not resolve` };
  for (const a of addresses) {
    const why = nonPublic(a);
    if (why) return { ok: false, reason: `${host} resolves to ${why}` };
  }
  return { ok: true };
}
