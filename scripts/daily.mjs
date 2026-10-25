/**
 * DayLog — the once-a-day job.
 *
 * Runs on GitHub's machines, where fetching another site is unrestricted, and
 * writes one plain file next to the app:
 *
 *   gold.json  — 24K AED/gram and bitcoin in AED, appended to the history
 *                that is already there
 *
 * The app then reads it from its own address: no relay, no CORS, no keys.
 */

import { readFile, writeFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

const get = (url, extra = {}) =>
  fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', ...extra } });

const AED_PER_USD = 3.6725, GRAMS_PER_OZ = 31.1034768;
const today = () => new Date().toISOString().slice(0, 10);

/** Merge rows into a history, newest wins, oldest trimmed. */
function merge(history, rows, keep = 1200) {
  const map = new Map((history || []).map((r) => [r.d, r.v]));
  for (const [d, v] of rows) if (v > 0) map.set(d, v);
  return [...map.entries()]
    .map(([d, v]) => ({ d, v }))
    .sort((a, b) => (a.d < b.d ? -1 : 1))
    .slice(-keep);
}

/* ---------------------------------------------------------------- gold --- */

const GOLD_MIN = 50, GOLD_MAX = 5000;

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
  return v >= GOLD_MIN && v <= GOLD_MAX ? Math.round(v * 100) / 100 : null;
}

async function goldRate() {
  try {
    const res = await get('https://dubaicityofgold.com/');
    if (res.ok) {
      const v = parseGold(await res.text());
      if (v) return { v, from: 'dubaicityofgold.com' };
    }
  } catch (e) { console.log('gold: page failed —', e.message); }

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
      if (v >= GOLD_MIN && v <= GOLD_MAX) return { v, from: 'spot price' };
    } catch {}
  }
  return null;
}

/* ------------------------------------------------------------- bitcoin --- */

const BTC_MIN = 1000, BTC_MAX = 100000000;
const sane = (v) => v >= BTC_MIN && v <= BTC_MAX;

async function btcRate() {
  /* CoinGecko quotes dirhams directly, so there is no conversion to get wrong */
  try {
    const r = await get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=aed',
      { accept: 'application/json' });
    if (r.ok) {
      const v = Math.round(Number((await r.json())?.bitcoin?.aed));
      if (sane(v)) return { v, from: 'CoinGecko' };
    }
  } catch (e) { console.log('btc: coingecko failed —', e.message); }

  for (const ep of [
    { u: 'https://api.coinbase.com/v2/prices/BTC-USD/spot', pick: (j) => j?.data?.amount },
    { u: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD', pick: (j) => Object.values(j?.result || {})[0]?.c?.[0] }
  ]) {
    try {
      const r = await get(ep.u, { accept: 'application/json' });
      if (!r.ok) continue;
      const usd = Number(ep.pick(await r.json()));
      if (!usd || !isFinite(usd)) continue;
      const v = Math.round(usd * AED_PER_USD);
      if (sane(v)) return { v, from: 'spot price' };
    } catch {}
  }
  return null;
}

/** One call gets a year of daily closes, so the chart is useful from day one
 *  rather than growing a pixel at a time. Only worth doing once. */
async function btcBackfill() {
  try {
    const r = await get('https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=aed&days=365',
      { accept: 'application/json' });
    if (!r.ok) throw new Error(`backfill ${r.status}`);
    const prices = (await r.json())?.prices || [];
    const byDay = new Map();
    for (const [ms, v] of prices) {
      const d = new Date(ms).toISOString().slice(0, 10);
      const n = Math.round(Number(v));
      if (sane(n)) byDay.set(d, n);          // last reading of each day wins
    }
    console.log(`btc: backfilled ${byDay.size} days`);
    return [...byDay.entries()];
  } catch (e) {
    console.log('btc: backfill failed —', e.message);
    return [];
  }
}

/* ----------------------------------------------------------------- run --- */

let cur = {};
try { cur = JSON.parse(await readFile(new URL('gold.json', ROOT), 'utf8')); } catch {}

const d = today();
const [gold, btc] = await Promise.all([goldRate(), btcRate()]);

let goldHistory = cur.history || [];
if (gold) {
  goldHistory = merge(goldHistory, [[d, gold.v]]);
  console.log(`gold: ${d} = ${gold.v} (${gold.from})`);
} else {
  console.log('gold: no rate today, leaving it alone');
}

let btcHistory = cur.btc || [];
const rows = [];
/* a thin history means this is the first run — fetch the back year too */
if (btcHistory.length < 300) rows.push(...await btcBackfill());
if (btc) {
  rows.push([d, btc.v]);
  console.log(`btc: ${d} = ${btc.v} (${btc.from})`);
} else {
  console.log('btc: no price today, leaving it alone');
}
if (rows.length) btcHistory = merge(btcHistory, rows);

if (!gold && !btc && !rows.length) {
  console.log('nothing to write today');
} else {
  await writeFile(new URL('gold.json', ROOT),
    JSON.stringify({
      unit: 'AED per gram',
      purity: '24K',
      btcUnit: 'AED per bitcoin',
      source: gold ? gold.from : (cur.source || ''),
      btcSource: btc ? btc.from : (cur.btcSource || ''),
      updated: d,
      history: goldHistory,
      btc: btcHistory
    }, null, 2) + '\n');
  console.log(`gold.json: ${goldHistory.length} gold rows, ${btcHistory.length} btc rows`);
}
