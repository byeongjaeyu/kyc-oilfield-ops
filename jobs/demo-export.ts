/**
 * 로그인 전 데모용 수집 데이터 — 데모 주유소의 가격·부지·요소수와 공통 시세·정책을
 *  주유소 이름·지번을 가려서 demo/… 키로 복사. 누구나 읽을 수 있으므로 실제 주유소를 알아볼 수 있는 값은 남기지 않음
 */
import { join } from 'node:path';
import { env } from './lib/env.ts';
import { readJSON, writeJSON } from './lib/store.ts';
import { rest, supabaseEnabled } from './lib/supabase.ts';
import { regionOf } from './lib/stations.ts';

const DEMO = 'de300000-0000-4000-8000-000000000001';
const src = (k: string) => join(env.dataDir, k);
const dst = (k: string) => join(env.dataDir, 'demo', k);

if (!supabaseEnabled()) {
  console.log('[demo] SUPABASE_DATA_KEY 없음, 건너뜀');
  process.exit(0);
}

const NAMES = ['햇살', '푸른', '한길', '새벽', '동네', '사거리', '큰길', '들녘', '하늘', '바른', '첫눈', '솔밭', '샘골', '노을', '다솜', '별빛', '은행나무', '느티', '강변', '언덕', '이음', '나들', '미소', '가람', '버들', '모퉁이', '한결', '누리', '초록', '단비'];
const KINDS = ['주유소', '셀프주유소', '에너지', '석유'];
const POOL = KINDS.flatMap((k) => NAMES.map((n) => `${n}${k}`));
/** 같은 원래 이름은 늘 같은 가짜 이름으로 (날마다 바뀌지 않게) */
const fakeName = (() => {
  const seen = new Map<string, string>();
  const used = new Set<string>();
  return (orig: string) => {
    if (!seen.has(orig)) {
      let h = 0;
      for (const ch of orig) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      let i = h % POOL.length;
      for (let tries = 0; used.has(POOL[i]) && tries < POOL.length; tries++) i = (i + 7) % POOL.length;
      const name = used.has(POOL[i]) ? `${POOL[i]} ${seen.size}` : POOL[i];
      used.add(name);
      seen.set(orig, name);
    }
    return seen.get(orig)!;
  };
})();

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const station = { id: 'demo', name: '예시 주유소', brand: '자가상표', address: '예시시 예시구 예시로 1' };

// 가격
const prices = await readJSON<J | null>(src(`st/${DEMO}/prices/latest.json`), null);
if (prices) {
  prices.station = station;
  prices.neighbors = (prices.neighbors ?? []).map((n: J, i: number) => ({ ...n, id: `n${i}`, name: fakeName(n.name) }));
  prices.changes = { added: [], removed: [] };
  delete prices.alertKeys;
  await writeJSON(dst('prices/latest.json'), prices);
}
await writeJSON(dst('prices/history.json'), await readJSON(src(`st/${DEMO}/prices/history.json`), []));

// 부지: 실제 위치를 알 수 없게 구·동 이름을 바꾸고 지번은 지움
const land = await readJSON<J | null>(src(`st/${DEMO}/land/latest.json`), null);
if (land) {
  const ourDong = land.ourDong;
  const ALIAS = ['가람동', '나루동', '다솜동', '마루동', '바다동', '새벽동', '아라동', '자람동', '하늘동', '한결동'];
  const dongs = new Map<string, string>([[ourDong, '예시동']]);
  const dongOf = (d: string) => {
    if (!d) return d;
    if (!dongs.has(d)) dongs.set(d, ALIAS[(dongs.size - 1) % ALIAS.length] + (dongs.size > ALIAS.length ? String(Math.ceil(dongs.size / ALIAS.length)) : ''));
    return dongs.get(d)!;
  };
  // 원본 데이터의 region 이 비었거나 '데모용'일 수 있어 데모 주유소(원본 위치) 주소의 구 이름도 같이 가림
  const [row] = await rest<Array<{ address: string }>>(`stations?select=address&id=eq.${DEMO}`).catch(() => []);
  const regions = [land.region, regionOf(row?.address ?? '')].filter((r): r is string => !!r && r !== '데모용');
  land.region = '예시구';
  land.ourDong = '예시동';
  land.nearbyDongs = (land.nearbyDongs ?? []).map(dongOf);
  land.notable = (land.notable ?? []).map((t: J, i: number) => ({ ...t, id: `t${i}`, jibun: '', dong: dongOf(t.dong) }));
  land.warnings = [];
  // 지역 소식: 기사 속 실제 지역명을 예시 이름으로 바꾸고 원문 링크는 뺌 (데모라는 띠가 늘 보임)
  const real = [...regions, ...dongs.keys()].filter(Boolean) as string[];
  const scrub = (t: unknown) =>
    typeof t !== 'string'
      ? t
      : real
          .reduce((x, r) => x.split(r).join(r === ourDong ? '예시동' : dongs.get(r) ?? '예시구'), t)
          .replace(/광주광역시|전남광주통합특별시|전남광주|광주/g, '예시시');
  if (land.news) {
    land.news.headline = scrub(land.news.headline);
    land.news.items = (land.news.items ?? []).map((it: J) => {
      const o: J = {};
      for (const [k, v] of Object.entries(it)) o[k] = /^(url|link|href)$/i.test(k) ? '' : scrub(v);
      return o;
    });
  }
  await writeJSON(dst('land/latest.json'), land);
}

// 요소수: 판매처 이름 가림
const urea = await readJSON<J | null>(src(`st/${DEMO}/supplies/urea.json`), null);
if (urea) {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o: J = {};
      for (const [k, x] of Object.entries(v as J)) {
        if ((k === 'name' || k === 'NAME' || k === 'OS_NM') && typeof x === 'string') o[k] = fakeName(x);
        else if (/^(addr|address|ADDR|NEW_ADR|VAN_ADR|tel|TEL)$/.test(k)) o[k] = '';
        else if (k === 'id' || k === 'UNI_ID') o[k] = typeof x === 'string' ? `u${fakeName(x)}` : x;
        else o[k] = walk(x);
      }
      return o;
    }
    return v;
  };
  await writeJSON(dst('supplies/urea.json'), walk(urea));
}

// 공통 시세·정책은 그대로
await writeJSON(dst('market/latest.json'), await readJSON(src('market/latest.json'), null));
const index = await readJSON<Array<{ file: string }>>(src('policy/index.json'), []);
await writeJSON(dst('policy/index.json'), index.slice(0, 1));
if (index[0]) await writeJSON(dst(`policy/${index[0].file}`), await readJSON(src(`policy/${index[0].file}`), null));

console.log(`[demo] 가격 ${prices ? '있음' : '없음'}, 부지 ${land ? '있음' : '없음'}, 요소수 ${urea ? '있음' : '없음'}, 정책 ${index.length ? index[0].file : '없음'}`);
