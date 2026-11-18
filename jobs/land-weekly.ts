/**
 * #5 부지가치 — 매주 1회, 승인된 주유소별로 (같은 지역 설정이면 한 번만 받아 같이 씀)
 *  1) 국토부 토지 실거래가: 주유소가 있는 시·군·구 최근 3개월 다시 받기 (처음엔 24개월)
 *  2) 월별 ㎡당 중위 단가 (시·군·구 전체 / 주변 동) + 눈여겨볼 거래 목록
 *  3) 지역 개발·도시계획 뉴스를 AI(Gemini)가 부지 가치 관점으로 요약
 *  4) st/<주유소>/land/*.json 저장 → 대시보드, 주유소 텔레그램 주간 메모
 */
import { join } from 'node:path';
import { BACKFILL_MONTHS, MIN_AREA_M2, NEARBY_JIMOK, PRICE_JIMOK, REFRESH_MONTHS, WATCH_JIMOK } from './config/land.ts';
import { aiProvider, askAIJSON } from './lib/ai.ts';
import { DAY_MS, kstDate, kstIsoWeek } from './lib/date.ts';
import { env } from './lib/env.ts';
import { collectNews, type Article } from './lib/news.ts';
import { fetchMonth, rtmsCalls, type LandTrade } from './lib/rtms.ts';
import { approvedStations, chatIdFor, groupBy, regionOf, stationDir, type StationRow } from './lib/stations.ts';
import { readJSON, writeJSON } from './lib/store.ts';
import { escapeHtml, sendTelegram } from './lib/telegram.ts';

// ── 주유소별 지역 설정 (그룹마다 바뀜) ──────────────────────────────
let LAWD_CODES: string[] = [];
let OUR_DONG = '';
let NEARBY_DONGS: string[] = [];
let LAND_KEYWORDS: string[] = [];
let LAND_CONTEXT = '';
let REGION = '';

function useStation(s: StationRow) {
  REGION = regionOf(s.address) || '시·군·구';
  LAWD_CODES = [s.lawd_cd!];
  OUR_DONG = s.dong;
  NEARBY_DONGS = s.nearby_dongs.length ? s.nearby_dongs : s.dong ? [s.dong] : [];
  LAND_KEYWORDS = s.land_keywords.length
    ? s.land_keywords
    : [`${REGION} 개발`, `${REGION} 도시계획`, `${REGION} 도로 확장`, `${REGION} 부동산`, ...(s.dong ? [`${s.dong} 개발`] : [])];
  LAND_CONTEXT = `
- 독자: ${s.address}${s.dong ? `(${s.dong})` : ''} 주유소 부지와 관련된 임대인·임차인.
- 관심사: 부지 가치가 오를 요인/내릴 요인. 주변 개발, 도로·교통, 산업단지, 용도지역 변경, 대규모 투자.
`.trim();
}

const LAND_CATEGORIES = ['개발·교통', '산업단지·투자', '도시계획·용도', '부동산 시장', '행정', '기타'] as const;

interface Agg {
  n: number;
  /** 원/㎡ 중위값 */
  median: number | null;
}

export interface LandMonth {
  ym: string;
  gwangsan: Agg;
  nearby: Agg;
}

export interface LandNewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  category: string;
  summary: string;
  impact: string;
  importance: 1 | 2 | 3;
}

export interface LandLatest {
  /** 시·군·구 이름 (예: 광산구) */
  region: string;
  generatedAt: string;
  week: string;
  ourDong: string;
  nearbyDongs: string[];
  months: LandMonth[];
  recent: { months: number; gwangsan: Agg; nearby: Agg; ourDong: Agg };
  notable: LandTrade[];
  news: { mode: 'ai' | 'raw'; headline: string; items: LandNewsItem[]; collected: number };
  warnings: string[];
}

// ── 유틸 ──────────────────────────────────────────────────────────
function monthsBack(n: number, now: Date): string[] {
  const [y, m] = kstDate(now).split('-').map(Number);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
const ymOf = (date: string) => date.slice(0, 7);
const ymDash = (ym: string) => `${ym.slice(0, 4)}-${ym.slice(4)}`;

function agg(trades: LandTrade[]): Agg {
  const vals = trades
    .filter((t) => !t.share && t.areaM2 >= MIN_AREA_M2 && PRICE_JIMOK.includes(t.jimok))
    .map((t) => t.wonPerM2)
    .sort((a, b) => a - b);
  if (!vals.length) return { n: 0, median: null };
  const mid = Math.floor(vals.length / 2);
  const median = vals.length % 2 ? vals[mid] : Math.round((vals[mid - 1] + vals[mid]) / 2);
  return { n: vals.length, median };
}

const isNearby = (t: LandTrade) => NEARBY_DONGS.includes(t.dong);
const isNotable = (t: LandTrade) => WATCH_JIMOK.includes(t.jimok) || (isNearby(t) && NEARBY_JIMOK.includes(t.jimok));

// ── 실거래가 ──────────────────────────────────────────────────────
async function updateTrades(dir: string, now: Date, warnings: string[]) {
  const monthlyPath = join(dir, 'monthly.json');
  const keptPath = join(dir, 'trades.json');
  const monthly = await readJSON<LandMonth[]>(monthlyPath, []);
  const kept = await readJSON<LandTrade[]>(keptPath, []);

  const months = monthsBack(monthly.length ? REFRESH_MONTHS : BACKFILL_MONTHS, now);
  const fresh = new Map<string, LandTrade[]>(); // ym(YYYY-MM) → 시·군·구 전체 거래
  let printedKeys = false;
  let firstRaw = '';

  for (const ym of months) {
    const all: LandTrade[] = [];
    for (const code of LAWD_CODES) {
      const { trades, sampleKeys, raw } = await fetchMonth(code, ym);
      firstRaw ||= raw;
      if (!printedKeys && sampleKeys.length) {
        console.log(`[land] 응답 항목: ${sampleKeys.join(', ')}`);
        printedKeys = true;
      }
      all.push(...trades);
    }
    fresh.set(ymDash(ym), all);
    console.log(`[land] ${ymDash(ym)} 거래 ${all.length}건`);
  }

  // 한 건도 없으면 저장하지 않고 응답 원문을 보여 준다 (키 미활성·코드 오류 등)
  if ([...fresh.values()].every((t) => t.length === 0) && !monthly.some((m) => m.gwangsan.n > 0)) {
    throw new Error(`실거래가 응답에 거래가 하나도 없습니다. 응답 앞부분:\n${firstRaw}`);
  }

  // 법정동코드 변경 감지: 최근 두 달(이번 달 제외)이 모두 0건인데 그 전엔 있었다면 경고
  const counts = months.map((ym) => fresh.get(ymDash(ym))!.length);
  const prevMonths = monthly.filter((m) => !fresh.has(m.ym));
  const hadBefore = counts.slice(3).some((c) => c > 0) || prevMonths.some((m) => m.gwangsan.n > 0);
  if (counts.length >= 3 && counts[1] === 0 && counts[2] === 0 && hadBefore) {
    warnings.push(
      `최근 두 달 ${REGION} 토지 거래가 0건입니다. 행정구역 개편으로 법정동코드(${LAWD_CODES.join(', ')})가 바뀌었을 수 있으니 주유소 설정의 실거래가 지역코드를 확인하세요.`,
    );
  }

  // 월별 집계 갱신
  const byYm = new Map(monthly.map((m) => [m.ym, m]));
  for (const [ym, trades] of fresh) byYm.set(ym, { ym, gwangsan: agg(trades), nearby: agg(trades.filter(isNearby)) });
  const nextMonthly = [...byYm.values()].sort((a, b) => a.ym.localeCompare(b.ym)).slice(-BACKFILL_MONTHS);

  // 개별 거래는 주변 동 + 눈여겨볼 지목만 보관 (다시 받은 달은 통째로 교체)
  const keepFresh = [...fresh.values()].flat().filter((t) => isNearby(t) || isNotable(t));
  const oldest = nextMonthly[0]?.ym ?? '0000-00';
  const nextKept = [...kept.filter((t) => !fresh.has(ymOf(t.date)) && ymOf(t.date) >= oldest), ...keepFresh].sort((a, b) =>
    b.date.localeCompare(a.date),
  );

  await writeJSON(monthlyPath, nextMonthly);
  await writeJSON(keptPath, nextKept);
  return { monthly: nextMonthly, kept: nextKept, fresh };
}

// ── 뉴스 ──────────────────────────────────────────────────────────
interface AiResult {
  headline: string;
  items: Array<{ id: string; category: string; summary: string; impact: string; importance: number }>;
}

async function summarizeNews(articles: Article[], statsLine: string): Promise<{ headline: string; items: LandNewsItem[] }> {
  const byId = new Map(articles.map((a) => [a.id, a]));
  const list = articles
    .slice(0, 80)
    .map((a) => `[${a.id}] (${a.publishedAt.slice(0, 10)}, ${a.source}) ${a.title}${a.description ? ` — ${a.description}` : ''}`)
    .join('\n');

  const system = `당신은 토지 가치를 보는 부동산 애널리스트입니다.
${LAND_CONTEXT}

규칙:
- 기사 목록에서 이 부지의 가치에 영향을 줄 만한 것만 최대 8개 고르세요. ${REGION} 밖이라도 그 생활권 전체에 영향이 크면 포함합니다. 무관하거나 중복된 기사는 버립니다.
- summary: 무슨 일인지 1~2문장. 기사에 없는 수치·사실을 만들지 마세요.
- impact: 이 부지 가치에 어떤 방향으로 작용할 수 있는지 한 문장. 불확실하면 그렇게 쓰세요.
- importance: 3=${OUR_DONG || '부지'} 인근이거나 직접 영향 / 2=${REGION} 단위 영향 / 1=참고
- category 는 다음 중 하나: ${LAND_CATEGORIES.join(', ')}
- headline: 이번 주 부지 가치 관련 흐름을 한 문장으로. 아래 실거래 통계 수치를 언급해도 되지만, 주어진 숫자만 쓰세요.

실거래 통계(계산값): ${statsLine}

반드시 아래 JSON 하나만 출력하세요:
{"headline": string, "items": [{"id": "a1", "category": string, "summary": string, "impact": string, "importance": 1|2|3}]}`;

  const ai = await askAIJSON<AiResult>(system, `기사 목록:\n${list}`);
  const items: LandNewsItem[] = [];
  for (const it of ai.items ?? []) {
    const a = byId.get(it.id);
    if (!a) continue;
    items.push({
      title: a.title,
      url: a.url,
      source: a.source,
      publishedAt: a.publishedAt,
      category: (LAND_CATEGORIES as readonly string[]).includes(it.category) ? it.category : '기타',
      summary: String(it.summary ?? '').trim(),
      impact: String(it.impact ?? '').trim(),
      importance: Math.min(3, Math.max(1, Math.round(Number(it.importance) || 1))) as 1 | 2 | 3,
    });
  }
  items.sort((x, y) => y.importance - x.importance || y.publishedAt.localeCompare(x.publishedAt));
  return { headline: String(ai.headline ?? '').trim(), items: items.slice(0, 8) };
}

// ── 메인 ──────────────────────────────────────────────────────────
const manWon = (man: number) => (man >= 10_000 ? `${(man / 10_000).toFixed(man % 10_000 ? 1 : 0)}억원` : `${man.toLocaleString('ko-KR')}만원`);
const perPyeong = (wonPerM2: number) => Math.round((wonPerM2 * 3.3058) / 10_000); // 만원/평

async function main() {
  const now = new Date();
  const stations = (await approvedStations()).filter((st) => st.lawd_cd);
  const groups = groupBy(stations, (st) => JSON.stringify([st.lawd_cd, st.dong, st.nearby_dongs, st.land_keywords, regionOf(st.address)]));
  console.log(`[land] 주유소 ${stations.length}곳, 지역 ${groups.size}곳`);
  let failed = 0;
  for (const members of groups.values()) {
    try {
      await runGroup(members, now);
    } catch (err) {
      failed++;
      console.error(`[land] ${members.map((m) => m.name).join(', ')} 실패: ${(err as Error).message}`);
    }
  }
  console.log(`[land] 실거래가 API 호출 ${rtmsCalls()}회`);
  if (failed) process.exitCode = 1;
}

async function runGroup(members: StationRow[], now: Date) {
  const lead = members[0];
  useStation(lead);
  const dir = stationDir(lead, 'land');
  const warnings: string[] = [];

  const { monthly, kept, fresh } = await updateTrades(dir, now, warnings);

  const recentYms = new Set([...fresh.keys()]);
  const recentAll = [...fresh.values()].flat();
  const recent = {
    months: recentYms.size > REFRESH_MONTHS ? REFRESH_MONTHS : recentYms.size,
    gwangsan: agg(recentAll),
    nearby: agg(recentAll.filter(isNearby)),
    ourDong: agg(recentAll.filter((t) => t.dong === OUR_DONG)),
  };
  // 첫 실행(24개월)일 때도 "최근"은 3개월로 맞춤
  if (recentYms.size > REFRESH_MONTHS) {
    const last3 = [...recentYms].sort().slice(-REFRESH_MONTHS);
    const sub = last3.flatMap((ym) => fresh.get(ym)!);
    recent.gwangsan = agg(sub);
    recent.nearby = agg(sub.filter(isNearby));
    recent.ourDong = agg(sub.filter((t) => t.dong === OUR_DONG));
  }

  const sixMonthsAgo = ymDash(monthsBack(6, now).at(-1)!);
  const notableAll = kept.filter((t) => isNotable(t) && ymOf(t.date) >= sixMonthsAgo);
  const notable = notableAll.slice(0, 40);

  const statsLine =
    `최근 ${recent.months}개월 ${REGION} 대지·잡종지 등 거래 ${recent.gwangsan.n}건, ㎡당 중위 ${recent.gwangsan.median?.toLocaleString('ko-KR') ?? '-'}원; ` +
    `주변 동 ${recent.nearby.n}건, ㎡당 중위 ${recent.nearby.median?.toLocaleString('ko-KR') ?? '-'}원; ` +
    `${OUR_DONG} ${recent.ourDong.n}건.`;
  console.log(`[land] ${statsLine}`);

  // 뉴스
  const since = new Date(now.getTime() - 7 * DAY_MS);
  const { articles, provider, errors } = await collectNews(LAND_KEYWORDS, since);
  console.log(`[land] 뉴스 ${provider} ${articles.length}건 (실패 키워드 ${errors.length}개)`);
  let news: LandLatest['news'] = {
    mode: 'raw',
    headline: '',
    collected: articles.length,
    items: articles.slice(0, 8).map((a) => ({
      title: a.title,
      url: a.url,
      source: a.source,
      publishedAt: a.publishedAt,
      category: '미분류',
      summary: a.description.slice(0, 160),
      impact: '',
      importance: 1,
    })),
  };
  if (aiProvider() && articles.length) {
    try {
      news = { mode: 'ai', collected: articles.length, ...(await summarizeNews(articles, statsLine)) };
    } catch (err) {
      console.error(`[land] AI 요약 실패 — 기사 목록으로 대체: ${(err as Error).message}`);
    }
  }

  const latest: LandLatest = {
    region: REGION,
    generatedAt: now.toISOString(),
    week: kstIsoWeek(now),
    ourDong: OUR_DONG,
    nearbyDongs: NEARBY_DONGS,
    months: monthly,
    recent,
    notable,
    news,
    warnings,
  };
  warnings.forEach((w) => console.warn(`[land] 경고: ${w}`));
  const sixMonthsKept = kept;

  for (const m of members) {
    const mdir = stationDir(m, 'land');
    await writeJSON(join(mdir, 'latest.json'), latest);
    if (m !== lead) {
      // 같은 지역을 쓰는 주유소도 다음 주 비교용 원본을 갖도록
      await writeJSON(join(mdir, 'monthly.json'), monthly);
      await writeJSON(join(mdir, 'trades.json'), sixMonthsKept);
    }

    // 텔레그램 — 지난주 이후 새로 잡힌 눈여겨볼 거래
    const prevIds = new Set((await readJSON<{ ids: string[] }>(join(mdir, 'notified.json'), { ids: [] })).ids);
    const newNotable = notableAll.filter((t) => !prevIds.has(t.id));
    const keepIds = new Set(kept.map((t) => t.id));
    await writeJSON(join(mdir, 'notified.json'), {
      ids: [...new Set([...prevIds, ...notableAll.map((t) => t.id)])].filter((id) => keepIds.has(id)),
    });

    const lines = [
      `🏗 <b>부지가치 주간 메모</b> ${escapeHtml(m.name)} ${latest.week}`,
      news.headline ? `<i>${escapeHtml(news.headline)}</i>` : '',
      '',
      `최근 ${recent.months}개월 주변 동 대지·잡종지 등 ${recent.nearby.n}건, ㎡당 중위 ${recent.nearby.median?.toLocaleString('ko-KR') ?? '-'}원` +
        (recent.nearby.median ? ` (평당 약 ${perPyeong(recent.nearby.median).toLocaleString('ko-KR')}만원)` : ''),
      `${REGION} 전체 ${recent.gwangsan.n}건, ㎡당 중위 ${recent.gwangsan.median?.toLocaleString('ko-KR') ?? '-'}원`,
    ];
    if (prevIds.size && newNotable.length) {
      lines.push('', '<b>새로 신고된 눈여겨볼 거래</b>');
      for (const t of newNotable.slice(0, 8)) {
        lines.push(
          `• ${t.date.slice(5)} ${escapeHtml(t.dong)} ${escapeHtml(t.jimok)} ${Math.round(t.areaM2).toLocaleString('ko-KR')}㎡ ${manWon(t.amountMan)} (㎡당 ${t.wonPerM2.toLocaleString('ko-KR')}원)`,
        );
      }
    }
    const top = news.items.filter((i) => news.mode === 'raw' || i.importance >= 2).slice(0, 5);
    if (top.length) {
      lines.push('', '<b>개발·도시계획 뉴스</b>');
      for (const it of top) {
        lines.push(`• <a href="${escapeHtml(it.url)}">${escapeHtml(it.title)}</a>`);
        if (it.impact) lines.push(`  ↳ ${escapeHtml(it.impact)}`);
      }
    }
    if (warnings.length) lines.push('', ...warnings.map((w) => `⚠️ ${escapeHtml(w)}`));
    lines.push('', `대시보드: ${escapeHtml(env.dashboardUrl)}`);
    const msg = lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
    const sent = await sendTelegram(msg, chatIdFor(m));
    if (!sent) console.log(`\n── 텔레그램 미리보기 (${m.name}) ──\n${msg}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
