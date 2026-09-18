/*
 * ArixAI Zero-Key Web Page Extractor
 * Edge-safe single-file Vercel Function
 *
 * Save as: /api/scrape.js
 * Frontend: /index.html (or any HTML page that posts to /api/scrape)
 *
 * No external API keys. No external scraping service.
 * Uses layered public-page extraction only:
 *  - direct HTTP fetch with resilient headers
 *  - redirects / content-type checks / size limits / timeouts
 *  - metadata + canonical + OpenGraph
 *  - semantic HTML extraction (article/main/body)
 *  - JSON-LD extraction
 *  - hydration-state extraction (Next/Nuxt/etc. style script payloads)
 *  - noscript/template fallback extraction
 *  - table extraction
 *  - link extraction
 *  - same-origin JS bundle inspection
 *  - same-origin JSON/API discovery and retrieval
 *  - alternate representations (amp/print/mobile/data)
 *  - same-origin iframe recovery
 *  - lightweight next/pagination recovery
 *  - candidate scoring + deduplication + evidence voting
 *
 * Important: Edge functions do not run a full Chromium browser. This file
 * intentionally avoids Puppeteer/Playwright and stays zero-key/Edge-only.
 */

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

const VERSION = 'arix-edge-extractor-1.0.0';
const DEFAULT_TIMEOUT_MS = 8500;
const MAX_PRIMARY_BYTES = 5_000_000;
const MAX_SECONDARY_BYTES = 1_500_000;
const MAX_URLS = 25;
const MAX_SECONDARY_REQUESTS = 7;
const MAX_JS_BUNDLES = 3;
const MAX_DISCOVERED_DATA_URLS = 4;
const MAX_IFRAMES = 2;
const MAX_PAGINATION_PAGES = 2;

const COMMON_HEADERS = [
  {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-IN,en;q=0.9',
    'Cache-Control': 'no-cache'
  },
  {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/150.0 Mobile Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-IN,en;q=0.8',
    'Cache-Control': 'no-cache'
  },
  {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/150.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.8'
  }
];

const BAD_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata.google.com'
]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST,OPTIONS',
      'access-control-allow-headers': 'content-type'
    }
  });
}

function now() {
  return Date.now();
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normalizeSpace(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeEntities(str) {
  let s = String(str || '');
  const named = {
    '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
    '&#39;': "'", '&apos;': "'", '&copy;': '©', '&reg;': '®', '&hellip;': '…',
    '&ndash;': '–', '&mdash;': '—', '&rsquo;': '’', '&lsquo;': '‘', '&rdquo;': '”', '&ldquo;': '“'
  };
  s = s.replace(/&(?:nbsp|amp|lt|gt|quot|#39|apos|copy|reg|hellip|ndash|mdash|rsquo|lsquo|rdquo|ldquo);/gi, m => named[m.toLowerCase()] ?? m);
  s = s.replace(/&#(x[0-9a-f]+|\d+);/gi, (_, body) => {
    const n = body[0].toLowerCase() === 'x' ? parseInt(body.slice(1), 16) : parseInt(body, 10);
    return Number.isFinite(n) ? String.fromCodePoint(Math.min(n, 0x10ffff)) : '';
  });
  return s;
}

function stripTags(html) {
  return normalizeSpace(decodeEntities(
    String(html || '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p\s*>/gi, '\n\n')
      .replace(/<\/(?:div|section|article|main|li|tr|h[1-6]|blockquote|pre)\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  ));
}

function textWithParagraphs(html) {
  let s = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\s*(?:p|div|section|article|main|li|blockquote|pre|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<\s*\/\s*(?:p|div|section|article|main|li|blockquote|pre|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s;
}

function hashString(s) {
  // Fast non-cryptographic fingerprint for deduplication.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const text = String(s || '').slice(0, 20000);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c + i;
    h2 = Math.imul(h2, 0x5bd1e995);
  }
  return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
}

function safeURL(raw, base) {
  try {
    const u = new URL(raw, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    if (u.username || u.password) return null;
    return u;
  } catch {
    return null;
  }
}

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BAD_HOSTS.has(h) || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  if (h === '0.0.0.0' || h === '::1' || h === '::') return true;
  if (/^[0-9a-f:]+$/i.test(h) && h.includes(':')) return true; // reject raw IPv6 to reduce SSRF ambiguity
  return false;
}

function validateTarget(raw) {
  const u = safeURL(raw);
  if (!u) return { ok: false, error: 'Invalid URL. Use http:// or https://.' };
  if (isPrivateHost(u.hostname)) return { ok: false, error: 'Private/local network targets are blocked.' };
  return { ok: true, url: u };
}

async function readTextLimited(response, maxBytes) {
  const len = Number(response.headers.get('content-length') || 0);
  if (len && len > maxBytes) throw new Error(`Response too large (${len} bytes). Limit is ${maxBytes}.`);
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error('Response exceeded size limit.');
    return text;
  }
  const decoder = new TextDecoder();
  let total = 0;
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new Error(`Response exceeded ${maxBytes} bytes.`);
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

async function fetchText(url, { headers = COMMON_HEADERS[0], timeout = DEFAULT_TIMEOUT_MS, maxBytes = MAX_PRIMARY_BYTES } = {}) {
  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        ...headers,
        'Accept-Encoding': 'gzip, deflate, br'
      },
      redirect: 'follow',
      signal: controller.signal,
      cache: 'no-store'
    });
    const finalURL = response.url || url;
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const body = await readTextLimited(response, maxBytes);
    return {
      ok: response.ok,
      status: response.status,
      finalURL,
      contentType,
      body,
      headers: Object.fromEntries(response.headers.entries()),
      latencyMs: now() - started
    };
  } catch (error) {
    const e = error instanceof Error ? error : new Error(String(error));
    return {
      ok: false,
      status: 0,
      finalURL: url,
      contentType: '',
      body: '',
      headers: {},
      latencyMs: now() - started,
      error: e.name === 'AbortError' ? `Timed out after ${timeout} ms.` : e.message
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseAttributes(tag) {
  const attrs = {};
  const re = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  const source = String(tag || '').replace(/^<[^\s>]+\s*|\s*\/?\s*>$/g, '');
  while ((m = re.exec(source))) attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return attrs;
}

function extractTagBlocks(html, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
  let m;
  while ((m = re.exec(html)) && out.length < 50) out.push(m[0]);
  return out;
}

function extractOpeningTags(html, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  let m;
  while ((m = re.exec(html)) && out.length < 500) out.push(m[0]);
  return out;
}

function extractBetween(html, startTag, endTag) {
  const start = html.search(new RegExp(`<${startTag}\\b[^>]*>`, 'i'));
  if (start < 0) return '';
  const openEnd = html.indexOf('>', start);
  if (openEnd < 0) return '';
  const end = html.toLowerCase().indexOf(`</${endTag.toLowerCase()}>`, openEnd + 1);
  return end < 0 ? html.slice(openEnd + 1) : html.slice(openEnd + 1, end);
}

function extractMeta(html) {
  const meta = {};
  for (const tag of extractOpeningTags(html, 'meta')) {
    const a = parseAttributes(tag);
    const key = (a.property || a.name || a['http-equiv'] || '').toLowerCase();
    if (!key) continue;
    if (a.content && !(key in meta)) meta[key] = a.content;
  }
  const titleBlock = extractBetween(html, 'title', 'title');
  return {
    title: normalizeSpace(stripTags(titleBlock)),
    description: meta.description || meta['og:description'] || meta['twitter:description'] || '',
    canonical: (() => {
      const links = extractOpeningTags(html, 'link');
      const canonical = links.map(parseAttributes).find(a => (a.rel || '').toLowerCase().split(/\s+/).includes('canonical'));
      return canonical?.href || '';
    })(),
    lang: (() => {
      const match = html.match(/<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i);
      return match?.[1] || '';
    })(),
    meta
  };
}

function getCandidateBlocks(html) {
  const blocks = [];
  const patterns = [
    { label: 'article', re: /<article\b[^>]*>[\s\S]*?<\/article>/gi, base: 120 },
    { label: 'main', re: /<main\b[^>]*>[\s\S]*?<\/main>/gi, base: 110 },
    { label: '[role=main]', re: /<[^>]+role\s*=\s*["']main["'][^>]*>[\s\S]*?<\/[^>]+>/gi, base: 90 },
    { label: 'content-class', re: /<(?:div|section)\b[^>]*(?:class|id)\s*=\s*["'][^"']*(?:article|story|content|post|entry|main|body|text|document)[^"']*["'][^>]*>[\s\S]*?<\/(?:div|section)>/gi, base: 75 },
    { label: 'body', re: /<body\b[^>]*>[\s\S]*?<\/body>/gi, base: 20 }
  ];
  for (const p of patterns) {
    let m;
    let count = 0;
    while ((m = p.re.exec(html)) && count++ < 8) blocks.push({ label: p.label, html: m[0], base: p.base });
  }
  return blocks;
}

const BOILERPLATE = /\b(cookie|privacy|subscribe|sign\s*up|log\s*in|login|register|advertisement|advert|sponsored|newsletter|follow us|share this|related articles|recommended|all rights reserved|accept all|manage preferences|skip to content)\b/i;

function scoreText(text, html, base = 0) {
  const t = normalizeSpace(text);
  const len = t.length;
  const paragraphs = (t.match(/[.!?](?:\s|$)/g) || []).length;
  const headings = (html.match(/<h[1-6]\b/gi) || []).length;
  const links = (html.match(/<a\b/gi) || []).length;
  const images = (html.match(/<img\b/gi) || []).length;
  const listItems = (html.match(/<li\b/gi) || []).length;
  const density = len / Math.max(1, html.length);
  let score = base;
  score += clamp(Math.log10(Math.max(10, len)) * 18, 0, 90);
  score += clamp(paragraphs * 3, 0, 60);
  score += clamp(headings * 5, 0, 25);
  score += clamp(density * 100, 0, 25);
  score += clamp(listItems * 1.5, 0, 15);
  score += images > 20 ? -15 : 0;
  score -= clamp(links * 2.2, 0, 60);
  if (BOILERPLATE.test(t.slice(0, 5000))) score -= 25;
  if (len < 200) score -= 60;
  return Math.round(score * 10) / 10;
}

function cleanCandidate(text) {
  const lines = String(text || '')
    .split(/\n+/)
    .map(normalizeSpace)
    .filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    if (line.length < 2) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out.join('\n\n').trim();
}

function extractSemantic(html) {
  const candidates = getCandidateBlocks(html).map(c => {
    const text = cleanCandidate(textWithParagraphs(c.html));
    return {
      method: `semantic:${c.label}`,
      text,
      score: scoreText(text, c.html, c.base),
      length: text.length
    };
  });
  return candidates.filter(x => x.length > 50);
}

function parseJSONSafe(value) {
  try { return JSON.parse(value); } catch {}
  try {
    const cleaned = value.replace(/^\s*<!--|-->\s*$/g, '').trim();
    return JSON.parse(cleaned);
  } catch {}
  return null;
}

function collectStringsByKey(obj, targets, out, path = '$', depth = 0) {
  if (depth > 8 || obj == null) return;
  if (typeof obj === 'string') {
    if (obj.length > 100) out.push({ value: stripTags(obj), path });
    return;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < Math.min(obj.length, 200); i++) collectStringsByKey(obj[i], targets, out, `${path}[${i}]`, depth + 1);
    return;
  }
  if (typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj).slice(0, 500)) {
    const lk = k.toLowerCase();
    if (targets.some(t => lk === t || lk.includes(t))) {
      if (typeof v === 'string' && v.length > 80) out.push({ value: stripTags(v), path: `${path}.${k}` });
      else if (typeof v === 'object') collectStringsByKey(v, targets, out, `${path}.${k}`, depth + 1);
    }
    if (typeof v === 'object') collectStringsByKey(v, targets, out, `${path}.${k}`, depth + 1);
  }
}

function extractJSONLD(html) {
  const candidates = [];
  const jsonld = extractTagBlocks(html, 'script').filter(s => /type\s*=\s*["']application\/ld\+json["']/i.test(s));
  for (const block of jsonld) {
    const inner = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
    const obj = parseJSONSafe(inner.trim());
    if (!obj) continue;
    const items = Array.isArray(obj) ? obj : (obj['@graph'] ? obj['@graph'] : [obj]);
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const body = item.articleBody || item.text || item.description || item.reviewBody || '';
      if (typeof body === 'string' && body.length > 120) {
        const text = cleanCandidate(stripTags(body));
        candidates.push({
          method: `jsonld:${item['@type'] || 'object'}`,
          text,
          score: scoreText(text, block, 135),
          length: text.length,
          structured: item
        });
      }
    }
  }
  return candidates;
}

function extractHydration(html) {
  const candidates = [];
  const scripts = extractTagBlocks(html, 'script');
  const preferred = /__NEXT_DATA__|__NUXT__|__APOLLO_STATE__|__INITIAL_STATE__|__PRELOADED_STATE__|hydration|preloaded|pageProps|initialProps/i;
  for (const block of scripts.slice(0, 100)) {
    const idMatch = block.match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    if (!(preferred.test(idMatch) || preferred.test(block.slice(0, 600)))) continue;
    const inner = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
    const obj = parseJSONSafe(inner);
    if (!obj) continue;
    const found = [];
    collectStringsByKey(obj, ['articlebody', 'body', 'content', 'html', 'textcontent', 'story', 'description', 'markdown', 'document'], found);
    for (const f of found) {
      const text = cleanCandidate(stripTags(f.value));
      if (text.length < 120) continue;
      candidates.push({
        method: `hydration:${idMatch || 'state'}`,
        text,
        score: scoreText(text, block, 125),
        length: text.length,
        path: f.path
      });
    }
  }
  return candidates;
}

function extractFallbacks(html) {
  const candidates = [];
  for (const tag of ['noscript', 'template']) {
    for (const block of extractTagBlocks(html, tag).slice(0, 10)) {
      const text = cleanCandidate(textWithParagraphs(block));
      if (text.length < 120) continue;
      const usefulBoost = /article|main|content|story|text/i.test(block) ? 100 : 70;
      candidates.push({ method: `${tag}-fallback`, text, score: scoreText(text, block, usefulBoost), length: text.length });
    }
  }
  return candidates;
}

function extractTables(html) {
  const tables = [];
  for (const table of extractTagBlocks(html, 'table').slice(0, 30)) {
    const rows = [];
    for (const tr of extractTagBlocks(table, 'tr')) {
      const cells = [];
      const cellRe = /<(?:th|td)\b[^>]*>[\s\S]*?<\/(?:th|td)>/gi;
      let m;
      while ((m = cellRe.exec(tr))) cells.push(normalizeSpace(stripTags(m[0])));
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) continue;
    const markdown = rows.map(r => `| ${r.map(x => x.replace(/\|/g, '\\|')).join(' | ')} |`).join('\n');
    tables.push({ rows, markdown });
  }
  return tables;
}

function extractLinks(html, baseURL) {
  const out = [];
  const seen = new Set();
  for (const tag of extractOpeningTags(html, 'a').slice(0, 1200)) {
    const a = parseAttributes(tag);
    const href = safeURL(a.href, baseURL);
    if (!href) continue;
    const text = normalizeSpace(a.title || '');
    const key = href.href;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: key, text });
    if (out.length >= 500) break;
  }
  return out;
}

function extractAlternates(html, baseURL) {
  const out = [];
  for (const tag of extractOpeningTags(html, 'link')) {
    const a = parseAttributes(tag);
    const rel = (a.rel || '').toLowerCase();
    const href = safeURL(a.href, baseURL);
    if (!href) continue;
    if (/amphtml|alternate|print|mobile|next|sitemap|rss|atom|json/i.test(rel + ' ' + (a.type || ''))) {
      out.push({ url: href.href, rel, type: a.type || '', title: a.title || '' });
    }
  }
  return out.slice(0, 30);
}

function discoverScriptURLs(html, baseURL) {
  const urls = [];
  for (const tag of extractOpeningTags(html, 'script')) {
    const a = parseAttributes(tag);
    if (!a.src) continue;
    const u = safeURL(a.src, baseURL);
    if (u && u.origin === new URL(baseURL).origin) urls.push(u.href);
  }
  return [...new Set(urls)].slice(0, MAX_JS_BUNDLES);
}

function discoverDataURLs(scriptText, pageURL) {
  const base = new URL(pageURL);
  const urls = new Set();
  const re = /(?:https?:\/\/[^\s"'`<>\\]+|(?:\/|\.\/|\.\.\/)[A-Za-z0-9_?=&%./:-]+|(?:api|graphql|data|content|article|post|story)[A-Za-z0-9_?=&%./:-]*)/gi;
  let m;
  while ((m = re.exec(scriptText)) && urls.size < MAX_DISCOVERED_DATA_URLS * 4) {
    let raw = m[0].replace(/[),;]+$/g, '');
    if (/\.(?:png|jpg|jpeg|gif|svg|webp|woff2?|ttf|css)(?:\?|$)/i.test(raw)) continue;
    const u = safeURL(raw, base);
    if (!u || u.origin !== base.origin || isPrivateHost(u.hostname)) continue;
    if (!/\/api\b|\/graphql\b|\/data\b|\/content\b|\/article\b|\/story\b|\/post\b|\/news\b|\.json(?:\?|$)/i.test(u.pathname + u.search)) continue;
    urls.add(u.href);
  }
  return [...urls].slice(0, MAX_DISCOVERED_DATA_URLS);
}

function candidateFromData(body, contentType, sourceURL) {
  const candidates = [];
  if (/json|javascript|text\//i.test(contentType) || /^[\[{]/.test(body.trim())) {
    const parsed = parseJSONSafe(body.trim());
    if (parsed) {
      const found = [];
      collectStringsByKey(parsed, ['articlebody', 'content', 'body', 'text', 'html', 'description', 'story', 'document', 'markdown'], found);
      for (const f of found) {
        const text = cleanCandidate(stripTags(f.value));
        if (text.length >= 120) candidates.push({ method: `data:${new URL(sourceURL).pathname}`, text, score: scoreText(text, '', 145), length: text.length, path: f.path });
      }
    }
  }
  if (/html|xhtml|text\/plain/i.test(contentType)) {
    const semantic = extractSemantic(body);
    for (const c of semantic) candidates.push({ ...c, method: `secondary:${c.method}` });
  }
  return candidates;
}

function pickBest(candidates) {
  const usable = candidates.filter(c => c && typeof c.text === 'string' && c.text.length >= 80);
  usable.sort((a, b) => b.score - a.score || b.length - a.length);
  const unique = [];
  const seen = new Set();
  for (const c of usable) {
    const fp = hashString(c.text.slice(0, 12000));
    if (seen.has(fp)) continue;
    seen.add(fp);
    unique.push(c);
    if (unique.length >= 12) break;
  }
  return unique;
}

function estimateConfidence(best, all, meta, structuredCount) {
  if (!best) return 0;
  let confidence = 35;
  if (best.length > 1000) confidence += 10;
  if (best.length > 5000) confidence += 10;
  if (/^(jsonld|data):/.test(best.method)) confidence += 10;
  if (/semantic:article|semantic:main/.test(best.method)) confidence += 12;
  if (meta.title && best.text.toLowerCase().includes(meta.title.slice(0, 30).toLowerCase())) confidence += 6;
  if (structuredCount > 0) confidence += 5;
  const agreement = all.filter(c => c.length > Math.min(best.length * 0.55, 2500)).length;
  confidence += clamp(agreement * 2, 0, 10);
  return clamp(Math.round(confidence), 0, 100);
}

async function secondaryFetches(pageURL, html, alternates, signalBudget) {
  const secondary = [];
  const origin = new URL(pageURL).origin;
  const candidates = [];

  // Prefer known alternate representations first.
  for (const a of alternates) {
    const u = safeURL(a.url, pageURL);
    if (u && u.origin === origin && /amp|print|mobile|json|alternate/i.test(`${a.rel} ${a.type} ${u.pathname}`)) candidates.push(u.href);
  }

  // Then JS bundles for hidden API discovery.
  const jsURLs = discoverScriptURLs(html, pageURL);
  for (const u of jsURLs) candidates.push(`__SCRIPT__${u}`);

  // Same-origin iframe fallback.
  for (const tag of extractOpeningTags(html, 'iframe').slice(0, MAX_IFRAMES)) {
    const a = parseAttributes(tag);
    const u = safeURL(a.src, pageURL);
    if (u && u.origin === origin) candidates.push(`__IFRAME__${u.href}`);
  }

  const unique = [...new Set(candidates)].slice(0, Math.max(1, signalBudget));
  const fetched = [];
  const jsBodies = [];

  await Promise.all(unique.map(async item => {
    const prefix = item.slice(0, 10);
    const realURL = item.replace(/^__SCRIPT__|^__IFRAME__/, '');
    const data = await fetchText(realURL, {
      headers: prefix === '__SCRIPT__' ? { ...COMMON_HEADERS[2], Accept: '*/*' } : COMMON_HEADERS[0],
      timeout: prefix === '__SCRIPT__' ? 4500 : 5500,
      maxBytes: prefix === '__SCRIPT__' ? 900_000 : MAX_SECONDARY_BYTES
    });
    fetched.push({ url: realURL, status: data.status, ok: data.ok, latencyMs: data.latencyMs, contentType: data.contentType });
    if (!data.ok) return;
    if (prefix === '__SCRIPT__') jsBodies.push(data.body);
    else secondary.push({ url: realURL, data });
  }));

  const discovered = new Set();
  for (const js of jsBodies) {
    for (const u of discoverDataURLs(js, pageURL)) discovered.add(u);
    if (discovered.size >= MAX_DISCOVERED_DATA_URLS) break;
  }

  // Fetch discovered same-origin data endpoints.
  const endpointList = [...discovered].slice(0, MAX_DISCOVERED_DATA_URLS);
  await Promise.all(endpointList.map(async u => {
    const data = await fetchText(u, {
      headers: { ...COMMON_HEADERS[2], Accept: 'application/json,text/plain,*/*' },
      timeout: 5500,
      maxBytes: MAX_SECONDARY_BYTES
    });
    fetched.push({ url: u, status: data.status, ok: data.ok, latencyMs: data.latencyMs, contentType: data.contentType, discoveredFromJS: true });
    if (data.ok) secondary.push({ url: u, data });
  }));

  return { secondary, fetched };
}

async function extractPage(inputURL, options = {}) {
  const started = now();
  const validation = validateTarget(inputURL);
  if (!validation.ok) return { inputURL, ok: false, error: validation.error, latencyMs: now() - started };
  const url = validation.url.href;

  // Primary request first: best balance of speed and reliability.
  let primary = await fetchText(url, {
    headers: COMMON_HEADERS[0],
    timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    maxBytes: MAX_PRIMARY_BYTES
  });

  // If the first response is clearly blocked, empty, or non-useful, retry with two different headers in parallel.
  let headerAttempts = [{ variant: 'desktop', status: primary.status, ok: primary.ok, latencyMs: primary.latencyMs, error: primary.error || null }];
  const blockedLike = !primary.ok || primary.body.length < 300 || /captcha|cf-chl-|access denied|bot detection|enable javascript/i.test(primary.body.slice(0, 30000));
  if (blockedLike) {
    const retryResults = await Promise.all(COMMON_HEADERS.slice(1).map(h => fetchText(url, { headers: h, timeout: 5500, maxBytes: MAX_PRIMARY_BYTES })));
    retryResults.forEach((r, i) => headerAttempts.push({ variant: i === 0 ? 'mobile' : 'linux', status: r.status, ok: r.ok, latencyMs: r.latencyMs, error: r.error || null }));
    const useful = [primary, ...retryResults]
      .filter(r => r.ok && r.body.length >= 300)
      .sort((a, b) => scoreRawPage(b.body) - scoreRawPage(a.body));
    if (useful[0]) primary = useful[0];
  }

  if (!primary.ok && !primary.body) {
    return {
      inputURL: url,
      ok: false,
      finalURL: primary.finalURL,
      status: primary.status,
      error: primary.error || `HTTP ${primary.status}`,
      headerAttempts,
      latencyMs: now() - started
    };
  }

  const html = primary.body;
  const finalURL = primary.finalURL || url;
  const meta = extractMeta(html);
  const semantic = extractSemantic(html);
  const jsonld = extractJSONLD(html);
  const hydration = extractHydration(html);
  const fallbacks = extractFallbacks(html);
  const initialCandidates = [...semantic, ...jsonld, ...hydration, ...fallbacks];
  const alternates = extractAlternates(html, finalURL);
  const tables = extractTables(html);
  const links = extractLinks(html, finalURL);

  let secondaryInfo = { secondary: [], fetched: [] };
  const currentBest = pickBest(initialCandidates)[0];
  const shouldExpand = options.deep !== false && (!currentBest || currentBest.length < 1200 || currentBest.score < 120 || /semantic:body/.test(currentBest.method));
  if (shouldExpand) {
    try {
      secondaryInfo = await secondaryFetches(finalURL, html, alternates, MAX_SECONDARY_REQUESTS);
    } catch (e) {
      secondaryInfo = { secondary: [], fetched: [], error: e?.message || String(e) };
    }
  }

  const secondaryCandidates = [];
  for (const item of secondaryInfo.secondary) {
    secondaryCandidates.push(...candidateFromData(item.data.body, item.data.contentType, item.url));
  }

  // Lightweight next-page recovery only when the first page looks like a listing and not already a strong article.
  const nextLinks = links.filter(l => /(?:[?&](?:page|p)=\d+|\/page\/\d+|load-more|next)/i.test(l.url) || /\bnext\b/i.test(l.text));
  if (shouldExpand && !currentBest?.length && nextLinks.length) {
    for (const l of nextLinks.slice(0, MAX_PAGINATION_PAGES)) {
      const x = await fetchText(l.url, { headers: COMMON_HEADERS[0], timeout: 4000, maxBytes: 1_000_000 });
      if (x.ok && /html/i.test(x.contentType)) secondaryCandidates.push(...extractSemantic(x.body).map(c => ({ ...c, method: `pagination:${c.method}` })));
    }
  }

  const allCandidates = [...initialCandidates, ...secondaryCandidates];
  const ranked = pickBest(allCandidates);
  const best = ranked[0] || null;
  const text = best?.text || '';
  const rawBodyText = cleanCandidate(textWithParagraphs(extractBetween(html, 'body', 'body')));

  const result = {
    inputURL: url,
    finalURL,
    ok: true,
    status: primary.status,
    contentType: primary.contentType,
    title: meta.title,
    description: meta.description,
    canonical: safeURL(meta.canonical, finalURL)?.href || meta.canonical || '',
    language: meta.lang,
    extractedText: text,
    extractedTextLength: text.length,
    extractionMethod: best?.method || 'none',
    confidence: estimateConfidence(best, ranked, meta, jsonld.length),
    tables,
    links,
    alternates,
    structuredDataCount: jsonld.length,
    candidateSummary: ranked.slice(0, 8).map(c => ({ method: c.method, score: c.score, length: c.length, path: c.path || null })),
    fetches: [
      { kind: 'primary', url, status: primary.status, latencyMs: primary.latencyMs, contentType: primary.contentType },
      ...headerAttempts.slice(1).map(a => ({ kind: 'header-retry', ...a })) ,
      ...secondaryInfo.fetched
    ],
    rawBodyTextLength: rawBodyText.length,
    latencyMs: now() - started,
    version: VERSION
  };

  if (options.includeRaw) result.rawHTML = html;
  if (options.includeBodyFallback) result.bodyFallbackText = rawBodyText;
  return result;
}

function scoreRawPage(html) {
  const len = html.length;
  const text = stripTags(html);
  let score = Math.min(50, Math.log10(Math.max(10, len)) * 8);
  if (/<article\b/i.test(html)) score += 25;
  if (/<main\b/i.test(html)) score += 20;
  if (/<p\b/i.test(html)) score += 10;
  if (len > 5000 && text.length > 800) score += 20;
  if (/captcha|access denied|bot detection/i.test(html.slice(0, 30000))) score -= 60;
  return score;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return json({ ok: true, version: VERSION });
  if (req.method !== 'POST') return json({ ok: false, error: 'Use POST.' }, 405);

  let payload;
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body.' }, 400);
  }

  const urls = Array.isArray(payload?.urls)
    ? payload.urls
    : typeof payload?.urls === 'string'
      ? payload.urls.split(/[\n,]+/).map(x => x.trim()).filter(Boolean)
      : [];

  const uniqueURLs = [...new Set(urls.map(String))].slice(0, MAX_URLS);
  if (!uniqueURLs.length) return json({ ok: false, error: 'No URLs supplied.' }, 400);

  const options = {
    deep: payload?.deep !== false,
    includeRaw: payload?.includeRaw === true,
    includeBodyFallback: payload?.includeBodyFallback === true,
    timeoutMs: clamp(Number(payload?.timeoutMs) || DEFAULT_TIMEOUT_MS, 2500, 12000)
  };

  const started = now();
  const results = await Promise.all(uniqueURLs.map(u => extractPage(u, options)));
  const okCount = results.filter(r => r.ok).length;

  return json({
    ok: true,
    version: VERSION,
    requested: uniqueURLs.length,
    succeeded: okCount,
    failed: uniqueURLs.length - okCount,
    elapsedMs: now() - started,
    mode: options.deep ? 'deep-cascade' : 'fast-cascade',
    noExternalApiKey: true,
    results
  });
}
