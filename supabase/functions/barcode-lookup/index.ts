// 바코드 숫자로 상품 이름 찾기 — 우리 주유소 품목에 아직 연결 안 된 바코드를 찍었을 때
//  1) 이전에 찾은 결과(barcode_products) 재사용
//  2) 없으면 Gemini + Google 검색으로 상품명·용량을 찾아 저장
//  호출: POST /functions/v1/barcode-lookup  (로그인한 주유소 구성원만)  본문 {"code": "8801234567890"}
//  응답: {"found": true, "name": "...", "brand": "...", "spec": "...", "category": "...", "unit": "...", "source": "..."}
import { createClient } from 'npm:@supabase/supabase-js@2';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GEMINI_KEY = Deno.env.get('GEMINI_API_KEY') ?? '';
const MODEL = Deno.env.get('GEMINI_MODEL') ?? 'gemini-3.8-flash';
const CATEGORIES = ['판매 상품', '고객 서비스', '주유·운영', '화장실·청소', '안전·환경', '세차', '기타'];
const MISS_RETRY_DAYS = 7; // 못 찾은 바코드는 일주일 뒤 다시 찾아봄

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });

const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

/** GS1 체크 숫자 확인 (EAN-13·EAN-8·UPC-A·GTIN-14) — 잘못 읽힌 숫자로 검색하지 않게 */
function gtinOk(code: string) {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return null; // 숫자 바코드가 아니면 판단하지 않음
  const d = code.split('').map(Number);
  const check = d.pop()!;
  const sum = d.reverse().reduce((s, x, i) => s + x * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

function parseJson(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

async function askGemini(code: string) {
  const prompt = [
    `바코드(GTIN/EAN) "${code}" 인 상품을 웹에서 찾아 주세요.`,
    '바코드 숫자가 정확히 일치하는 판매·상품정보 페이지에서 확인된 경우에만 found 를 true 로 하세요. 추측이면 false.',
    '아래 JSON 하나만 답하세요 (설명 문장 없이):',
    '{"found": true|false, "name": "한국에서 부르는 상품명 (브랜드 포함, 용량 포함)", "brand": "브랜드", "spec": "용량·규격 (예: 500ml)",',
    ` "category": "${CATEGORIES.join('|')} 중 주유소 소모품으로 가장 맞는 것", "unit": "개|통|병|박스|팩|롤|장 중 하나", "source": "확인한 페이지 주소"}`,
  ].join('\n');
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0 },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GEMINI ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  const cand = body.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('');
  const out = parseJson(text) ?? { found: false };
  // 출처가 비어 있으면 검색 근거의 첫 페이지로
  const chunk = cand?.groundingMetadata?.groundingChunks?.find((c: { web?: { uri?: string } }) => c.web?.uri);
  if (!out.source && chunk) out.source = chunk.web.uri;
  return out;
}

const str = (v: unknown, max = 120) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // 로그인한 사람이 어느 주유소든 구성원이어야 함
  const jwt = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const { data: u } = await admin.auth.getUser(jwt);
  if (!u?.user) return json({ error: 'LOGIN' }, 401);
  const { count } = await admin.from('station_members').select('station_id', { count: 'exact', head: true }).eq('user_id', u.user.id);
  if (!count) return json({ error: 'forbidden' }, 403);

  const { code: raw } = (await req.json().catch(() => ({}))) as { code?: string };
  const code = String(raw ?? '').trim();
  if (!/^[0-9A-Za-z-]{4,40}$/.test(code)) return json({ error: 'BAD_CODE' }, 400);
  if (gtinOk(code) === false) return json({ found: false, reason: 'CHECK_DIGIT' });

  const { data: hit } = await admin.from('barcode_products').select('*').eq('code', code).maybeSingle();
  const fresh = hit && (hit.found || Date.now() - Date.parse(hit.looked_up_at) < MISS_RETRY_DAYS * 864e5);
  if (fresh) return json({ ...hit, cached: true });

  if (!GEMINI_KEY) return json({ found: false, reason: 'NO_KEY' });
  // AI 검색은 돈이 드니 하루 한도 (캐시에 있는 바코드는 세지 않음)
  const { data: ok, error: limitErr } = await admin.rpc('bump_usage', { uid: u.user.id, fn: 'barcode-lookup', per_user: 60, total: 400 });
  if (!limitErr && ok === false) return json({ found: false, reason: 'LIMIT' });
  try {
    const g = await askGemini(code);
    const row = {
      code,
      found: g.found === true && !!str(g.name),
      name: str(g.name),
      brand: str(g.brand, 60),
      spec: str(g.spec, 40),
      category: CATEGORIES.includes(String(g.category)) ? String(g.category) : null,
      unit: str(g.unit, 10),
      source: str(g.source, 500),
      looked_up_at: new Date().toISOString(),
    };
    await admin.from('barcode_products').upsert(row);
    return json(row);
  } catch (e) {
    return json({ found: false, reason: 'LOOKUP_FAILED', message: String(e).slice(0, 300) });
  }
});
