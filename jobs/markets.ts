/**
 * 국제유가·환율 — 가격 수집과 같이 4시간마다 (모든 주유소 공통)
 *  - WTI·브렌트 선물, 원/달러: Yahoo Finance 차트 (키 없음). 막히면 FRED(미국 연준, 며칠 늦음)로 대신
 *  - 전국 주유소 평균 판매가: 오피넷 (1회)
 *  - 원화로 환산한 원유가 (브렌트 × 환율 ÷ 158.987L) — 국내 판매가는 보통 2~3주 뒤 따라옴
 *  → datasets: market/latest.json (회원이면 누구나 볼 수 있음, 가격 비교 권한 기준)
 */
import { join } from 'node:path';
import { env } from './lib/env.ts';
import { avgAllPrice, num, PRODUCTS } from './lib/opinet.ts';
import { readJSON, writeJSON } from './lib/store.ts';

const LITERS_PER_BARREL = 158.987;
const HISTORY_DAYS = 200;

type Key = 'wti' | 'brent' | 'usdkrw';
const SOURCES: Record<Key, { name: string; unit: string; yahoo: string; fred: string }> = {
  wti: { name: 'WTI', unit: '달러/배럴', yahoo: 'CL=F', fred: 'DCOILWTICO' },
  brent: { name: '브렌트', unit: '달러/배럴', yahoo: 'BZ=F', fred: 'DCOILBRENTEU' },
  usdkrw: { name: '원/달러', unit: '원', yahoo: 'KRW=X', fred: 'DEXKOUS' },
};

export interface Point {
  date: string;
  value: number;
}
export interface Quote {
  key: Key;
  name: string;
  unit: string;
  price: number;
  prev: number | null;
  change: number | null;
  changePct: number | null;
  asOf: string;
  source: 'yahoo' | 'fred';
  history: Point[];
}
export interface MarketLatest {
  fetchedAt: string;
  quotes: Record<Key, Quote>;
  /** 원화 환산 원유가 (브렌트, 원/L) */
  crude: { now: number; twoWeeksAgo: number | null; changePct: number | null; history: Point[] } | null;
  /** 전국 주유소 평균 판매가 (원/L) */
  domestic: { date: string; gasoline: number | null; diesel: number | null; history: Array<{ date: string; gasoline: number | null; diesel: number | null }> } | null;
  errors: string[];
}

const kstDay = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

async function fromYahoo(symbol: string): Promise<{ price: number; asOf: string; history: Point[] }> {
  let last: Error | null = null;
  for (const host of ['query1', 'query2']) {
    try {
      const res = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; oilfield-ops/1.0)', Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`Yahoo ${symbol} ${res.status}`);
      const body = (await res.json()) as {
        chart: { result?: Array<{ meta: { regularMarketPrice: number; regularMarketTime: number }; timestamp: number[]; indicators: { quote: Array<{ close: Array<number | null> }> } }> };
      };
      const r = body.chart.result?.[0];
      if (!r) throw new Error(`Yahoo ${symbol} 결과 없음`);
      const closes = r.indicators.quote[0].close;
      const byDay = new Map<string, number>();
      r.timestamp.forEach((t, i) => {
        const c = closes[i];
        if (c != null && Number.isFinite(c)) byDay.set(kstDay(t * 1000), round(c, 2));
      });
      const history = [...byDay].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
      return { price: round(r.meta.regularMarketPrice, 2), asOf: new Date(r.meta.regularMarketTime * 1000).toISOString(), history };
    } catch (e) {
      last = e as Error;
    }
  }
  throw last ?? new Error('Yahoo 실패');
}

async function fromFred(id: string): Promise<{ price: number; asOf: string; history: Point[] }> {
  const since = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
  const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${since}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`FRED ${id} ${res.status}`);
  const history = (await res.text())
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => l.split(','))
    .filter(([, v]) => v && v !== '.' && Number.isFinite(Number(v)))
    .map(([date, v]) => ({ date, value: round(Number(v), 2) }));
  const last = history.at(-1);
  if (!last) throw new Error(`FRED ${id} 데이터 없음`);
  return { price: last.value, asOf: `${last.date}T00:00:00Z`, history };
}

async function quote(key: Key, errors: string[]): Promise<Quote | null> {
  const src = SOURCES[key];
  let got: { price: number; asOf: string; history: Point[] } | null = null;
  let source: Quote['source'] = 'yahoo';
  try {
    got = await fromYahoo(src.yahoo);
  } catch (e) {
    errors.push(`${src.name} Yahoo: ${(e as Error).message}`);
    try {
      got = await fromFred(src.fred);
      source = 'fred';
    } catch (e2) {
      errors.push(`${src.name} FRED: ${(e2 as Error).message}`);
    }
  }
  if (!got) return null;
  const history = got.history.slice(-HISTORY_DAYS);
  // 전일 종가: 오늘(asOf 날짜) 이전의 마지막 종가
  const today = kstDay(new Date(got.asOf).getTime());
  const prev = [...history].reverse().find((p) => p.date < today)?.value ?? null;
  const change = prev != null ? round(got.price - prev, 2) : null;
  return {
    key,
    name: src.name,
    unit: src.unit,
    price: got.price,
    prev,
    change,
    changePct: prev ? round(((got.price - prev) / prev) * 100, 2) : null,
    asOf: got.asOf,
    source,
    history,
  };
}

/** 브렌트(달러/배럴) × 그 날(또는 직전) 환율 ÷ 158.987 = 원/L */
function crudeKrw(brent: Quote, fx: Quote): MarketLatest['crude'] {
  const rates = fx.history;
  let j = 0;
  const history: Point[] = [];
  for (const p of brent.history) {
    while (j + 1 < rates.length && rates[j + 1].date <= p.date) j++;
    if (!rates[j] || rates[j].date > p.date) continue;
    history.push({ date: p.date, value: Math.round((p.value * rates[j].value) / LITERS_PER_BARREL) });
  }
  const now = Math.round((brent.price * fx.price) / LITERS_PER_BARREL);
  const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
  const twoWeeksAgo = [...history].reverse().find((p) => p.date <= cutoff)?.value ?? null;
  return { now, twoWeeksAgo, changePct: twoWeeksAgo ? round(((now - twoWeeksAgo) / twoWeeksAgo) * 100, 1) : null, history: history.slice(-HISTORY_DAYS) };
}

async function main() {
  const path = join(env.dataDir, 'market', 'latest.json');
  const prev = await readJSON<MarketLatest | null>(path, null);
  const errors: string[] = [];

  const [wti, brent, usdkrw] = await Promise.all([quote('wti', errors), quote('brent', errors), quote('usdkrw', errors)]);
  // 하나라도 못 받으면 직전 값을 유지
  const quotes = {
    wti: wti ?? prev?.quotes.wti,
    brent: brent ?? prev?.quotes.brent,
    usdkrw: usdkrw ?? prev?.quotes.usdkrw,
  };
  if (!quotes.wti || !quotes.brent || !quotes.usdkrw) throw new Error(`국제유가·환율을 받지 못했습니다: ${errors.join(' / ')}`);

  // 전국 평균 판매가
  let domestic = prev?.domestic ?? null;
  if (env.opinetKey) {
    try {
      const list = await avgAllPrice();
      const pick = (code: string) => num(list.find((x) => x.PRODCD === code)?.PRICE);
      const raw = list.find((x) => x.PRODCD === PRODUCTS.gasoline)?.TRADE_DT ?? '';
      const date = /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}` : kstDay(Date.now());
      const today = { date, gasoline: pick(PRODUCTS.gasoline), diesel: pick(PRODUCTS.diesel) };
      const history = [...(domestic?.history ?? []).filter((h) => h.date !== date), today].sort((a, b) => a.date.localeCompare(b.date)).slice(-HISTORY_DAYS);
      domestic = { ...today, history };
    } catch (e) {
      errors.push(`전국 평균: ${(e as Error).message}`);
    }
  }

  const latest: MarketLatest = {
    fetchedAt: new Date().toISOString(),
    quotes: quotes as Record<Key, Quote>,
    crude: crudeKrw(quotes.brent, quotes.usdkrw),
    domestic,
    errors,
  };
  await writeJSON(path, latest);
  for (const q of Object.values(latest.quotes)) {
    console.log(`[market] ${q.name} ${q.price} (${q.changePct ?? '-'}%, ${q.source}, ${q.asOf.slice(0, 16)})`);
  }
  console.log(`[market] 원화 환산 브렌트 ${latest.crude?.now}원/L (2주 전 대비 ${latest.crude?.changePct ?? '-'}%), 전국 평균 휘발유 ${domestic?.gasoline ?? '-'} 경유 ${domestic?.diesel ?? '-'}`);
  errors.forEach((e) => console.warn(`[market] 경고: ${e}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
