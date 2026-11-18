/**
 * 국토교통부 토지 매매 실거래가 (공공데이터포털)
 * https://apis.data.go.kr/1613000/RTMSDataSvcLandTrade/getRTMSDataSvcLandTrade
 *  - XML 응답. 금액 단위 만원, 면적 단위 ㎡
 *  - 항목 이름이 영문(신규)/한글(구버전) 두 가지라 둘 다 읽는다
 */
import { createHash } from 'node:crypto';
import { env } from './env.ts';

const ENDPOINT = 'https://apis.data.go.kr/1613000/RTMSDataSvcLandTrade/getRTMSDataSvcLandTrade';
const PAGE_SIZE = 1000;

export interface LandTrade {
  id: string;
  lawdCd: string;
  /** YYYY-MM-DD */
  date: string;
  sgg: string;
  dong: string;
  /** 공개 범위의 지번 (일부 가려짐) */
  jibun: string;
  jimok: string;
  landUse: string;
  areaM2: number;
  /** 만원 */
  amountMan: number;
  /** 원/㎡ */
  wonPerM2: number;
  /** 지분 거래 — 면적 대비 금액이 왜곡되므로 단가 통계에서 제외 */
  share: boolean;
  dealType: string;
}

let calls = 0;
export const rtmsCalls = () => calls;

function serviceKey(): string {
  const k = env.dataGoKrKey;
  if (!k) throw new Error('DATA_GO_KR_KEY 가 설정되지 않았습니다.');
  // 포털의 "Encoding" 키를 넣었으면 한 번 풀어서 이중 인코딩을 막는다
  return k.includes('%') ? decodeURIComponent(k) : k;
}

function fields(itemXml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const inner = itemXml.replace(/^\s*<item>/, '').replace(/<\/item>\s*$/, '');
  for (const m of inner.matchAll(/<([^<>\s/]+)>([\s\S]*?)<\/\1>/g)) out[m[1]] = m[2].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
  return out;
}

const pick = (f: Record<string, string>, ...keys: string[]) => {
  for (const k of keys) if (f[k] != null && f[k] !== '') return f[k];
  return '';
};
const toNum = (s: string) => Number(s.replace(/[^\d.]/g, '')) || 0;

function toTrade(lawdCd: string, f: Record<string, string>): LandTrade | null {
  // 해제된 거래 제외
  if (pick(f, 'cdealType', '해제여부') === 'O') return null;
  const y = pick(f, 'dealYear', '년');
  const m = pick(f, 'dealMonth', '월').padStart(2, '0');
  const d = pick(f, 'dealDay', '일').padStart(2, '0');
  const areaM2 = toNum(pick(f, 'dealArea', '거래면적'));
  const amountMan = toNum(pick(f, 'dealAmount', '거래금액'));
  if (!y || !areaM2 || !amountMan) return null;

  const t = {
    lawdCd,
    date: `${y}-${m}-${d}`,
    sgg: pick(f, 'sggNm', '시군구'),
    dong: pick(f, 'umdNm', '법정동'),
    jibun: pick(f, 'jibun', '지번'),
    jimok: pick(f, 'jimok', '지목'),
    landUse: pick(f, 'landUse', '용도지역'),
    areaM2,
    amountMan,
    wonPerM2: Math.round((amountMan * 10_000) / areaM2),
    share: /지분/.test(pick(f, 'shareDealingType', '구분', '지분거래구분')),
    dealType: pick(f, 'dealingGbn', '거래유형'),
  };
  const id = createHash('sha1')
    .update([t.lawdCd, t.date, t.dong, t.jibun, t.jimok, t.areaM2, t.amountMan].join('|'))
    .digest('hex')
    .slice(0, 12);
  return { id, ...t };
}

/** 한 시군구·한 달 거래 전체 (페이지 넘김 포함) */
export async function fetchMonth(
  lawdCd: string,
  ym: string,
): Promise<{ trades: LandTrade[]; sampleKeys: string[]; raw: string }> {
  const trades: LandTrade[] = [];
  let sampleKeys: string[] = [];
  let raw = '';
  for (let page = 1; ; page++) {
    const qs = new URLSearchParams({
      serviceKey: serviceKey(),
      LAWD_CD: lawdCd,
      DEAL_YMD: ym,
      pageNo: String(page),
      numOfRows: String(PAGE_SIZE),
    });
    calls++;
    const res = await fetch(`${ENDPOINT}?${qs}`, { signal: AbortSignal.timeout(30_000) });
    const xml = await res.text();
    if (page === 1) raw = xml.slice(0, 600);
    if (!res.ok) throw new Error(`실거래가 API ${res.status}: ${xml.slice(0, 300)}`);

    const code = xml.match(/<resultCode>(.*?)<\/resultCode>/)?.[1] ?? xml.match(/<returnReasonCode>(.*?)<\/returnReasonCode>/)?.[1];
    if (code && !['00', '000'].includes(code)) {
      const msg = xml.match(/<(resultMsg|returnAuthMsg)>(.*?)<\/\1>/)?.[2] ?? '';
      throw new Error(`실거래가 API 오류 ${code} ${msg} (LAWD_CD=${lawdCd}, ${ym})`);
    }

    const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
    for (const it of items) {
      const f = fields(it);
      if (!sampleKeys.length) sampleKeys = Object.keys(f);
      const t = toTrade(lawdCd, f);
      if (t) trades.push(t);
    }
    const total = Number(xml.match(/<totalCount>(\d+)<\/totalCount>/)?.[1] ?? items.length);
    if (page * PAGE_SIZE >= total || items.length === 0) break;
  }
  return { trades, sampleKeys, raw };
}
