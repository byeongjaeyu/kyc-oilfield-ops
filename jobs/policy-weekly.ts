/**
 * #6 업계 정책 주간 요약
 *  1) 키워드별 최근 7일 뉴스 수집 (네이버 API → 없으면 Google 뉴스 RSS)
 *  2) AI(Gemini)가 부지 소유자 관점으로 선별·요약 (키 없으면 기사 목록만)
 *  3) data/policy/<주차>.json + index.json 저장 → 대시보드가 읽음
 *  4) 텔레그램으로 전송
 */
import { join } from 'node:path';
import { BUSINESS_CONTEXT, POLICY_CATEGORIES, POLICY_KEYWORDS, type PolicyCategory } from './config/policy.ts';
import { aiProvider, askAIJSON } from './lib/ai.ts';
import { DAY_MS, kstIsoWeek, kstShort } from './lib/date.ts';
import { env } from './lib/env.ts';
import { collectNews, type Article } from './lib/news.ts';
import { approvedStations } from './lib/stations.ts';
import { readJSON, writeJSON } from './lib/store.ts';
import { escapeHtml, sendTelegram } from './lib/telegram.ts';

export interface PolicyItem {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  category: PolicyCategory | '미분류';
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

interface AiResult {
  headline: string;
  items: Array<{ id: string; category: string; summary: string; impact: string; importance: number }>;
  watch: string[];
}

const MAX_ITEMS = 10;
const MAX_INPUT_ARTICLES = 80;

async function summarize(articles: Article[]): Promise<Pick<PolicyReport, 'headline' | 'items' | 'watch'>> {
  const byId = new Map(articles.map((a) => [a.id, a]));
  const list = articles
    .slice(0, MAX_INPUT_ARTICLES)
    .map((a) => `[${a.id}] (${a.publishedAt.slice(0, 10)}, ${a.source}) ${a.title}${a.description ? ` — ${a.description}` : ''}`)
    .join('\n');

  const system = `당신은 주유소 부지 소유자를 돕는 업계·정책 애널리스트입니다.
${BUSINESS_CONTEXT}

규칙:
- 아래 기사 목록에서 독자의 부지 활용 판단에 실제로 의미 있는 것만 최대 ${MAX_ITEMS}개 고르세요. 단순 홍보·중복·무관한 기사는 버립니다.
- 같은 사안을 다룬 기사가 여러 개면 가장 정보가 많은 하나만 고릅니다.
- summary: 무슨 일인지 1~2문장. 기사에 없는 수치·사실을 만들지 마세요.
- impact: "이 부지 소유자에게 무슨 의미인지" 한 문장. 확실하지 않으면 "지켜볼 사안" 수준으로 표현하세요.
- importance: 3=판단에 직접 영향(지원금, 규제 시행, 우리 지역 관련) / 2=추세로 의미 있음 / 1=참고
- category 는 다음 중 하나: ${POLICY_CATEGORIES.join(', ')}
- watch: 다음 주 이후 추적할 만한 사안 0~3개 (짧은 문장)
- headline: 이번 주 전체를 한 문장으로.

반드시 아래 JSON 하나만 출력하세요:
{"headline": string, "items": [{"id": "a1", "category": string, "summary": string, "impact": string, "importance": 1|2|3}], "watch": string[]}`;

  const ai = await askAIJSON<AiResult>(system, `기사 목록:\n${list}`);

  const items: PolicyItem[] = [];
  for (const it of ai.items ?? []) {
    const a = byId.get(it.id);
    if (!a) continue; // 존재하지 않는 id(환각) 무시
    const category = (POLICY_CATEGORIES as readonly string[]).includes(it.category)
      ? (it.category as PolicyCategory)
      : '기타';
    const importance = Math.min(3, Math.max(1, Math.round(Number(it.importance) || 1))) as 1 | 2 | 3;
    items.push({
      title: a.title,
      url: a.url,
      source: a.source,
      publishedAt: a.publishedAt,
      category,
      summary: String(it.summary ?? '').trim(),
      impact: String(it.impact ?? '').trim(),
      importance,
    });
  }
  items.sort((x, y) => y.importance - x.importance || y.publishedAt.localeCompare(x.publishedAt));

  return {
    headline: String(ai.headline ?? '').trim(),
    items: items.slice(0, MAX_ITEMS),
    watch: (ai.watch ?? []).map(String).slice(0, 3),
  };
}

function rawFallback(articles: Article[]): Pick<PolicyReport, 'headline' | 'items' | 'watch'> {
  return {
    headline: `AI 요약 없이 최신 기사 ${Math.min(15, articles.length)}건을 모았습니다 (전체 ${articles.length}건).`,
    items: articles.slice(0, 15).map((a) => ({
      title: a.title,
      url: a.url,
      source: a.source,
      publishedAt: a.publishedAt,
      category: '미분류',
      summary: a.description.slice(0, 160),
      impact: '',
      importance: 1,
    })),
    watch: [],
  };
}

function toTelegram(r: PolicyReport): string {
  const from = kstShort(new Date(r.period.from));
  const to = kstShort(new Date(r.period.to));
  const stars = (n: number) => (n === 3 ? '🔴 ' : n === 2 ? '🟡 ' : '');
  const lines = [
    `📰 <b>주간 업계·정책 리포트</b> ${r.week} (${from}~${to})`,
    r.headline ? `<i>${escapeHtml(r.headline)}</i>` : '',
    '',
  ];

  const groups = new Map<string, PolicyItem[]>();
  for (const it of r.items) groups.set(it.category, [...(groups.get(it.category) ?? []), it]);
  for (const [cat, items] of groups) {
    lines.push(`<b>[${escapeHtml(cat)}]</b>`);
    for (const it of items) {
      lines.push(`${stars(it.importance)}<a href="${escapeHtml(it.url)}">${escapeHtml(it.title)}</a> · ${escapeHtml(it.source)}`);
      if (it.summary) lines.push(escapeHtml(it.summary));
      if (it.impact) lines.push(`↳ ${escapeHtml(it.impact)}`);
      lines.push('');
    }
  }
  if (r.items.length === 0) lines.push('이번 주에는 눈여겨볼 기사가 없었습니다.', '');
  if (r.watch.length) lines.push('👀 <b>지켜볼 것</b>', ...r.watch.map((w) => `• ${escapeHtml(w)}`), '');
  lines.push(`대시보드: ${escapeHtml(env.dashboardUrl)}`);
  return lines.filter((l, i, arr) => !(l === '' && arr[i - 1] === '')).join('\n');
}

async function main() {
  const now = new Date();
  const since = new Date(now.getTime() - 7 * DAY_MS);
  const week = kstIsoWeek(now);

  const { articles, provider, errors } = await collectNews(POLICY_KEYWORDS, since);
  console.log(`[policy] ${provider} 로 ${articles.length}건 수집 (실패 키워드 ${errors.length}개)`);
  errors.forEach((e) => console.warn(`[policy] 수집 실패 — ${e}`));

  let mode: PolicyReport['mode'] = 'raw';
  let body = rawFallback(articles);
  if (aiProvider() && articles.length > 0) {
    try {
      body = await summarize(articles);
      mode = 'ai';
    } catch (err) {
      console.error(`[policy] AI 요약 실패 — 기사 목록으로 대체: ${(err as Error).message}`);
    }
  } else if (!aiProvider()) {
    console.log('[policy] AI 키 없음 — 기사 목록만 저장');
  }

  const report: PolicyReport = {
    week,
    generatedAt: now.toISOString(),
    period: { from: since.toISOString(), to: now.toISOString() },
    mode,
    provider,
    ...body,
    stats: { collected: articles.length, selected: body.items.length, errors: errors.length },
  };

  const dir = join(env.dataDir, 'policy');
  const file = `${week}.json`;
  await writeJSON(join(dir, file), report);

  const indexPath = join(dir, 'index.json');
  const index = await readJSON<PolicyIndexEntry[]>(indexPath, []);
  const entry: PolicyIndexEntry = {
    week,
    file,
    generatedAt: report.generatedAt,
    headline: report.headline,
    count: report.items.length,
  };
  const next = [entry, ...index.filter((e) => e.week !== week)].sort((a, b) => b.week.localeCompare(a.week));
  await writeJSON(indexPath, next);
  console.log(`[policy] 저장: ${join(dir, file)} (${mode}, ${report.items.length}건)`);

  // 업계 공통 리포트: 개발자 채팅 + 알림을 켠 주유소 채팅 (중복 제거)
  const message = toTelegram(report);
  const chats = new Set([env.telegramChatId, ...(await approvedStations()).map((st) => st.telegram_chat_id.trim())].filter(Boolean));
  let sent = false;
  for (const chat of chats) sent = (await sendTelegram(message, chat)) || sent;
  if (!sent) console.log(`\n── 텔레그램 미리보기 ──\n${message}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
