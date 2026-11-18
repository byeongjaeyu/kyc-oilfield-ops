// 주간 뉴스 요약용 Gemini 프록시 — GitHub Actions 잡 전용
//  Gemini 키를 GitHub 에 따로 두지 않도록, Supabase 에 등록한 GEMINI_API_KEY 를 여기서만 씀
//  호출: POST /functions/v1/ai-summarize  헤더 apikey: <서비스(secret) 키>
//  본문: {"system": "...", "user": "...", "maxTokens": 8192}  →  {"text": "...", "model": "...", "usage": {...}}
import { createClient } from 'npm:@supabase/supabase-js@2';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const GEMINI_KEY = Deno.env.get('GEMINI_API_KEY') ?? '';
const MODEL = Deno.env.get('GEMINI_SUMMARY_MODEL') ?? Deno.env.get('GEMINI_MODEL') ?? 'gemini-3.8-flash';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

/** 서비스 키인지 확인: 관리자 API 는 서비스(secret) 키로만 열림 */
async function isServiceKey(key: string) {
  if (!key) return false;
  const { error } = await createClient(SB_URL, key, { auth: { persistSession: false } }).auth.admin.listUsers({ page: 1, perPage: 1 });
  return !error;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const key = req.headers.get('apikey') ?? req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!(await isServiceKey(key))) return json({ error: 'forbidden' }, 403);
  if (!GEMINI_KEY) return json({ error: 'NO_KEY', message: 'Supabase Edge Function Secrets 에 GEMINI_API_KEY 가 없습니다.' }, 503);

  const { system, user, maxTokens } = (await req.json()) as { system: string; user: string; maxTokens?: number };
  if (!system || !user) return json({ error: 'system, user 가 필요합니다.' }, 400);

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: Math.min(maxTokens ?? 8192, 32768) },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return json({ error: 'GEMINI', status: res.status, message: JSON.stringify(body).slice(0, 500) }, 502);
  const cand = body.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('');
  return json({ text, finishReason: cand?.finishReason ?? null, model: MODEL, usage: body.usageMetadata ?? null });
});
