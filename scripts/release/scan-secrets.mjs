#!/usr/bin/env node
/**
 * Pre-publication scan for secrets and personal data.
 *
 *   node scripts/release/scan-secrets.mjs            # tracked files
 *   node scripts/release/scan-secrets.mjs --history  # also every commit (messages and diffs)
 *   ... --terms <file>   # extra private words, one regex per line (your other
 *                        # domains, server names, employer); keep that file
 *                        # OUTSIDE the repository
 *
 * Offline, no dependencies. It looks for credentials (provider keys, tokens,
 * private keys), email addresses, phone numbers, public IP addresses, tunnel
 * host names, home-directory paths, and the commit authors' names outside the
 * places they belong (LICENSE, CODEOWNERS, package.json, author lines). Known
 * test fixtures and documentation placeholders are allowed below; anything
 * else is printed (credentials masked) and the scan exits 1. A clean scan is
 * not proof: read the hits list before publishing.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 30 });

const authorWords = [...new Set(git('log', '--all', '--format=%an').split(/\s+/).filter((w) => w.length >= 3))]
  .map((w) => `\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
const OWNER = new RegExp(authorWords.join('|') || '(?!)', 'i');
const termsAt = process.argv.indexOf('--terms');
const PRIVATE_TERMS = termsAt > 0
  ? fs.readFileSync(process.argv[termsAt + 1], 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  : [];
const OWNER_OK_FILES = /^(LICENSE|\.github\/CODEOWNERS|package\.json|THIRD_PARTY_NOTICES\.md)$/;

/** The test suites' fake keys say what they are. */
const FIXTURE = /CANARY|SELFTEST|SECURITYTEST|FAKE|SECRET-abcdef|EXAMPLE|x{8,}|0{10,}/;

/** [category, pattern, allow(match, file, line) -> true when the hit is a known non-secret] */
const RULES = [
  ['anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/g, (m) => FIXTURE.test(m)],
  ['openai key', /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g, (m) => FIXTURE.test(m)],
  ['github token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}/g],
  ['slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['aws key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['google key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g],
  ['telegram bot token', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['assigned secret', /\b(?:api[_-]?key|secret|token|password|passwd)\b["']?\s*[:=]\s*["'][A-Za-z0-9+/_=-]{24,}["']/gi,
    (m) => /canary|test|fake|example|dummy|placeholder|x{6,}/i.test(m)],
  ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    (m) => /@(?:example\.(?:com|org|net)|users\.noreply\.github\.com|anthropic\.com|[a-z0-9-]+\.(?:test|invalid|example))$/i.test(m)
      || /^(?:noreply|no-reply|you|me|someone|user|name|founder)@/i.test(m)
      || /@\d+\.\d+\.\d+$/.test(m)                                    // npm package@version
      || /^[^@]+@[0-9.]+[a-z]?(?:-[a-z0-9.]+)?$/i.test(m)],
  ['phone number', /(?<![\w.:/-])\+\d{1,3}[ -]?\(?\d{2,4}\)?[ -]?\d{3,4}[ -]?\d{3,5}(?![\w.])/g],
  ['public ip', /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    (m) => {
      const o = m.split('.').map(Number);
      if (o.some((n) => n > 255)) return true;                        // a version or a time, not an address
      return o[0] === 127 || o[0] === 10 || o[0] === 0 || (o[0] === 192 && o[1] === 168) || (o[0] === 172 && o[1] >= 16 && o[1] <= 31)
        || (o[0] === 169 && o[1] === 254) || (o[0] === 100 && o[1] >= 64 && o[1] <= 127)
        || (o[0] === 93 && o[1] === 184)                              // example.com, used by tests as "a public address"
        || (o[0] === 192 && o[1] === 0 && o[2] === 2) || (o[0] === 198 && (o[1] === 51 || o[1] === 18 || o[1] === 19)) || (o[0] === 203 && o[1] === 0 && o[2] === 113)
        || (o[0] === 8 && o[1] === 8) || (o[0] === 1 && o[1] === 1 && o[2] === 1)  // public resolvers named in tests
        || o[0] >= 224;
    }],
  ['tunnel host', /\b[\w-]+\.ts\.net\b|\b[\w-]+\.ngrok(?:-free)?\.(?:io|app|dev)\b|\b[\w-]+\.trycloudflare\.com\b/gi],
  ...(PRIVATE_TERMS.length ? [['private term', new RegExp(PRIVATE_TERMS.join('|'), 'gi')]] : []),
  ['home path', /\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+|[A-Z]:\\\\?Users\\\\?[A-Za-z0-9._-]+/g,
    (m) => /\/Users\/(?:you|me|USER|<you>|name|example)$|\/home\/(?:u|node|user|you|runner|<you>|example)$|Users\\\\?(?:you|USER|name)$/i.test(m)],
  ['owner name', new RegExp(OWNER.source, 'gi'), // Also fine: a line that is about one of those places (the CODEOWNERS handle, the LICENSE holder).
    (_m, file, line) => OWNER_OK_FILES.test(file) || /co-authored-by|author|CODEOWNERS|LICENSE/i.test(line)],
];

const mask = (s) => (s.length <= 10 ? s : `${s.slice(0, 6)}…${s.slice(-2)}`);
const hits = [];

function scanText(text, where, file) {
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const [cat, re, allow] of RULES) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) {
        if (allow?.(m[0], file, line)) continue;
        const secretish = !['email', 'home path', 'owner name', 'tunnel host', 'private term', 'public ip', 'phone number'].includes(cat);
        hits.push({ cat, where: `${where}:${i + 1}`, text: secretish ? mask(m[0]) : m[0], ctx: line.trim().slice(0, 140) });
      }
    }
  });
}

// The scanner names the patterns it looks for, so it does not scan itself.
const SELF = 'scripts/release/scan-secrets.mjs';
// Generated from third-party licence texts, which carry their authors' own addresses.
const GENERATED = new Set(['THIRD_PARTY_NOTICES.md', 'package-lock.json']);
for (const file of git('ls-files', '-z').split('\0').filter(Boolean)) {
  if (file === SELF || GENERATED.has(file) || /\.(?:jpe?g|png|gif|ico|woff2?|ttf|otf|pdf|zip)$/i.test(file)) continue;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }   // the working copy, as it would be committed
  if (text.includes('\0')) continue;
  scanText(text, file, file);
}

if (process.argv.includes('--history')) {
  const log = git('log', '--all', '-p', '--no-color', '--format=@@COMMIT %H%n%B');
  let commit = '';
  let file = '';
  let skip = false;
  for (const line of log.split('\n')) {
    if (line.startsWith('@@COMMIT ')) { commit = line.slice(9, 17); file = '(message)'; skip = false; continue; }
    if (line.startsWith('diff --git ')) {
      file = line.split(' b/')[1] ?? '';
      skip = file === SELF || GENERATED.has(file) || /\.(?:jpe?g|png|woff2?|pdf)$/i.test(file);
      continue;
    }
    if (skip || !(line.startsWith('+') || line.startsWith('-') || file === '(message)')) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    scanText(line, `${commit} ${file}`, file);
  }
}

const seen = new Set();
const unique = hits.filter((h) => { const k = `${h.cat}|${h.where.split(' ')[1] ?? h.where}|${h.text}`; if (seen.has(k)) return false; seen.add(k); return true; });
const by = {};
for (const h of unique) (by[h.cat] ??= []).push(h);
for (const [cat, list] of Object.entries(by)) {
  console.log(`\n${cat}: ${list.length}`);
  for (const h of list.slice(0, 200)) console.log(`  ${h.where}  ${h.text}\n      ${h.ctx}`);
}
console.log(unique.length ? `\n${unique.length} hits to review.` : '\nClean: no hits.');
process.exit(unique.length ? 1 : 0);
