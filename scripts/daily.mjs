/**
 * DayLog — the once-a-day job.
 *
 * Runs on GitHub's machines, where fetching another site is unrestricted, and
 * writes two plain files next to the app:
 *
 *   news.json  — recent posts from the sources listed in news-sources.json
 *   gold.json  — 24K AED/gram, appended to whatever history is already there
 *
 * The app then reads those from its own address: no relay, no CORS, no keys.
 */

import { readFile, writeFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

const get = (url, extra = {}) =>
  fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', ...extra } });

/* ---------------------------------------------------------------- news --- */

const NEWS_KEEP_DAYS = 45;
const PER_SOURCE = 8;

function strip(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? strip(m[1]) : '';
};

/** A channel URL or @handle -> the UC… id YouTube's feed needs. */
async function resolveChannel(input) {
  const direct = input.match(/(UC[\w-]{22})/);
  if (direct) return direct[1];
  const url = /^https?:\/\//.test(input)
    ? input
    : `https://www.youtube.com/${input.startsWith('@') ? input : '@' + input}`;
  const res = await get(url);
  if (!res.ok) throw new Error(`channel lookup ${res.status}`);
  const html = await res.text();
  const m = html.match(/"channelId":"(UC[\w-]{22})"/) ||
            html.match(/channel\/(UC[\w-]{22})/);
  if (!m) throw new Error('could not find the channel id');
  return m[1];
}

function parseFeed(xml, label) {
  const out = [];
  const atom = xml.includes('<entry');
  const blocks = atom ? xml.split(/<entry[\s>]/).slice(1) : xml.split(/<item[\s>]/).slice(1);
  for (const b of blocks.slice(0, PER_SOURCE)) {
    const title = tag(b, 'title');
    if (!title) continue;
    const lm = b.match(/<link[^>]*href="([^"]+)"/) || b.match(/<link>([\s\S]*?)<\/link>/);
    const when = tag(b, 'published') || tag(b, 'pubDate') || tag(b, 'updated');
    const t = when ? new Date(when) : new Date();
    const th = (b.match(/<media:thumbnail[^>]*url="([^"]+)"/) || [])[1] || '';
    const by = tag(b, 'name') || tag(b, 'source') || label;
    let blurb = tag(b, 'media:description') || tag(b, 'description') || '';
    blurb = blurb.replace(/^\s*(Your browser|Watch on)[\s\S]*$/i, '').slice(0, 220);
    out.push({
      title,
      url: lm ? strip(lm[1]) : '',
      by: by || label,
      th,
      at: (isNaN(t) ? new Date() : t).toISOString(),
      src: label,
      blurb
    });
  }
  return out;
}

async function buildNews() {
  let cfg;
  try {
    cfg = JSON.parse(await readFile(new URL('news-sources.json', ROOT), 'utf8'));
  } catch {
    console.log('news: no news-sources.json, skipping');
    return;
  }
  const sources = [];
  const items = [];

  for (const ch of cfg.youtube || []) {
    const label = ch.name || ch.url || ch.id;
    try {
      const id = await resolveChannel(ch.id || ch.url || ch.name);
      const res = await get(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`);
      if (!res.ok) throw new Error(`feed ${res.status}`);
      const got = parseFeed(await res.text(), label);
      items.push(...got);
      sources.push({ label, kind: 'yt', ok: got.length });
      console.log(`news: ${label} -> ${got.length}`);
    } catch (e) {
      sources.push({ label, kind: 'yt', ok: 0, error: e.message });
      console.log(`news: ${label} failed — ${e.message}`);
    }
  }

  for (const name of cfg.names || []) {
    try {
      const q = encodeURIComponent(`"${name}"`);
      const res = await get(`https://news.google.com/rss/search?q=${q}&hl=en&gl=AE&ceid=AE:en`);
      if (!res.ok) throw new Error(`feed ${res.status}`);
      const got = parseFeed(await res.text(), name);
      items.push(...got);
      sources.push({ label: name, kind: 'name', ok: got.length });
      console.log(`news: ${name} -> ${got.length}`);
    } catch (e) {
      sources.push({ label: name, kind: 'name', ok: 0, error: e.message });
      console.log(`news: ${name} failed — ${e.message}`);
    }
  }

  const cutoff = Date.now() - NEWS_KEEP_DAYS * 86400000;
  const fresh = items
    .filter((i) => new Date(i.at).getTime() >= cutoff)
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 150);

  await writeFile(new URL('news.json', ROOT),
    JSON.stringify({ updated: new Date().toISOString(), sources, items: fresh }, null, 2) + '\n');
  console.log(`news.json: ${fresh.length} items from ${sources.length} sources`);
}

/* ---------------------------------------------------------------- gold --- */

const AED_PER_USD = 3.6725, GRAMS_PER_OZ = 31.1034768;
const MINV = 50, MAXV = 5000;

function parseGold(html) {
  const text = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/,/g, '')
    .replace(/\s+/g, ' ');
  const m = text.match(/24\s*[Kk](?:\s*(?:Gold|Carat))?[^0-9]{0,40}?(\d{3}(?:\.\d{1,2})?)/) ||
            text.match(/(\d{3}(?:\.\d{1,2})?)[^0-9]{0,20}?24\s*[Kk]/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return v >= MINV && v <= MAXV ? Math.round(v * 100) / 100 : null;
}

async function buildGold() {
  let rate = null, from = '';
  try {
    const res = await get('https://dubaicityofgold.com/');
    if (res.ok) { rate = parseGold(await res.text()); from = 'dubaicityofgold.com'; }
  } catch (e) { console.log('gold: page failed —', e.message); }

  if (!rate) {
    for (const ep of [
      { u: 'https://api.gold-api.com/price/XAU', pick: (j) => j && j.price },
      { u: 'https://data-asg.goldprice.org/dbXRates/USD', pick: (j) => j?.items?.[0]?.xauPrice }
    ]) {
      try {
        const r = await get(ep.u, { accept: 'application/json' });
        if (!r.ok) continue;
        const oz = Number(ep.pick(await r.json()));
        if (!oz || !isFinite(oz)) continue;
        const v = Math.round((oz * AED_PER_USD / GRAMS_PER_OZ) * 100) / 100;
        if (v >= MINV && v <= MAXV) { rate = v; from = 'spot price'; break; }
      } catch {}
    }
  }
  if (!rate) { console.log('gold: no rate today, leaving the file alone'); return; }

  let cur = { history: [] };
  try { cur = JSON.parse(await readFile(new URL('gold.json', ROOT), 'utf8')); } catch {}
  const map = new Map((cur.history || []).map((r) => [r.d, r.v]));
  const today = new Date().toISOString().slice(0, 10);
  map.set(today, rate);
  const history = [...map.entries()]
    .map(([d, v]) => ({ d, v }))
    .sort((a, b) => (a.d < b.d ? -1 : 1))
    .slice(-1200);

  await writeFile(new URL('gold.json', ROOT),
    JSON.stringify({ unit: 'AED per gram', purity: '24K', source: from,
      updated: today, history }, null, 2) + '\n');
  console.log(`gold.json: ${today} = ${rate} (${from}), ${history.length} rows`);
}

/* ----------------------------------------------------------------- run --- */

const results = await Promise.allSettled([buildNews(), buildGold()]);
results.forEach((r) => { if (r.status === 'rejected') console.log('task failed:', r.reason?.message || r.reason); });
