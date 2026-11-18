/**
 * #4 경쟁 주유소 가격 — 4시간마다, 승인된 주유소별로
 *  1) 주유소의 오피넷 ID·좌표 (stations 테이블, 등록 신청 때 오피넷 검색으로 들어옴)
 *  2) 반경 5km 휘발유·경유 가격 수집 — 같은 오피넷 주유소(데모 등)는 한 번만 받아 같이 씀
 *  3) 평균·최저·순위 계산 → st/<주유소>/prices/latest.json, history.json
 *  4) 경쟁력 하락·주유소 신규/폐업 시에만 그 주유소 텔레그램으로 알림
 */
import { join } from 'node:path';
import { ALERT, CACHE, HISTORY_DAYS, RADIUS_M } from './config/prices.ts';
import { kstDate } from './lib/date.ts';
import { env } from './lib/env.ts';
import {
  aroundAll,
  BRANDS,
  callsUsed,
  detailById,
  BudgetExceededError,
  num,
  PRODUCTS,
  setCallBudget,
  type Fuel,
  type OpinetStation,
} from './lib/opinet.ts';
import { approvedStations, chatIdFor, groupBy, stationDir, type StationRow } from './lib/stations.ts';
import { readJSON, writeJSON } from './lib/store.ts';
import { rest, supabaseEnabled } from './lib/supabase.ts';
import { escapeHtml, sendTelegram } from './lib/telegram.ts';

const FUELS: Fuel[] = ['gasoline', 'diesel'];
const FUEL_KO: Record<Fuel, string> = { gasoline: '휘발유', diesel: '경유' };

export interface Station {
  id: string;
  name: string;
  brand: string;
  address: string;
  x: number;
  y: number;
}

export interface Neighbor {
  id: string;
  name: string;
  brand: string;
  distanceKm: number;
  gasoline: number | null;
  diesel: number | null;
}

export interface FuelStats {
  ours: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  /** 반경 내 판매 주유소 수 (우리 제외) */
  n: number;
  /** 1 = 가장 쌈. 우리 포함 n+1 곳 중 */
  rank: number | null;
  diffAvg: number | null;
}

export interface PriceLatest {
  date: string;
  fetchedAt: string;
  radiusKm: number;
  station: Pick<Station, 'id' | 'name' | 'brand' | 'address'>;
  stats: Record<Fuel, FuelStats>;
  neighbors: Neighbor[];
  changes: { added: string[]; removed: string[] };
  /** 지금 켜져 있는 알림 조건. 4시간마다 돌면서 같은 알림을 반복하지 않도록 직전 실행과 비교 */
  alertKeys: string[];
}

interface Usage {
  date: string;
  calls: number;
  runs: number;
}

export interface PriceHistoryEntry {
  date: string;
  gasoline: Omit<FuelStats, 'max'>;
  diesel: Omit<FuelStats, 'max'>;
}

const brandName = (code?: string) => (code ? BRANDS[code] ?? code : '');
const addressOf = (s: OpinetStation) => s.NEW_ADR || s.VAN_ADR || '';

/** 주유소 행의 오피넷 정보. 좌표가 비어 있으면 상세 조회로 채우고 DB 에도 저장 */
async function resolveStation(row: StationRow): Promise<Station> {
  let x = num(row.katec_x);
  let y = num(row.katec_y);
  let { name, brand, address } = row;
  if (x == null || y == null) {
    const d = await detailById(row.opinet_id!);
    if (!d) throw new Error(`오피넷 ID ${row.opinet_id} 를 찾지 못했습니다 (${row.name}).`);
    x = num(d.GIS_X_COOR);
    y = num(d.GIS_Y_COOR);
    if (x == null || y == null) throw new Error(`${d.OS_NM} 의 좌표를 받지 못했습니다.`);
    brand ||= brandName(d.POLL_DIV_CD);
    address ||= addressOf(d);
    if (supabaseEnabled()) {
      await rest(`stations?opinet_id=eq.${encodeURIComponent(row.opinet_id!)}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: JSON.stringify({ katec_x: x, katec_y: y, brand }),
      });
    }
    name = d.OS_NM || name;
  }
  return { id: row.opinet_id!, name, brand, address, x, y };
}

function statsFor(ours: number | null, prices: number[]): FuelStats {
  const n = prices.length;
  if (n === 0) return { ours, avg: null, min: null, max: null, n, rank: null, diffAvg: null };
  const avg = Math.round(prices.reduce((a, b) => a + b, 0) / n);
  return {
    ours,
    avg,
    min: Math.min(...prices),
    max: Math.max(...prices),
    n,
    rank: ours == null ? null : prices.filter((p) => p < ours).length + 1,
    diffAvg: ours == null ? null : ours - avg,
  };
}

const won = (n: number) => `${n.toLocaleString('ko-KR')}원`;

interface Alert {
  key: string;
  text: string;
}

function buildAlerts(latest: Omit<PriceLatest, 'alertKeys'>, prev: PriceHistoryEntry | undefined): Alert[] {
  const alerts: Alert[] = [];
  for (const fuel of FUELS) {
    const s = latest.stats[fuel];
    if (s.ours == null) {
      alerts.push({ key: `missing:${fuel}`, text: `${FUEL_KO[fuel]}: 우리 주유소 가격이 오피넷에 없습니다 (미보고 또는 휴업).` });
      continue;
    }
    if (s.diffAvg != null && s.diffAvg >= ALERT.aboveAvgWon) {
      const pos = s.rank === s.n + 1 ? '가장 비쌈' : `${s.rank}번째로 쌈`;
      alerts.push({
        key: `above:${fuel}`,
        text: `${FUEL_KO[fuel]} ${won(s.ours)} — 반경 평균보다 ${won(s.diffAvg)} 비쌉니다 (${s.n + 1}곳 중 ${pos}).`,
      });
    }
    // 전날 마지막 수집과 비교
    const before = prev?.[fuel].rank;
    if (s.rank != null && before != null && s.rank - before >= ALERT.rankDrop) {
      alerts.push({
        key: `rank:${fuel}:${latest.date}:${s.rank}`,
        text: `${FUEL_KO[fuel]} 가격 순위가 어제 ${before}위에서 ${s.rank}위로 밀렸습니다.`,
      });
    }
  }
  if (ALERT.stationChange) {
    for (const name of latest.changes.added) alerts.push({ key: `added:${name}`, text: `반경 안에 새로 잡힌 주유소: ${name}` });
    for (const name of latest.changes.removed) alerts.push({ key: `removed:${name}`, text: `반경에서 사라진 주유소: ${name}` });
  }
  return alerts;
}

async function main() {
  const now = new Date();
  const today = kstDate(now);
  const stations = (await approvedStations()).filter((st) => st.opinet_id);
  const groups = groupBy(stations, (st) => st.opinet_id);
  console.log(`[prices] 주유소 ${stations.length}곳, 오피넷 수집 ${groups.size}곳`);

  // 하루 호출 예산 (오피넷 키 하나를 모든 주유소가 나눠 씀)
  const usagePath = join(env.dataDir, 'sys', 'opinet-usage.json');
  const stored = await readJSON<Usage | null>(usagePath, null);
  const usage: Usage = stored?.date === today ? stored : { date: today, calls: 0, runs: 0 };
  setCallBudget(CACHE.dailyBudget - usage.calls);
  let failed = 0;
  try {
    for (const members of groups.values()) {
      try {
        await collect(members, now);
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        failed++;
        console.error(`[prices] ${members.map((m) => m.name).join(', ')} 실패: ${(err as Error).message}`);
      }
    }
  } finally {
    usage.calls += callsUsed();
    usage.runs += 1;
    await writeJSON(usagePath, usage);
    console.log(`[prices] 오피넷 호출 이번 ${callsUsed()}회, 오늘 누적 ${usage.calls}/${CACHE.dailyBudget}회`);
  }
  if (failed) process.exitCode = 1;
}

async function collect(members: StationRow[], now: Date) {
  const lead = members[0];
  const dir = stationDir(lead, 'prices');
  const prevLatest = await readJSON<PriceLatest | null>(join(dir, 'latest.json'), null);

  // 캐시: 최근에 이미 받았으면 오피넷을 부르지 않는다
  if (prevLatest && !env.force) {
    const ageH = (now.getTime() - new Date(prevLatest.fetchedAt).getTime()) / 3_600_000;
    if (ageH < CACHE.minIntervalHours) {
      console.log(`[prices] ${lead.name}: ${ageH.toFixed(1)}시간 전 데이터가 있어 건너뜀 (기준 ${CACHE.minIntervalHours}시간, 강제 실행은 force)`);
      // 새로 승인된 주유소가 같은 위치를 쓰면 받아 둔 데이터를 바로 나눠 줌
      for (const m of members.slice(1)) {
        const mdir = stationDir(m, 'prices');
        if (await readJSON<PriceLatest | null>(join(mdir, 'latest.json'), null)) continue;
        await writeJSON(join(mdir, 'latest.json'), prevLatest);
        await writeJSON(join(mdir, 'history.json'), await readJSON<PriceHistoryEntry[]>(join(dir, 'history.json'), []));
      }
      return;
    }
  }
  const station = await resolveStation(lead);

  // 반경 수집 (휘발유·경유 각각 호출 후 주유소 기준으로 합침)
  const byId = new Map<string, Neighbor>();
  for (const fuel of FUELS) {
    const list = await aroundAll(station.x, station.y, RADIUS_M, fuel);
    for (const s of list) {
      const n = byId.get(s.UNI_ID) ?? {
        id: s.UNI_ID,
        name: s.OS_NM,
        brand: brandName(s.POLL_DIV_CD),
        distanceKm: Math.round((num(s.DISTANCE) ?? 0) / 100) / 10,
        gasoline: null,
        diesel: null,
      };
      n[fuel] = num(s.PRICE);
      byId.set(s.UNI_ID, n);
    }
  }

  // 우리 가격: 반경 결과에 있으면 그 값, 없으면 상세 조회
  const self = byId.get(station.id);
  byId.delete(station.id);
  const ours: Record<Fuel, number | null> = { gasoline: self?.gasoline ?? null, diesel: self?.diesel ?? null };
  if (ours.gasoline == null || ours.diesel == null) {
    const d = await detailById(station.id);
    for (const fuel of FUELS) {
      ours[fuel] ??= num(d?.OIL_PRICE?.find((p) => p.PRODCD === PRODUCTS[fuel])?.PRICE);
    }
  }

  const neighbors = [...byId.values()].sort((a, b) => a.distanceKm - b.distanceKm);
  const stats = Object.fromEntries(
    FUELS.map((f) => [f, statsFor(ours[f], neighbors.map((n) => n[f]).filter((p): p is number => p != null))]),
  ) as Record<Fuel, FuelStats>;

  const prevIds = new Set(prevLatest?.neighbors.map((n) => n.id) ?? []);
  const nowIds = new Set(neighbors.map((n) => n.id));
  const changes = prevLatest
    ? {
        added: neighbors.filter((n) => !prevIds.has(n.id)).map((n) => n.name),
        removed: prevLatest.neighbors.filter((n) => !nowIds.has(n.id)).map((n) => n.name),
      }
    : { added: [], removed: [] };

  const date = kstDate(now);
  const historyPath = join(dir, 'history.json');
  const history = await readJSON<PriceHistoryEntry[]>(historyPath, []);
  const prev = history.filter((h) => h.date < date).at(-1);

  const base = {
    date,
    fetchedAt: now.toISOString(),
    radiusKm: RADIUS_M / 1000,
    station: { id: station.id, name: station.name, brand: station.brand, address: station.address },
    stats,
    neighbors,
    changes,
  };
  const alerts = buildAlerts(base, prev);
  const latest: PriceLatest = { ...base, alertKeys: alerts.map((a) => a.key) };

  const strip = ({ max: _max, ...rest }: FuelStats) => rest;
  const entry: PriceHistoryEntry = { date, gasoline: strip(stats.gasoline), diesel: strip(stats.diesel) };
  const nextHistory = [...history.filter((h) => h.date !== date), entry]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-HISTORY_DAYS);

  for (const m of members) {
    const mdir = stationDir(m, 'prices');
    const mPrev = m === lead ? prevLatest : await readJSON<PriceLatest | null>(join(mdir, 'latest.json'), null);
    await writeJSON(join(mdir, 'latest.json'), latest);
    await writeJSON(join(mdir, 'history.json'), nextHistory);

    // 직전 실행에서 이미 보낸 조건은 다시 보내지 않음
    const already = new Set(mPrev?.alertKeys ?? []);
    const fresh = alerts.filter((a) => !already.has(a.key));
    if (fresh.length === 0) continue;
    const time = new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(11, 16);
    const msg = [
      `⛽ <b>경쟁 가격 알림</b> ${escapeHtml(m.name)} ${date} ${time}`,
      ...fresh.map((a) => `• ${escapeHtml(a.text)}`),
      '',
      `대시보드: ${escapeHtml(env.dashboardUrl)}`,
    ].join('\n');
    const sent = await sendTelegram(msg, chatIdFor(m));
    if (!sent) console.log(`\n── 텔레그램 미리보기 (${m.name}) ──\n${msg}`);
  }
  for (const f of FUELS) {
    const s = stats[f];
    console.log(
      `[prices] ${lead.name} ${FUEL_KO[f]}: 우리 ${s.ours ?? '-'} / 평균 ${s.avg ?? '-'} / 최저 ${s.min ?? '-'} / ${s.n + 1}곳 중 ${s.rank ?? '-'}위`,
    );
  }
  if (alerts.length) console.log(`[prices] 알림 조건 ${alerts.length}개`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
