/**
 * The Content-Security-Policy every rendered document carries.
 *
 * Reports and transcripts are model-written HTML. The renderer escapes every
 * word; this is the second wall. Everything a document needs is inline (its
 * styles, its one script, fonts and charts as data: or inline SVG), so it may
 * load nothing at all: no images from a URL, no fetch, no frames, no forms.
 * Text that ever escaped the renderer could therefore not send the report
 * anywhere. Ordinary links (the sources list) still open when clicked.
 *
 * It is written into the document's <head> as well as sent as a header, so it
 * covers the served copy, a downloaded copy opened from disk and the file://
 * page headless Chrome prints to PDF.
 */
export const REPORT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'font-src data:',
  'img-src data:',
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/** The served header: an opaque-origin sandbox plus the same policy. */
export const REPORT_CSP_HEADER = `sandbox allow-scripts allow-popups allow-downloads allow-modals; ${REPORT_CSP}`;

const META = `<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`;

/**
 * Puts the policy first in the document's <head>, before anything it governs.
 * Idempotent, and a document with no <head> gets one, so a report written by
 * an older version is covered too when it is printed.
 */
export function withReportCsp(html: string): string {
  if (html.includes('http-equiv="Content-Security-Policy"')) return html;
  const charset = /<meta charset="utf-8">/i;
  if (charset.test(html)) return html.replace(charset, (m) => `${m}\n${META}`);
  const head = /<head[^>]*>/i;
  if (head.test(html)) return html.replace(head, (m) => `${m}\n${META}`);
  return `<head>${META}</head>${html}`;
}
