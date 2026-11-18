/**
 * 요소수 주변 시세·품절 감시 — 가격 수집과 같이 4시간마다
 *  오피넷 ureaPrice (요소수 판매 주유소의 재고 유무·판매단가, 7·13·18·24시 갱신)를 전국 한 번에 받아
 *  승인된 주유소마다 반경 5km 판매처를 골라 st/<주유소>/supplies/urea.json 에 저장
 *  주변 품절 비율이 갑자기 높아지면 그 주유소 텔레그램으로 "미리 발주" 경고
 */
import { join } from 'node:path';
import { RADIUS_M } from './config/prices.ts';
import { env } from './lib/env.ts';
import { num, sidoCodes, ureaPrice, type UreaRow } from './lib/opinet.ts';
import { approvedStations, chatIdFor, stationDir } from './lib/stations.ts';
import { readJSON, writeJSON } from './lib/store.ts';
import { escapeHtml, sendTelegram } from './lib/telegram.ts';

/** 주변 판매처 중 이 비율 이상이 품절이면 경고 */
const SHORTAGE_RATIO = 0.3;

export interface UreaSeller {
  id: string;
  name: string;
  distanceKm: number;
  price: number | null;
  inStock: boolean;
  reportedAt: string;
}
export interface UreaLatest {
  fetchedAt: string;
  radiusKm: number;
  ours: UreaSeller | null;
  nearby: UreaSeller[];
  stats: { n: number; inStock: number; avg: number | null; min: number | null };
  /** 조회한 시·도 전체 (전국이 아님) */
  national: { n: number; inStock: number; avg: number | null };
  shortage: boolean;
}

const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const reported = (d?: string, t?: string) =>
  d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}${t && /^\d{4,6}$/.test(t) ? ` ${t.slice(0, 2)}:${t.slice(2, 4)}` : ''}` : '';

async function main() {
  if (!env.opinetKey) return console.log('[urea] OPINET_API_KEY 없음 — 건너뜀');
  const stations = (await approvedStations()).filter((s) => s.katec_x && s.katec_y);
  if (!stations.length) return console.log('[urea] 좌표가 있는 주유소 없음');

  // ureaPrice 는 시·도(area)를 줘야 결과가 나옴 → 주유소가 있는 시·도만 부름
  const sidos = await sidoCodes();
  console.log(`[urea] 시·도 코드 ${sidos.map((a) => `${a.AREA_CD}:${a.AREA_NM}`).join(' ')}`);
  const sidoOf = (address: string) => {
    const head = address.split(/\s+/)[0] ?? '';
    return (
      sidos.find((a) => a.AREA_NM.startsWith(head)) ??
      sidos.find((a) => head.startsWith(a.AREA_NM)) ??
      sidos.find((a) => a.AREA_NM.slice(0, 2) === head.slice(0, 2))
    )?.AREA_CD;
  };
  const areas = [...new Set(stations.map((st) => sidoOf(st.address)).filter((a): a is string => !!a))];
  const targets = areas.length ? areas : sidos.map((a) => a.AREA_CD);
  // 2026-07 전남광주 통합으로 시·도 코드가 20 으로 합쳐졌지만, 요소수 API 는 아직 옛 코드(광주 16, 전남 07)로만 줄 수 있음
  const LEGACY: Record<string, string[]> = { '20': ['16', '07'] };
  const all: UreaRow[] = [];
  for (const area of targets) {
    let rows = await ureaPrice(area);
    if (!rows.length && LEGACY[area]) {
      for (const old of LEGACY[area]) rows = rows.concat(await ureaPrice(old));
      console.log(`[urea] ${area} 결과가 없어 옛 코드 ${LEGACY[area].join(', ')} 로 다시 조회: ${rows.length}곳`);
    }
    all.push(...rows);
  }
  console.log(`[urea] 조회한 시·도 ${targets.join(', ')}`);
  // 재고 표시 값 확인 (문서는 Y/N 이지만 실제 값이 다를 수 있어 로그로 남김)
  const stockVals = [...new Set(all.map((r) => String((r as unknown as Record<string, unknown>).STOCK_YN ?? '(없음)')))];
  console.log(`[urea] 재고 값 종류: ${stockVals.slice(0, 10).join(', ')} / 필드: ${Object.keys(all[0] ?? {}).join(', ')}`);
  const yes = (v: unknown) => /^(y|yes|1|o|재고|있음|판매)/i.test(String(v ?? '').trim());
  const no = (v: unknown) => /^(n|no|0|x|품절|없음|매진)/i.test(String(v ?? '').trim());
  const stockKnown = all.some((r) => yes(r.STOCK_YN) || no(r.STOCK_YN));
  const prices = all.map((r) => num(r.PRICE)).filter((p): p is number => p != null);
  const national = { n: all.length, inStock: stockKnown ? all.filter((r) => !no(r.STOCK_YN)).length : all.length, avg: avg(prices) };
  console.log(`[urea] 조회 지역 판매처 ${national.n}곳, 재고 있음 ${national.inStock}곳, 평균 ${national.avg ?? '-'}원/L`);

  for (const st of stations) {
    const sellers: UreaSeller[] = all
      .map((r) => {
        const x = num(r.GIS_X_COOR);
        const y = num(r.GIS_Y_COOR);
        const d = x != null && y != null ? Math.hypot(x - st.katec_x!, y - st.katec_y!) : Infinity;
        return {
          id: r.UNI_ID,
          name: r.OS_NM,
          distanceKm: Math.round(d / 100) / 10,
          price: num(r.PRICE),
          inStock: stockKnown ? !no(r.STOCK_YN) : true,
          reportedAt: reported(r.TRADE_DT, r.TRADE_TM),
          _d: d,
        };
      })
      .filter((s) => s._d <= RADIUS_M || s.id === st.opinet_id)
      .sort((a, b) => a._d - b._d)
      .map(({ _d, ...s }) => s);
    const ours = sellers.find((s) => s.id === st.opinet_id) ?? null;
    const nearby = sellers.filter((s) => s.id !== st.opinet_id);
    const np = nearby.map((s) => s.price).filter((p): p is number => p != null);
    const out = nearby.filter((s) => !s.inStock).length;
    const shortage = stockKnown && nearby.length >= 3 && out / nearby.length >= SHORTAGE_RATIO;

    const dir = stationDir(st, 'supplies');
    const prev = await readJSON<UreaLatest | null>(join(dir, 'urea.json'), null);
    const latest: UreaLatest = {
      fetchedAt: new Date().toISOString(),
      radiusKm: RADIUS_M / 1000,
      ours,
      nearby,
      stats: { n: nearby.length, inStock: nearby.length - out, avg: avg(np), min: np.length ? Math.min(...np) : null },
      national,
      shortage,
    };
    await writeJSON(join(dir, 'urea.json'), latest);
    console.log(`[urea] ${st.name}: 반경 판매처 ${nearby.length}곳 (품절 ${out}), 평균 ${latest.stats.avg ?? '-'}원, 우리 ${ours?.price ?? '미공시'}`);

    if (shortage && !prev?.shortage) {
      const msg = [
        `⚠️ <b>요소수 수급 주의</b> ${escapeHtml(st.name)}`,
        `반경 ${latest.radiusKm}km 판매처 ${nearby.length}곳 중 ${out}곳이 품절입니다. 재고를 확인하고 미리 발주해 두세요.`,
        `같은 시·도 재고 있음 ${national.inStock}/${national.n}곳`,
        '',
        `대시보드: ${escapeHtml(env.dashboardUrl)}#supplies`,
      ].join('\n');
      const sent = await sendTelegram(msg, chatIdFor(st));
      if (!sent) console.log(`\n── 텔레그램 미리보기 (${st.name}) ──\n${msg}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
