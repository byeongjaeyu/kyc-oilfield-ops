import { readFile } from 'node:fs/promises';
import { env } from './env.ts';

export interface Article {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedAt: string; // ISO
  description: string;
  keyword: string;
}

type RawArticle = Omit<Article, 'id'>;

const ENTITIES: Record<string, string> = {
  '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
};

export function cleanText(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&(quot|amp|lt|gt|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ── 네이버 뉴스 검색 API ─────────────────────────────────────────────
interface NaverItem { title: string; originallink: string; link: string; description: string; pubDate: string }

async function fetchNaver(keyword: string): Promise<RawArticle[]> {
  const url = new URL('https://openapi.naver.com/v1/search/news.json');
  url.searchParams.set('query', keyword);
  url.searchParams.set('display', '30');
  url.searchParams.set('sort', 'date');
  const res = await fetch(url, {
    headers: { 'X-Naver-Client-Id': env.naverClientId, 'X-Naver-Client-Secret': env.naverClientSecret },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Naver ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { items: NaverItem[] };
  return body.items.map((it) => {
    const link = it.originallink || it.link;
    return {
      title: cleanText(it.title),
      url: link,
      source: hostOf(link),
      publishedAt: new Date(it.pubDate).toISOString(),
      description: cleanText(it.description),
      keyword,
    };
  });
}

// ── Google 뉴스 RSS (키 불필요, 대체 수단) ──────────────────────────
function tag(xml: string, name: string): string {
  return xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? '';
}

async function fetchGoogleRss(keyword: string): Promise<RawArticle[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=ko&gl=KR&ceid=KR:ko`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Google RSS ${res.status}`);
  const xml = await res.text();
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  return items.map((item) => {
    const source = cleanText(tag(item, 'source'));
    let title = cleanText(tag(item, 'title'));
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    return {
      title,
      url: cleanText(tag(item, 'link')),
      source,
      publishedAt: new Date(cleanText(tag(item, 'pubDate'))).toISOString(),
      description: '',
      keyword,
    };
  });
}

// ── 수집 + 정리 ─────────────────────────────────────────────────────
const normTitle = (t: string) => t.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 20);

export interface CollectResult {
  articles: Article[];
  provider: 'naver' | 'google-rss' | 'fixture';
  errors: string[];
}

export async function collectNews(keywords: string[], since: Date, perKeyword = 12): Promise<CollectResult> {
  const errors: string[] = [];
  let provider: CollectResult['provider'];
  let raw: RawArticle[] = [];

  if (env.newsFixture) {
    provider = 'fixture';
    raw = JSON.parse(await readFile(env.newsFixture, 'utf8')) as RawArticle[];
  } else {
    provider = env.naverClientId && env.naverClientSecret ? 'naver' : 'google-rss';
    const fetcher = provider === 'naver' ? fetchNaver : fetchGoogleRss;
    for (const kw of keywords) {
      try {
        const list = (await fetcher(kw))
          .filter((a) => new Date(a.publishedAt) >= since)
          .slice(0, perKeyword);
        raw.push(...list);
      } catch (err) {
        errors.push(`${kw}: ${(err as Error).message}`);
      }
    }
    if (errors.length === keywords.length) {
      throw new Error(`모든 키워드 수집 실패 (${provider})\n${errors.join('\n')}`);
    }
  }

  // 중복 제거 (URL 또는 제목 앞부분 기준)
  const seenUrl = new Set<string>();
  const seenTitle = new Set<string>();
  const articles: Article[] = [];
  for (const a of raw.sort((x, y) => y.publishedAt.localeCompare(x.publishedAt))) {
    const t = normTitle(a.title);
    if (!a.title || seenUrl.has(a.url) || seenTitle.has(t)) continue;
    seenUrl.add(a.url);
    seenTitle.add(t);
    articles.push({ ...a, id: `a${articles.length + 1}` });
  }
  return { articles, provider, errors };
}
