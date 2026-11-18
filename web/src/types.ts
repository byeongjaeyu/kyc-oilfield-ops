// jobs/policy-weekly.ts 의 타입과 동일하게 유지
export interface PolicyItem {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  category: string;
  summary: string;
  impact: string;
  importance: 1 | 2 | 3;
}

export interface PolicyReport {
  week: string;
  generatedAt: string;
  period: { from: string; to: string };
  mode: 'ai' | 'raw';
  provider: string;
  headline: string;
  items: PolicyItem[];
  watch: string[];
  stats: { collected: number; selected: number; errors: number };
}

export interface PolicyIndexEntry {
  week: string;
  file: string;
  generatedAt: string;
  headline: string;
  count: number;
}

// jobs/prices-daily.ts 와 동일하게 유지
export type Fuel = 'gasoline' | 'diesel';

export interface FuelStats {
  ours: number | null;
  avg: number | null;
  min: number | null;
  max?: number | null;
  n: number;
  rank: number | null;
  diffAvg: number | null;
}

export interface Neighbor {
  id: string;
  name: string;
  brand: string;
  distanceKm: number;
  gasoline: number | null;
  diesel: number | null;
}

export interface PriceLatest {
  date: string;
  fetchedAt: string;
  radiusKm: number;
  station: { id: string; name: string; brand: string; address: string };
  stats: Record<Fuel, FuelStats>;
  neighbors: Neighbor[];
  changes: { added: string[]; removed: string[] };
  alertKeys?: string[];
}

export interface PriceHistoryEntry {
  date: string;
  gasoline: FuelStats;
  diesel: FuelStats;
}

// jobs/land-weekly.ts 와 동일하게 유지
export interface LandAgg {
  n: number;
  median: number | null;
}

export interface LandTrade {
  id: string;
  date: string;
  dong: string;
  jibun: string;
  jimok: string;
  landUse: string;
  areaM2: number;
  amountMan: number;
  wonPerM2: number;
  share: boolean;
  dealType: string;
}

export interface LandLatest {
  /** 시·군·구 이름 (옛 데이터에는 없음) */
  region?: string;
  generatedAt: string;
  week: string;
  ourDong: string;
  nearbyDongs: string[];
  months: Array<{ ym: string; gwangsan: LandAgg; nearby: LandAgg }>;
  recent: { months: number; gwangsan: LandAgg; nearby: LandAgg; ourDong: LandAgg };
  notable: LandTrade[];
  news: { mode: 'ai' | 'raw'; headline: string; items: PolicyItem[]; collected: number };
  warnings: string[];
}

// ── 국제유가·환율 (jobs/markets.ts → market/latest.json) ──
export type MarketKey = 'wti' | 'brent' | 'usdkrw';
export interface MarketPoint {
  date: string;
  value: number;
}
export interface MarketQuote {
  key: MarketKey;
  name: string;
  unit: string;
  price: number;
  prev: number | null;
  change: number | null;
  changePct: number | null;
  asOf: string;
  source: 'yahoo' | 'fred';
  history: MarketPoint[];
}
export interface MarketLatest {
  fetchedAt: string;
  quotes: Record<MarketKey, MarketQuote>;
  crude: { now: number; twoWeeksAgo: number | null; changePct: number | null; history: MarketPoint[] } | null;
  domestic: {
    date: string;
    gasoline: number | null;
    diesel: number | null;
    history: Array<{ date: string; gasoline: number | null; diesel: number | null }>;
  } | null;
  errors: string[];
}
