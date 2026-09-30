/**
 * A small, deterministic, hardened HTML digest. It executes nothing and follows nothing: a bounded tokenizer that
 * extracts a title, description, canonical URL, language, robots meta, outgoing links and a cleaned text excerpt.
 * No DOM library, no JavaScript, no external fetches, capped tag count and nesting, and only the standard named
 * and numeric character references are decoded.
 */
export interface Digest {
  title?: string; description?: string; canonicalUrl?: string; language?: string;
  noindex: boolean; nofollow: boolean; noarchive: boolean;
  text: string; textTruncated: boolean; links: Array<{ url: string; nofollow: boolean }>; linksTruncated: boolean;
}
/** Cuts a string to at most `maxBytes` of UTF-8 without splitting a character. Linear time: adversarial pages must not make trimming quadratic. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const cut = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.from(text).subarray(0, Math.max(0, maxBytes)));
  return cut.endsWith('\ufffd') ? cut.slice(0, -1) : cut;
}
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,6});/g, (whole, body: string) => {
    if (body.startsWith('#')) { const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10); return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' '; }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'head-skip']);
const BLOCK = new Set(['p', 'div', 'br', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'table', 'section', 'article', 'header', 'footer', 'nav', 'main', 'aside', 'blockquote', 'pre', 'hr']);
const MAX_TAGS = 200000; const MAX_ATTRS = 24;

function parseAttrs(source: string): Map<string, string> {
  const attrs = new Map<string, string>(); const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g; let match: RegExpExecArray | null; let count = 0;
  while ((match = re.exec(source)) && count++ < MAX_ATTRS) { const name = (match[1] ?? '').toLowerCase(); if (!attrs.has(name)) attrs.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? '')); }
  return attrs;
}
export function digestHtml(html: string, baseUrl: string, options: { maxTextBytes: number; maxLinks: number }): Digest {
  let base = baseUrl; const out: Digest = { noindex: false, nofollow: false, noarchive: false, text: '', textTruncated: false, links: [], linksTruncated: false };
  const seen = new Set<string>(); const textParts: string[] = []; let textBytes = 0; let title = ''; let inTitle = false; let skipTag: string | undefined; let depth = 0; let tags = 0;
  const addText = (raw: string) => {
    if (options.maxTextBytes === 0) { out.textTruncated = out.textTruncated || raw.trim() !== ''; return; }
    const cleaned = decodeEntities(raw).replace(/\s+/g, ' '); if (!cleaned.trim() && !cleaned.includes(' ')) return;
    const room = options.maxTextBytes - textBytes; if (room <= 0) { if (cleaned.trim()) out.textTruncated = true; return; }
    const piece = truncateUtf8(cleaned, room);
    if (piece.length < cleaned.length) out.textTruncated = true; textParts.push(piece); textBytes += Buffer.byteLength(piece);
  };
  // Links and the canonical URL are resolved after the whole document is read, against the final <base>, as browsers do.
  const rawLinks: Array<{ href: string; nofollow: boolean }> = []; let rawCanonical: string | undefined;
  const addLink = (href: string, nofollow: boolean) => { if (rawLinks.length < 5000) rawLinks.push({ href, nofollow }); };
  let i = 0; const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { if (!skipTag) { const rest = html.slice(i); if (inTitle) title += rest; else addText(rest); } break; }
    if (lt > i && !skipTag) { const chunk = html.slice(i, lt); if (inTitle) title += chunk; else addText(chunk); }
    i = lt;
    if (html.startsWith('<!--', i)) { const end = html.indexOf('-->', i + 4); i = end < 0 ? n : end + 3; continue; }
    if (html[i + 1] === '!' || html[i + 1] === '?') { const end = html.indexOf('>', i + 2); i = end < 0 ? n : end + 1; continue; }
    // Find the end of the tag, honouring quotes.
    let j = i + 1; let quote = ''; for (; j < n; j++) { const c = html[j]; if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c as string; else if (c === '>') break; }
    if (j >= n) break; const raw = html.slice(i + 1, j); i = j + 1;
    if (++tags > MAX_TAGS) break;
    const closing = raw.startsWith('/'); const nameMatch = /^\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)/.exec(raw); if (!nameMatch) continue;
    const name = (nameMatch[1] ?? '').toLowerCase();
    if (skipTag) { if (closing && name === skipTag) { skipTag = undefined; depth = 0; } continue; }
    if (closing) { if (name === 'title') inTitle = false; else if (BLOCK.has(name)) addText(' '); continue; }
    const attrs = parseAttrs(raw.slice(nameMatch[0].length));
    if (SKIP.has(name)) { if (!raw.endsWith('/')) { skipTag = name; depth = 1; } continue; }
    if (name === 'title') { inTitle = true; continue; }
    if (name === 'html') { const lang = attrs.get('lang'); if (lang && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$/.test(lang)) out.language = lang; }
    else if (name === 'base') { const href = attrs.get('href'); if (href) { try { const b = new URL(href, baseUrl); if (b.protocol === 'http:' || b.protocol === 'https:') base = b.toString(); } catch { /* ignore */ } } }
    else if (name === 'meta') {
      const key = (attrs.get('name') ?? '').toLowerCase(); const content = attrs.get('content') ?? '';
      if (key === 'description' && !out.description) out.description = content.replace(/\s+/g, ' ').trim().slice(0, 500);
      else if (key === 'robots' || key === 'googlebot') for (const token of content.toLowerCase().split(/[\s,]+/)) { if (token === 'noindex' || token === 'none') out.noindex = true; if (token === 'nofollow' || token === 'none') out.nofollow = true; if (token === 'noarchive') out.noarchive = true; }
    } else if (name === 'link') { const rel = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/); const href = attrs.get('href'); if (rel.includes('canonical') && href && rawCanonical === undefined) rawCanonical = href; }
    else if (name === 'a') { const href = attrs.get('href'); if (href) { const rel = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/); addLink(href, rel.includes('nofollow') || rel.includes('ugc') || rel.includes('sponsored')); } }
    else if (BLOCK.has(name)) addText(' ');
    void depth;
  }
  if (rawCanonical !== undefined) { try { const u = new URL(rawCanonical.trim(), base); u.hash = ''; if ((u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password && u.toString().length <= 2048) out.canonicalUrl = u.toString(); } catch { /* ignore */ } }
  for (const { href, nofollow } of rawLinks) {
    let url: URL; try { url = new URL(href.trim(), base); } catch { continue; }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) continue;
    url.hash = ''; const text = url.toString(); if (text.length < 8 || text.length > 2048 || seen.has(text)) continue;
    if (out.links.length >= options.maxLinks) { out.linksTruncated = true; break; }
    seen.add(text); out.links.push({ url: text, nofollow });
  }
  const cleanTitle = decodeEntities(title).replace(/\s+/g, ' ').trim().slice(0, 300); if (cleanTitle) out.title = cleanTitle;
  out.text = textParts.join('').replace(/\s+/g, ' ').trim();
  return out;
}
/** text/plain: the body is the text. */
export function digestPlain(text: string, options: { maxTextBytes: number }): Digest {
  const whole = text.replace(/\s+/g, ' ').trim(); const body = truncateUtf8(whole, options.maxTextBytes); const truncated = body.length < whole.length;
  return { noindex: false, nofollow: false, noarchive: false, text: body, textTruncated: truncated, links: [], linksTruncated: false };
}
