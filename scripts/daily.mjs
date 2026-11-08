/**
 * DayLog — the once-a-day job.
 *
 * Runs on GitHub's machines, where fetching another site is unrestricted, and
 * writes one plain file next to the app:
 *
 *   gold.json  — four daily series, three years deep:
 *                  gold  24K AED per gram (Dubai retail)
 *                  btc   AED per bitcoin
 *                  inr   rupees per dirham
 *                  dxy   the dollar against six major currencies
 *
 * The app reads it from its own address: no relay, no CORS, no keys.
 * Every source below is free and unauthenticated. Each series fails on its
 * own — one dead endpoint never costs the others their update.
 */

import { readFile, writeFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const get = (url, extra = {}) =>
  fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', ...extra } });

const AED_PER_USD = 3.6725, GRAMS_PER_OZ = 31.1034768;
const YEARS = 3;
const DAY = 86400000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const today = iso(Date.now());
const since = iso(Date.now() - YEARS * 365.25 * DAY);

/** newest wins, sorted, trimmed */
function merge(rows, add, keep = 1300) {
  const map = new Map((rows || []).filter((r) => r && r.d && r.v > 0).map((r) => [r.d, r.v]));
  for (const [d, v] of add) if (v > 0 && isFinite(v)) map.set(d, round(v));
  return [...map.entries()]
    .map(([d, v]) => ({ d, v }))
    .sort((a, b) => (a.d < b.d ? -1 : 1))
    .slice(-keep);
}
const round = (v) => (v >= 1000 ? Math.round(v) : Math.round(v * 100) / 100);
const sane = (v, lo, hi) => v > lo && v < hi;

/* ------------------------------------------------------- 1. the dirham --- *
 * The ECB publishes a daily reference rate for the rupee and for every
 * currency in the dollar index, so one request covers two of the four
 * series. The dirham is pegged to the dollar at 3.6725, so rupees per
 * dirham is just the dollar rate divided by the peg.                       */

const DXY_BASKET = ['EUR', 'JPY', 'GBP', 'CAD', 'SEK', 'CHF'];

/** The published ICE formula, from rates quoted per one US dollar. */
function dxy(r) {
  const eur = 1 / r.EUR, gbp = 1 / r.GBP;         // quoted the other way round
  const v = 50.14348112 *
    Math.pow(eur, -0.576) * Math.pow(r.JPY, 0.136) * Math.pow(gbp, -0.119) *
    Math.pow(r.CAD, 0.091) * Math.pow(r.SEK, 0.042) * Math.pow(r.CHF, 0.036);
  return sane(v, 50, 200) ? Math.round(v * 100) / 100 : null;
}

async function ecbSeries() {
  const url = `https://api.frankfurter.dev/v1/${since}..${today}` +
              `?base=USD&symbols=INR,${DXY_BASKET.join(',')}`;
  const res = await get(url, { accept: 'application/json' });
  if (!res.ok) throw new Error(`frankfurter ${res.status}`);
  const rates = (await res.json()).rates || {};
  const inr = [], idx = [];
  for (const [d, r] of Object.entries(rates)) {
    if (r.INR && sane(r.INR / AED_PER_USD, 5, 100)) inr.push([d, r.INR / AED_PER_USD]);
    if (DXY_BASKET.every((c) => r[c] > 0)) {
      const v = dxy(r);
      if (v) idx.push([d, v]);
    }
  }
  return { inr, idx };
}

/** today only, when the series endpoint is down */
async function ecbLatest() {
  const res = await get(`https://open.er-api.com/v6/latest/USD`, { accept: 'application/json' });
  if (!res.ok) throw new Error(`er-api ${res.status}`);
  const r = (await res.json()).rates || {};
  const out = { inr: [], idx: [] };
  if (r.INR > 0) out.inr.push([today, r.INR / AED_PER_USD]);
  if (DXY_BASKET.every((c) => r[c] > 0)) {
    const v = dxy(r);
    if (v) out.idx.push([today, v]);
  }
  return out;
}

/* ---------------------------------------------------------- 2. bitcoin --- */

async function btcSeries() {
  /* one call covers the whole window */
  try {
    const res = await get(`https://min-api.cryptocompare.com/data/v2/histoday?fsym=BTC&tsym=USD&limit=1100`,
      { accept: 'application/json' });
    if (res.ok) {
      const rows = (await res.json())?.Data?.Data || [];
      const out = rows
        .filter((r) => r.close > 0)
        .map((r) => [iso(r.time * 1000), r.close * AED_PER_USD])
        .filter(([, v]) => sane(v, 1000, 1e8));
      if (out.length > 100) return out;
    }
  } catch (e) { console.log('btc: cryptocompare —', e.message); }

  /* Coinbase hands out 300 candles at a time, so walk back in chunks */
  try {
    const out = [];
    let end = Date.now();
    for (let page = 0; page < 5; page++) {
      const start = end - 300 * DAY;
      const u = `https://api.exchange.coinbase.com/products/BTC-USD/candles` +
                `?granularity=86400&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
      const r = await get(u, { accept: 'application/json' });
      if (!r.ok) break;
      const rows = await r.json();              // [time, low, high, open, close, volume]
      if (!Array.isArray(rows) || !rows.length) break;
      for (const c of rows) {
        const v = c[4] * AED_PER_USD;
        if (sane(v, 1000, 1e8)) out.push([iso(c[0] * 1000), v]);
      }
      end = start;
      if (new Date(end) < new Date(since)) break;
    }
    if (out.length > 100) return out;
  } catch (e) { console.log('btc: coinbase candles —', e.message); }

  /* last resort: just today */
  for (const ep of [
    { u: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=aed', pick: (j) => j?.bitcoin?.aed },
    { u: 'https://api.coinbase.com/v2/prices/BTC-USD/spot', pick: (j) => Number(j?.data?.amount) * AED_PER_USD }
  ]) {
    try {
      const r = await get(ep.u, { accept: 'application/json' });
      if (!r.ok) continue;
      const v = Number(ep.pick(await r.json()));
      if (sane(v, 1000, 1e8)) return [[today, v]];
    } catch {}
  }
  return [];
}

/* ------------------------------------------------------------- 3. gold --- *
 * Two different numbers are in play. dubaicityofgold.com publishes the
 * retail jewellery rate, which is what the app has always shown and what you
 * would actually pay; the world spot price is a few dirhams under it. Only
 * spot has years of free history, so the backbone is spot, lifted by today's
 * retail-to-spot ratio to meet the figures already recorded. Days scraped
 * for real are never overwritten by it.                                    */

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
  return sane(v, 50, 5000) ? Math.round(v * 100) / 100 : null;
}

/** today's Dubai retail rate */
async function goldRetail() {
  try {
    const res = await get('https://dubaicityofgold.com/');
    if (res.ok) {
      const v = parseGold(await res.text());
      if (v) return { v, from: 'dubaicityofgold.com' };
    }
  } catch (e) { console.log('gold: page —', e.message); }
  for (const ep of [
    { u: 'https://api.gold-api.com/price/XAU', pick: (j) => j?.price },
    { u: 'https://data-asg.goldprice.org/dbXRates/USD', pick: (j) => j?.items?.[0]?.xauPrice }
  ]) {
    try {
      const r = await get(ep.u, { accept: 'application/json' });
      if (!r.ok) continue;
      const oz = Number(ep.pick(await r.json()));
      const v = Math.round((oz * AED_PER_USD / GRAMS_PER_OZ) * 100) / 100;
      if (sane(v, 50, 5000)) return { v, from: 'spot price' };
    } catch {}
  }
  return null;
}

/** daily XAU/USD from Stooq, as AED per gram of spot */
async function goldSpotSeries() {
  const d1 = since.replace(/-/g, ''), d2 = today.replace(/-/g, '');
  const res = await get(`https://stooq.com/q/d/l/?s=xauusd&d1=${d1}&d2=${d2}&i=d`);
  if (!res.ok) throw new Error(`stooq ${res.status}`);
  const csv = await res.text();
  const lines = csv.trim().split('\n');
  if (lines.length < 50 || !/^Date/i.test(lines[0])) throw new Error('stooq gave no table');
  const out = [];
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    const close = parseFloat(c[4]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c[0]) || !(close > 0)) continue;
    const v = close * AED_PER_USD / GRAMS_PER_OZ;
    if (sane(v, 50, 5000)) out.push([c[0], v]);
  }
  return out;
}

/* ----------------------------------------------------------------- run --- */

let cur = {};
try { cur = JSON.parse(await readFile(new URL('gold.json', ROOT), 'utf8')); } catch {}
const old = cur.series || {};
const prev = (k, fallback) => (old[k]?.rows) || fallback || [];

const series = {
  gold: { unit: 'AED per gram', note: '24K, Dubai retail', rows: prev('gold', cur.history) },
  btc:  { unit: 'AED per coin', note: 'Bitcoin',           rows: prev('btc', cur.btc) },
  inr:  { unit: 'INR per AED',  note: 'Rupees per dirham', rows: prev('inr') },
  dxy:  { unit: 'index',        note: 'US dollar vs six majors', rows: prev('dxy') }
};
const sources = {};

/* --- currencies --- */
try {
  const { inr, idx } = await ecbSeries();
  series.inr.rows = merge(series.inr.rows, inr);
  series.dxy.rows = merge(series.dxy.rows, idx);
  sources.inr = sources.dxy = 'ECB via Frankfurter';
  console.log(`inr: ${inr.length} days · dxy: ${idx.length} days`);
} catch (e) {
  console.log('currencies: series failed —', e.message);
  try {
    const { inr, idx } = await ecbLatest();
    series.inr.rows = merge(series.inr.rows, inr);
    series.dxy.rows = merge(series.dxy.rows, idx);
    sources.inr = sources.dxy = 'open.er-api.com';
    console.log('currencies: today only');
  } catch (e2) { console.log('currencies: nothing today —', e2.message); }
}

/* --- bitcoin --- */
try {
  const rows = await btcSeries();
  if (rows.length) {
    series.btc.rows = merge(series.btc.rows, rows);
    sources.btc = rows.length > 100 ? 'CryptoCompare / Coinbase' : 'spot price';
    console.log(`btc: ${rows.length} days`);
  } else console.log('btc: nothing today');
} catch (e) { console.log('btc: failed —', e.message); }

/* --- gold --- */
try {
  const retail = await goldRetail();
  let spot = [];
  try { spot = await goldSpotSeries(); }
  catch (e) { console.log('gold: history —', e.message); }

  if (spot.length && retail) {
    /* line the spot history up with the rate actually being charged today */
    const latestSpot = spot[spot.length - 1][1];
    const lift = latestSpot > 0 ? retail.v / latestSpot : 1;
    const scaled = (lift > 0.8 && lift < 1.3) ? spot.map(([d, v]) => [d, v * lift]) : spot;
    if (lift <= 0.8 || lift >= 1.3) console.log(`gold: ratio ${lift.toFixed(3)} looks wrong, leaving spot unscaled`);
    else console.log(`gold: ${spot.length} days of spot lifted by ${lift.toFixed(4)}`);
    /* scaled history first, so a real scraped day always wins */
    const scraped = series.gold.rows.map((r) => [r.d, r.v]);
    series.gold.rows = merge(merge([], scaled), scraped);
  }
  if (retail) {
    series.gold.rows = merge(series.gold.rows, [[today, retail.v]]);
    sources.gold = retail.from;
    console.log(`gold: ${today} = ${retail.v} (${retail.from})`);
  } else console.log('gold: no rate today');
} catch (e) { console.log('gold: failed —', e.message); }

/* --- write --- */
const counts = Object.entries(series).map(([k, s]) => `${k} ${s.rows.length}`).join(', ');
if (!Object.keys(sources).length && !Object.values(series).some((s) => s.rows.length)) {
  console.log('nothing to write today');
} else {
  await writeFile(new URL('gold.json', ROOT),
    JSON.stringify({
      updated: today,
      usdAed: AED_PER_USD,
      sources,
      series,
      /* kept so an app that has not updated yet still finds its data */
      unit: 'AED per gram',
      purity: '24K',
      history: series.gold.rows,
      btc: series.btc.rows
    }, null, 2) + '\n');
  console.log(`gold.json: ${counts}`);
}
