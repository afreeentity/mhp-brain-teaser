// Gathers headlines for the News tab of the MHP Brain Teaser app.
// Reads the RSS/Atom feeds listed in news/sources.json and writes news/news.json: for each item a
// headline, a short plain-text excerpt from the feed's own description, the outlet, the date and a
// link to the outlet's page. No article text and no images are copied.
// Run by .github/workflows/news.yml every hour; can also be run by hand:  node news/build.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const cfg = JSON.parse(readFileSync(dir + 'sources.json', 'utf8'));
const OUT = dir + 'news.json', STATE = dir + 'state.json';
// state.json remembers each feed's ETag / Last-Modified so an unchanged feed is not downloaded again.
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const MAX_AGE_DAYS = cfg.maxAgeDays ?? 10, PER_SOURCE = cfg.perSource ?? 12, MAX_ITEMS = cfg.maxItems ?? 160, EXCERPT = 220;
const skip = new RegExp(`\\b(${cfg.skipWords.join('|')})`, 'i');

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 31 && n < 0x110000 ? String.fromCodePoint(n) : ' '; }
  return ENT[e.toLowerCase()] ?? m;
});
/** Feed text to plain text: unwrap CDATA, decode entities (feeds often double-encode), drop tags. */
const plain = (s = '') => decode(decode(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (xml, names) => { for (const n of names) { const m = xml.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i')); if (m) return m[1]; } return ''; };
const cut = (s) => { if (s.length <= EXCERPT) return s; const c = s.slice(0, EXCERPT); return c.slice(0, Math.max(c.lastIndexOf(' '), EXCERPT - 40)).replace(/[\s,;:.–—-]+$/, '') + '…'; };

function parse(xml, src) {
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  return blocks.map((b) => {
    const title = plain(tag(b, ['title']));
    let link = plain(tag(b, ['link']));
    if (!/^https?:/.test(link)) link = (b.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) || b.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1] || '';
    link = decode(link).trim();
    const date = new Date(plain(tag(b, ['pubDate', 'published', 'updated', 'dc:date'])));
    let text = plain(tag(b, ['description', 'summary'])); // never the full article (content:encoded)
    if (/\b(Archive|Index|Submissions|Calendar)\b.*\b(Search|RSS)\b/.test(text)) text = ''; // page-navigation debris, not a summary
    text = text.replace(/\s*(The post .* appeared first on .*|Continue reading.*|Read more.*|\[…\]|\[\.\.\.\])\s*$/i, '').trim();
    if (text.toLowerCase().startsWith(title.toLowerCase())) text = text.slice(title.length).replace(/^[\s:.–—-]+/, '');
    return { title, link, date, text };
  }).filter((i) => i.title && /^https:\/\//.test(i.link) && !isNaN(i.date))
    .map((i) => ({ id: createHash('sha1').update(i.link).digest('hex').slice(0, 12), t: i.title.slice(0, 200), s: cut(i.text), src: src.id, topic: src.topic, d: i.date.toISOString(), u: i.link }));
}

const old = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { items: [] };
const ageOf = Object.fromEntries(cfg.sources.map((x) => [x.id, x.maxAgeDays ?? MAX_AGE_DAYS])); // slow sources may keep items longer
const now = Date.now(), fresh = (i) => now - Date.parse(i.d) < (ageOf[i.src] ?? MAX_AGE_DAYS) * 86400000 && Date.parse(i.d) < now + 3600000;
let items = [], failed = [];
for (const src of cfg.sources) {
  try {
    const st = state[src.feed] || {}, headers = { 'User-Agent': cfg.userAgent, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' };
    const had = old.items.filter((i) => i.src === src.id && i.topic === src.topic && fresh(i));
    if (had.length && st.etag) headers['If-None-Match'] = st.etag;
    if (had.length && st.modified) headers['If-Modified-Since'] = st.modified;
    const res = await fetch(src.feed, { headers, signal: AbortSignal.timeout(25000) });
    if (res.status === 304) { items.push(...had); console.log(`${(src.id + '/' + src.topic).padEnd(22)} unchanged, kept ${had.length}`); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state[src.feed] = { etag: res.headers.get('etag') || undefined, modified: res.headers.get('last-modified') || undefined };
    // Drop items with a skip word, and stories the outlet republished from someone else.
    const got = parse(await res.text(), src).filter(fresh).filter((i) => !skip.test(`${i.t} ${i.s}`) && !/originally (published|appeared)/i.test(i.s)).sort((a, b) => b.d.localeCompare(a.d)).slice(0, src.max ?? PER_SOURCE);
    if (!got.length) throw new Error('no usable items');
    items.push(...got);
    console.log(`${(src.id + '/' + src.topic).padEnd(22)} ${got.length} items, newest ${got[0].d.slice(0, 10)}`);
  } catch (e) {
    failed.push(src.feed);
    delete state[src.feed];
    const kept = old.items.filter((i) => i.src === src.id && i.topic === src.topic && fresh(i)); // one bad hour must not empty a source
    items.push(...kept);
    console.log(`${(src.id + '/' + src.topic).padEnd(22)} FAILED (${e.message}); kept ${kept.length} earlier items`);
  }
}
const seen = new Set();
items = items.filter((i) => { const k = i.t.toLowerCase().replace(/\W+/g, ''); if (seen.has(i.id) || seen.has(k)) return false; seen.add(i.id); seen.add(k); return true; })
  .sort((a, b) => b.d.localeCompare(a.d)).slice(0, MAX_ITEMS);

if (failed.length === cfg.sources.length) { console.error('every source failed; leaving news.json untouched'); process.exit(1); }
const outlets = [...new Map(cfg.sources.map(({ id, name, site }) => [id, { id, name, site }])).values()];
writeFileSync(STATE, JSON.stringify(state, null, 1));
const same = JSON.stringify(old.items) === JSON.stringify(items) && JSON.stringify(old.sources) === JSON.stringify(outlets) && JSON.stringify(old.topics) === JSON.stringify(cfg.topics);
if (same) { console.log('no change'); process.exit(0); }
writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), topics: cfg.topics, sources: outlets, items }));
console.log(`wrote ${items.length} items${failed.length ? `, ${failed.length} source(s) failed: ${failed.join(', ')}` : ''}`);
