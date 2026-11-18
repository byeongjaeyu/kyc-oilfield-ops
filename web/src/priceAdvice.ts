// 오늘의 추천 판매가 — 주변 가격, 우리 평소 위치, 국제유가 흐름, 매입가·카드 수수료를 모아 한 값으로
import type { Fuel, MarketLatest, PriceHistoryEntry, PriceLatest } from './types';

export interface AdviceInput {
  fuel: Fuel;
  latest: PriceLatest;
  history: PriceHistoryEntry[];
  market: MarketLatest | null;
  /** 가장 최근 매입 단가 (부가세 포함 원/L) */
  cost: number;
  costDate: string;
  feePct: number;
  /** 매출 중 카드 비중 0~1. 마감 기록이 없으면 null (전부 카드로 봄) */
  cardShare: number | null;
  /** 최근 하루 평균 판매량(L). 모르면 null */
  litersPerDay: number | null;
}

export interface Unit {
  price: number;
  cost: number;
  fee: number;
  net: number;
}

export interface Advice {
  fuel: Fuel;
  ours: number | null;
  price: number;
  action: 'up' | 'down' | 'hold';
  delta: number;
  reasons: string[];
  cautions: string[];
  breakEven: number;
  unit: Unit;
  unitNow: Unit | null;
  litersPerDay: number | null;
  /** 올릴 때: 판매량이 이만큼(%) 넘게 줄지 않으면 이익 / 내릴 때: 이만큼 이상 늘어야 이익 */
  volumeBreakEvenPct: number | null;
  rank: { now: number | null; next: number; total: number };
  avg: number | null;
  /** 다음 입고 때 예상 매입가 변화 (원/L) */
  costDrift: number | null;
}

const MAX_STEP = 30; // 하루에 이보다 크게 바꾸면 손님이 민감
const HOLD_BAND = 5; // 이보다 작은 차이는 그대로 둠
const won = (v: number) => `${Math.round(v).toLocaleString('ko-KR')}원`;
/** 받침 있으면 a, 없으면 b (은/는, 이/가) */
const josa = (word: string, a: string, b: string) => {
  const c = word.trim().charCodeAt(word.trim().length - 1);
  if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 ? a : b;
  return /[013678lmnr]$/i.test(word.trim()) ? a : b;
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function unitOf(price: number, cost: number, feePct: number, cardShare: number | null): Unit {
  const fee = (price * feePct * (cardShare ?? 1)) / 100;
  return { price, cost, fee, net: price - cost - fee };
}

export function advise(x: AdviceInput): Advice | null {
  const { fuel, latest, history, market, cost, feePct, cardShare } = x;
  const others = latest.neighbors
    .filter((n) => n[fuel] != null)
    .map((n) => ({ name: n.name, km: n.distanceKm, price: n[fuel]! }))
    .sort((a, b) => a.km - b.km);
  if (!others.length) return null;
  const ours = latest.stats[fuel].ours;
  const avg = others.reduce((s, o) => s + o.price, 0) / others.length;
  const reasons: string[] = [];
  const cautions: string[] = [];

  // 1) 주변 가격
  const near = others[0];
  const min = Math.min(...others.map((o) => o.price));
  reasons.push(
    `반경 ${latest.radiusKm}km ${others.length}곳 평균 ${won(avg)}, 가장 싼 곳 ${won(min)}. 가장 가까운 ${near.name}(${near.km}km)${josa(near.name, '은', '는')} ${won(near.price)}입니다.`,
  );

  // 2) 우리가 평소 서 있던 자리 (평균 대비)
  const recent = history.filter((h) => h[fuel].ours != null && h[fuel].avg != null).slice(-30);
  const gaps = recent.map((h) => h[fuel].ours! - h[fuel].avg!);
  let gap: number;
  if (gaps.length >= 5) {
    gap = median(gaps);
    reasons.push(
      `최근 ${gaps.length}일 동안 우리는 평균보다 보통 ${Math.abs(Math.round(gap)) < 1 ? '같은 값' : `${won(Math.abs(gap))} ${gap < 0 ? '쌌' : '비쌌'}`}습니다. 손님이 익숙한 그 위치를 기준으로 잡았습니다.`,
    );
    if (ours != null && Math.abs(ours - avg - gap) >= 15) {
      const off = ours - avg - gap;
      reasons.push(`지금은 그 위치보다 ${won(Math.abs(off))} ${off > 0 ? '비싸게' : '싸게'} 서 있습니다.`);
    }
  } else {
    gap = ours != null ? ours - avg : 0;
    if (ours != null) reasons.push(`가격 기록이 아직 짧아 지금 위치(평균보다 ${won(Math.abs(gap))} ${gap <= 0 ? '쌈' : '비쌈'})를 기준으로 잡았습니다.`);
  }

  // 3) 경쟁사 움직임 (최근 3일)
  const past = [...history].reverse().find((h) => h.date <= shiftDay(latest.date, -3) && h[fuel].avg != null);
  const compMove = past ? avg - past[fuel].avg! : null;
  if (compMove != null && Math.abs(compMove) >= 3) reasons.push(`주변 평균이 3일 새 ${compMove > 0 ? '+' : '−'}${won(Math.abs(compMove))} 움직였습니다.`);

  // 4) 국제유가 → 다음 입고 매입가 흐름 (원화 환산 브렌트 2주 변화, 부가세 포함)
  let lean = 0;
  let costDrift: number | null = null;
  const c = market?.crude;
  if (c?.twoWeeksAgo != null) {
    costDrift = (c.now - c.twoWeeksAgo) * 1.1;
    const pct = c.changePct ?? 0;
    if (costDrift >= 15) {
      // 아직 주변이 다 따라 올리지 않았으면 절반만 먼저 반영
      const already = Math.max(0, compMove ?? 0);
      lean = Math.max(0, Math.round(costDrift / 2 - already));
      reasons.push(
        `국제유가(원화 환산)가 2주 새 ${pct > 0 ? '+' : ''}${pct}%, L당 약 ${won(costDrift)} 올랐습니다. 1~2주 뒤 공급가가 오를 수 있어${lean > 0 ? ` ${won(lean)}을 미리 반영했습니다.` : ' 주변이 이미 올려 따로 더하지 않았습니다.'}`,
      );
    } else if (costDrift <= -15) {
      reasons.push(`국제유가가 2주 새 ${pct}% 내렸습니다(L당 약 ${won(-costDrift)}). 지금 탱크 기름은 예전 값에 샀으니 먼저 내리기보다 주변을 보고 따라가는 편이 낫습니다.`);
    } else {
      reasons.push(`국제유가는 2주 새 ${pct > 0 ? '+' : ''}${pct}%로 큰 변화가 없습니다.`);
    }
  }

  // 5) 손익분기
  const eff = (feePct / 100) * (cardShare ?? 1);
  const breakEven = cost / (1 - eff);

  let target = avg + gap + lean;
  let floorHit = false;
  if (target < breakEven + 1) {
    target = Math.ceil(breakEven) + 1;
    floorHit = true;
  }
  // 하루 변화폭 제한
  if (ours != null && Math.abs(target - ours) > MAX_STEP && !floorHit) {
    const want = target;
    target = ours + Math.sign(target - ours) * MAX_STEP;
    cautions.push(`계산상으로는 ${won(want)}이지만 하루에 ${MAX_STEP}원 넘게 바꾸면 손님이 민감해서 ${MAX_STEP}원만 움직였습니다. 며칠에 나눠 맞추세요.`);
  }
  // 경쟁사와 3원 안쪽이면 같은 값으로 (같은 값이면 같은 순위)
  const tie = others.find((o) => Math.abs(o.price - target) <= 3);
  if (tie) target = tie.price;
  let price = Math.round(target);
  if (ours != null && Math.abs(price - ours) <= HOLD_BAND && !floorHit) price = ours;
  if (price < breakEven) price = Math.ceil(breakEven) + 1;

  if (floorHit) cautions.push(`주변 가격대로 가면 매입가(${won(cost)}, ${x.costDate.slice(5).replace('-', '/')} 입고)와 카드 수수료를 못 건집니다. 손해 보지 않는 가장 낮은 값으로 잡았습니다.`);
  if (latest.date !== todayKst()) cautions.push(`주변 가격은 ${latest.date.slice(5).replace('-', '/')} 오피넷 기준입니다.`);
  if (cardShare == null) cautions.push('일 마감을 넣지 않아 매출 전부를 카드로 보고 수수료를 계산했습니다.');

  const rankAt = (p: number) => others.filter((o) => o.price < p).length + 1;
  const unit = unitOf(price, cost, feePct, cardShare);
  const unitNow = ours != null ? unitOf(ours, cost, feePct, cardShare) : null;
  const delta = ours != null ? price - ours : 0;
  const action: Advice['action'] = ours == null || delta === 0 ? 'hold' : delta > 0 ? 'up' : 'down';

  let volumeBreakEvenPct: number | null = null;
  if (unitNow && unit.net > 0 && unitNow.net > 0 && action !== 'hold') {
    volumeBreakEvenPct = action === 'up' ? (1 - unitNow.net / unit.net) * 100 : (unitNow.net / unit.net - 1) * 100;
  }

  return {
    fuel,
    ours,
    price,
    action,
    delta,
    reasons,
    cautions,
    breakEven,
    unit,
    unitNow,
    litersPerDay: x.litersPerDay,
    volumeBreakEvenPct,
    rank: { now: ours != null ? rankAt(ours) : null, next: rankAt(price), total: others.length + 1 },
    avg,
    costDrift,
  };
}

function shiftDay(d: string, k: number) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + k);
  return t.toISOString().slice(0, 10);
}
const todayKst = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
