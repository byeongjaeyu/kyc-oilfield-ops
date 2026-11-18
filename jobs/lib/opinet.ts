/**
 * 오피넷 무료 API (https://www.opinet.co.kr → 유가정보 API)
 *  - 좌표는 KATEC. 우리 주유소 좌표는 오피넷이 돌려주는 값을 그대로 쓰므로 변환이 필요 없다.
 *  - 반경 검색 최대 5,000m
 */
import { env } from './env.ts';

const BASES = ['https://www.opinet.co.kr/api', 'http://www.opinet.co.kr/api'];

export const PRODUCTS = { gasoline: 'B027', diesel: 'D047' } as const;
export type Fuel = keyof typeof PRODUCTS;

export const BRANDS: Record<string, string> = {
  SKE: 'SK에너지',
  GSC: 'GS칼텍스',
  HDO: 'HD현대오일뱅크',
  SOL: 'S-OIL',
  RTO: '자영알뜰',
  RTX: '고속도로알뜰',
  NHO: '농협알뜰',
  ETC: '자가상표',
  E1G: 'E1',
  SKG: 'SK가스',
};

export interface OpinetStation {
  UNI_ID: string;
  POLL_DIV_CD?: string;
  OS_NM: string;
  PRICE?: number | string;
  DISTANCE?: number | string;
  GIS_X_COOR?: number | string;
  GIS_Y_COOR?: number | string;
  VAN_ADR?: string;
  NEW_ADR?: string;
}

export interface OpinetDetail extends OpinetStation {
  OIL_PRICE?: Array<{ PRODCD: string; PRICE: number | string; TRADE_DT?: string; TRADE_TM?: string }>;
}

// ── 호출 예산 ───────────────────────────────────────────────────
// 오피넷 키는 하루 호출 한도가 있다. 서버에 도달한 요청은 실패 응답이어도 한 번으로 센다.
let budgetLeft = Infinity;
let used = 0;

export function setCallBudget(left: number) {
  budgetLeft = left;
}
export const callsUsed = () => used;

export class BudgetExceededError extends Error {}

async function call<T>(path: string, params: Record<string, string | number>): Promise<T> {
  if (!env.opinetKey) throw new Error('OPINET_API_KEY 가 설정되지 않았습니다.');
  const qs = new URLSearchParams({ code: env.opinetKey, out: 'json' });
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));

  let lastErr: unknown;
  for (const base of [...BASES]) {
    if (used >= budgetLeft) throw new BudgetExceededError(`오늘 오피넷 호출 예산을 다 썼습니다 (${path} 호출 중단).`);
    let res: Response;
    try {
      res = await fetch(`${base}/${path}?${qs}`, { signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      // 서버에 닿지 못한 실패(네트워크·TLS)만 다음 주소로 재시도 — 호출로 세지 않음
      lastErr = err;
      console.warn(`[opinet] ${base}/${path} 연결 실패: ${(err as Error).message}`);
      continue;
    }
    used++;
    // 성공한 주소를 다음 호출부터 먼저 시도
    if (BASES[0] !== base) BASES.splice(BASES.indexOf(base), 1), BASES.unshift(base);
    const text = await res.text();
    if (!res.ok) throw new Error(`Opinet ${path} ${res.status}: ${text.slice(0, 200)}`);
    // 결과가 없으면 빈 본문이 오는 API 가 있음 (ureaPrice 등)
    if (!text.trim()) return { RESULT: { OIL: [] } } as T;
    try {
      return JSON.parse(text) as T;
    } catch (e1) {
      // 일부 API(ureaPrice 등)는 문자열 안 줄바꿈·탭, 끝 쉼표가 섞인 JSON 을 줌 → 정리해서 다시 시도
      const cleaned = text.replace(/[\u0000-\u001f]+/g, ' ').replace(/,\s*([\]}])/g, '$1');
      try {
        return JSON.parse(cleaned) as T;
      } catch {
        const pos = Number(String((e1 as Error).message).match(/position (\d+)/)?.[1] ?? 0);
        throw new Error(
          `Opinet ${path} 응답이 JSON 이 아닙니다 (키 오류·한도 초과일 수 있음): ${(e1 as Error).message} …${text.slice(Math.max(0, pos - 80), pos + 80)}`,
        );
      }
    }
  }
  throw lastErr;
}

const oilList = <T>(body: { RESULT?: { OIL?: T[] } }): T[] => body.RESULT?.OIL ?? [];

export async function searchByName(name: string): Promise<OpinetStation[]> {
  return oilList(await call<{ RESULT?: { OIL?: OpinetStation[] } }>('searchByName.do', { osnm: name }));
}

export async function detailById(id: string): Promise<OpinetDetail | undefined> {
  return oilList(await call<{ RESULT?: { OIL?: OpinetDetail[] } }>('detailById.do', { id }))[0];
}

export async function aroundAll(x: number, y: number, radius: number, fuel: Fuel): Promise<OpinetStation[]> {
  return oilList(
    await call<{ RESULT?: { OIL?: OpinetStation[] } }>('aroundAll.do', {
      x,
      y,
      radius: Math.min(radius, 5000),
      prodcd: PRODUCTS[fuel],
      sort: 2, // 거리순
    }),
  );
}

/** 전국 주유소 평균가격(현재): PRODCD 별 PRICE, DIFF(전일 대비), TRADE_DT */
export async function avgAllPrice(): Promise<Array<{ PRODCD: string; PRICE: string | number; DIFF?: string | number; TRADE_DT?: string }>> {
  return oilList(await call('avgAllPrice.do', {}));
}

/** 요소수 판매 주유소 (전국): 재고 유무·판매단가·KATEC 좌표 */
export interface UreaRow {
  UNI_ID: string;
  OS_NM: string;
  GIS_X_COOR?: number | string;
  GIS_Y_COOR?: number | string;
  STOCK_YN?: string;
  PRICE?: number | string;
  TRADE_DT?: string;
  TRADE_TM?: string;
}
/** 시·도 코드 목록 (areaCode.do, area 없이) */
export async function sidoCodes(): Promise<Array<{ AREA_CD: string; AREA_NM: string }>> {
  return oilList(await call('areaCode.do', {}));
}
export async function ureaPrice(area?: string): Promise<UreaRow[]> {
  return oilList(await call('ureaPrice.do', area ? { area } : {}));
}

export const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
