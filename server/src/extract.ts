import { unzipSync } from 'fflate';

/**
 * Text extraction for Office files, at upload time.
 *
 * This exists because a real user uploaded a pitch deck twice and cancelled
 * twice. The .pptx saved fine, but the dossier analyst only has Read/Glob/Grep
 * and a .pptx is a zip of XML — binary to the Read tool. The analyst reported,
 * accurately, that it had "no archive/XML parsing tool", intake told them
 * the deck could not be read, and they gave up. Same trap for .docx and .xlsx,
 * which had been sitting in the allowed-extensions list as if they worked.
 *
 * The formats are all zip containers of XML, and fflate is already here for
 * zip uploads, so the server unpacks the text itself and writes a readable
 * sibling next to the original. Deliberately dependency-free and deliberately
 * modest: text runs, in document order, and nothing else. Charts, images and
 * layout do not survive — the extracted file says so in its first line, so the
 * analyst can tell the panel what it is working from rather than guessing.
 */

const dec = new TextDecoder();

/** Minimal XML entity decode: the five named ones plus numeric refs. */
function unescapeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** All text runs matching a tag, e.g. <a:t>…</a:t>, decoded, in order. */
function runs(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g');
  const out: string[] = [];
  for (const m of xml.matchAll(re)) out.push(unescapeXml(m[1]));
  return out;
}

/**
 * A zip filter with a running budget, judged on each entry's DECLARED size
 * before anything is inflated. Without it a 60 MB zip of zero-filled entries
 * asks for tens of gigabytes in one synchronous call and takes the whole
 * process (and every debate in it) down. fflate inflates each entry into a
 * buffer of its declared size, so a size that lies cannot grow past this.
 */
export function boundedZipFilter(limits: { maxEntries: number; maxOne: number; maxTotal: number }, keep: (name: string) => boolean = () => true) {
  let entries = 0;
  let total = 0;
  const state = { refused: 0 };
  const filter = (f: { name: string; originalSize: number }) => {
    if (!keep(f.name)) return false;
    if (entries >= limits.maxEntries || f.originalSize > limits.maxOne || total + f.originalSize > limits.maxTotal) {
      state.refused++;
      return false;
    }
    entries++;
    total += f.originalSize;
    return true;
  };
  return { filter, state };
}

const OFFICE_LIMITS = { maxEntries: 2_000, maxOne: 50 * 1024 * 1024, maxTotal: 120 * 1024 * 1024 };

function unzip(buf: Uint8Array, keep: (name: string) => boolean): Record<string, Uint8Array> | null {
  try {
    return unzipSync(buf, { filter: boundedZipFilter(OFFICE_LIMITS, keep).filter });
  } catch {
    return null; // not a zip, or corrupt: caller reports, never throws
  }
}

const numOf = (name: string) => Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0);

export interface Extracted {
  /** Suffix for the sibling file, e.g. '.extracted.md'. */
  ext: string;
  text: string;
}

/** Slides in deck order, each with its text runs and speaker notes. */
export function extractPptx(buf: Uint8Array, sourceName: string): Extracted | null {
  const entries = unzip(buf, (n) => /^ppt\/(slides|notesSlides)\/[^/]*\.xml$/.test(n));
  if (!entries) return null;

  const slides = Object.keys(entries)
    .filter((n) => n.startsWith('ppt/slides/'))
    .sort((a, b) => numOf(a) - numOf(b));
  if (!slides.length) return null;

  const parts: string[] = [
    `Extracted automatically from ${sourceName}. Text only, in slide order; images, charts and layout are not included.`,
  ];
  for (const name of slides) {
    const xml = dec.decode(entries[name]);
    /**
     * Paragraph structure matters more than run structure: a title and its
     * bullets arrive as separate <a:p> blocks, but one bullet's bold word is a
     * separate <a:t> run inside the same block. Split on paragraphs first so
     * "the $25M" and "ask" do not land on different lines.
     */
    const lines = xml
      .split(/<\/a:p>/)
      .map((p) => runs(p, 'a:t').join('').trim())
      .filter(Boolean);
    parts.push(`\n## Slide ${numOf(name)}\n${lines.map((l) => `- ${l}`).join('\n') || '- (no text on this slide)'}`);

    const notes = entries[`ppt/notesSlides/notesSlide${numOf(name)}.xml`];
    if (notes) {
      const noteLines = dec.decode(notes)
        .split(/<\/a:p>/)
        .map((p) => runs(p, 'a:t').join('').trim())
        .filter((l) => l && !/^\d+$/.test(l)); // slide-number placeholder
      if (noteLines.length) parts.push(`Speaker notes: ${noteLines.join(' ')}`);
    }
  }
  return { ext: '.extracted.md', text: parts.join('\n') };
}

/** Paragraphs in document order. Tables flatten to cell-per-line, which is legible enough. */
export function extractDocx(buf: Uint8Array, sourceName: string): Extracted | null {
  const entries = unzip(buf, (n) => n === 'word/document.xml');
  const doc = entries?.['word/document.xml'];
  if (!doc) return null;

  const paras = dec.decode(doc)
    .split(/<\/w:p>/)
    .map((p) => runs(p, 'w:t').join('').trim())
    .filter(Boolean);
  if (!paras.length) return null;

  return {
    ext: '.extracted.md',
    text: `Extracted automatically from ${sourceName}. Text only; images, comments and tracked changes are not included.\n\n${paras.join('\n\n')}`,
  };
}

/** Column letters -> 0-based index: A=0, Z=25, AA=26. */
function colIndex(cellRef: string): number {
  const letters = cellRef.match(/^[A-Z]+/)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

const MAX_ROWS_PER_SHEET = 3000;

/**
 * Sheets as CSV blocks in one markdown file. CSV because the quant desk reads
 * this too, and python parses a fenced CSV block far more reliably than prose.
 */
export function extractXlsx(buf: Uint8Array, sourceName: string): Extracted | null {
  const entries = unzip(buf, (n) =>
    n === 'xl/workbook.xml' || n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n)
  );
  if (!entries) return null;

  const shared: string[] = [];
  const ss = entries['xl/sharedStrings.xml'];
  if (ss) {
    // A shared string may be split into styled runs; concatenate them.
    for (const m of dec.decode(ss).matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) {
      shared.push(runs(m[1], 't').join(''));
    }
  }

  // Sheet display names, in workbook order; the Nth <sheet> is sheetN.xml in
  // every writer that matters here, and a wrong name is cosmetic anyway.
  const sheetNames: string[] = [];
  const wb = entries['xl/workbook.xml'];
  if (wb) {
    for (const m of dec.decode(wb).matchAll(/<sheet\s[^>]*name="([^"]*)"/g)) sheetNames.push(unescapeXml(m[1]));
  }

  const sheets = Object.keys(entries)
    .filter((n) => n.startsWith('xl/worksheets/'))
    .sort((a, b) => numOf(a) - numOf(b));
  if (!sheets.length) return null;

  const parts: string[] = [
    `Extracted automatically from ${sourceName}. Cell values only, as CSV per sheet; formulas show their last computed value, and formatting, charts and merged-cell layout are not included.`,
  ];
  for (const name of sheets) {
    const xml = dec.decode(entries[name]);
    const rows: string[] = [];
    let truncated = false;
    for (const rm of xml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= MAX_ROWS_PER_SHEET) { truncated = true; break; }
      const cells: string[] = [];
      for (const cm of rm[1].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1];
        const body = cm[2] ?? '';
        const ref = attrs.match(/r="([A-Z]+\d+)"/)?.[1];
        const type = attrs.match(/t="(\w+)"/)?.[1];
        let value = '';
        if (type === 'inlineStr') {
          value = runs(body, 't').join('');
        } else {
          const v = body.match(/<v(?:\s[^>]*)?>([^<]*)<\/v>/)?.[1];
          if (v !== undefined) value = type === 's' ? (shared[Number(v)] ?? '') : unescapeXml(v);
        }
        const at = ref ? colIndex(ref) : cells.length;
        while (cells.length < at) cells.push('');
        cells[at] = value;
      }
      rows.push(cells.map(csvCell).join(','));
    }
    const idx = numOf(name) - 1;
    const label = sheetNames[idx] ? `${sheetNames[idx]}` : `Sheet ${numOf(name)}`;
    parts.push(`\n## ${label}\n\`\`\`csv\n${rows.join('\n')}\n\`\`\`${truncated ? `\n(truncated at ${MAX_ROWS_PER_SHEET} rows)` : ''}`);
  }
  return { ext: '.extracted.md', text: parts.join('\n') };
}

/** Dispatch by extension. Null means "nothing we can do", never an exception. */
export function extractOffice(name: string, buf: Uint8Array): Extracted | null {
  const ext = name.split('.').pop()?.toLowerCase();
  try {
    if (ext === 'pptx') return extractPptx(buf, name);
    if (ext === 'docx') return extractDocx(buf, name);
    if (ext === 'xlsx') return extractXlsx(buf, name);
  } catch (err) {
    console.error(`[extract] ${name} failed:`, err);
  }
  return null;
}
