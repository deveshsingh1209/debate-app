import fs from 'node:fs';
import path from 'node:path';

/**
 * The report's and the transcript's typefaces, inlined.
 *
 * Both documents used to link Google Fonts, so opening a report, printing it
 * to PDF, or running the print QA made a request to Google. The app is
 * local-first: nothing it renders may reach another host. The same faces
 * (Rajdhani, Inter, JetBrains Mono; all SIL OFL) now come from the
 * @fontsource packages installed with the app, embedded as data URIs so the
 * HTML stays a single self-contained file (reports are opened from disk and
 * handed to Chrome as a file).
 *
 * Latin subset, only the weights the documents use. If the packages cannot
 * be found the CSS is empty and the documents fall back to their system font
 * stacks: never to a CDN.
 */

type Face = { family: string; pkg: string; file: string; weight: number };

const FACES: Face[] = [
  { family: 'Rajdhani', pkg: 'rajdhani', file: 'rajdhani-latin-500-normal.woff2', weight: 500 },
  { family: 'Rajdhani', pkg: 'rajdhani', file: 'rajdhani-latin-600-normal.woff2', weight: 600 },
  { family: 'Rajdhani', pkg: 'rajdhani', file: 'rajdhani-latin-700-normal.woff2', weight: 700 },
  { family: 'Inter', pkg: 'inter', file: 'inter-latin-400-normal.woff2', weight: 400 },
  { family: 'Inter', pkg: 'inter', file: 'inter-latin-500-normal.woff2', weight: 500 },
  { family: 'Inter', pkg: 'inter', file: 'inter-latin-600-normal.woff2', weight: 600 },
  { family: 'JetBrains Mono', pkg: 'jetbrains-mono', file: 'jetbrains-mono-latin-400-normal.woff2', weight: 400 },
  { family: 'JetBrains Mono', pkg: 'jetbrains-mono', file: 'jetbrains-mono-latin-500-normal.woff2', weight: 500 },
  { family: 'JetBrains Mono', pkg: 'jetbrains-mono', file: 'jetbrains-mono-latin-600-normal.woff2', weight: 600 },
];

/** node_modules is at the repo root (workspaces); the server may run from the root or from server/. */
function fontsourceDir(): string | null {
  const roots = [process.cwd(), path.resolve(process.cwd(), '..'), path.resolve(process.cwd(), '../..')];
  for (const r of roots) {
    const d = path.join(r, 'node_modules', '@fontsource');
    if (fs.existsSync(d)) return d;
  }
  return null;
}

const cache = new Map<string, string>();

/** `@font-face` rules for the given families, fonts embedded. Empty string if unavailable. */
export function inlineFontCss(families: string[]): string {
  const key = families.join('|');
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const dir = fontsourceDir();
  let css = '';
  if (dir) {
    for (const f of FACES) {
      if (!families.includes(f.family)) continue;
      const file = path.join(dir, f.pkg, 'files', f.file);
      if (!fs.existsSync(file)) continue;
      const b64 = fs.readFileSync(file).toString('base64');
      css += `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${f.weight};font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2');}\n`;
    }
  }
  cache.set(key, css);
  return css;
}
