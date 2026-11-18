/**
 * AI 요약 호출
 *  1) GEMINI_API_KEY 가 잡 환경에 있으면 Gemini 직접 호출
 *  2) 없으면 Supabase Edge Function ai-summarize 경유 (Supabase 에 등록한 GEMINI_API_KEY 사용, 서비스 키로 인증)
 *  3) ANTHROPIC_API_KEY 만 있으면 Claude
 */
import { env } from './env.ts';
import { supabaseEnabled } from './supabase.ts';

const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);
const SB_URL = process.env.SUPABASE_URL?.trim() || 'https://srpcirbgrifyvkplmkoe.supabase.co';
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_DATA_KEY || '').trim();

export type AiProvider = 'gemini' | 'gemini-supabase' | 'claude' | null;

export function aiProvider(): AiProvider {
  if (env.geminiKey) return 'gemini';
  if (supabaseEnabled()) return 'gemini-supabase';
  if (env.anthropicKey) return 'claude';
  return null;
}

async function withRetry(label: string, call: () => Promise<Response>, read: (r: Response) => Promise<string>): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const res = await call();
    if (res.ok) return read(res);
    const detail = await res.text();
    if (attempt < 3 && RETRYABLE.has(res.status)) {
      const wait = attempt * 10_000;
      console.warn(`[${label}] ${res.status} — ${wait / 1000}s 후 재시도`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new Error(`${label} ${res.status}: ${detail.slice(0, 500)}`);
  }
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
}

export async function askAI(system: string, user: string, maxTokens = 8192): Promise<string> {
  const provider = aiProvider();
  if (provider === 'gemini') {
    return withRetry(
      'gemini',
      () =>
        fetch(`https://generativelanguage.googleapis.com/v1beta/models/${env.geminiModel}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': env.geminiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: user }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: maxTokens },
          }),
          signal: AbortSignal.timeout(180_000),
        }),
      async (r) => {
        const b = (await r.json()) as GeminiResponse;
        const c = b.candidates?.[0];
        if (c?.finishReason === 'MAX_TOKENS') console.warn('[gemini] 응답이 길이 제한에서 잘렸습니다.');
        return (c?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      },
    );
  }
  if (provider === 'gemini-supabase') {
    return withRetry(
      'gemini(supabase)',
      () =>
        fetch(`${SB_URL}/functions/v1/ai-summarize`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            apikey: SB_KEY,
            ...(SB_KEY.startsWith('eyJ') ? { Authorization: `Bearer ${SB_KEY}` } : {}),
          },
          body: JSON.stringify({ system, user, maxTokens }),
          signal: AbortSignal.timeout(180_000),
        }),
      async (r) => {
        const b = (await r.json()) as { text: string; finishReason: string | null; model: string };
        if (b.finishReason === 'MAX_TOKENS') console.warn('[gemini] 응답이 길이 제한에서 잘렸습니다.');
        console.log(`[ai] ${b.model} (Supabase 경유)`);
        return b.text;
      },
    );
  }
  if (provider === 'claude') {
    return withRetry(
      'claude',
      () =>
        fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': env.anthropicKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: env.anthropicModel, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
          signal: AbortSignal.timeout(120_000),
        }),
      async (r) => {
        const b = (await r.json()) as { content: Array<{ text?: string }> };
        return b.content.map((c) => c.text ?? '').join('');
      },
    );
  }
  throw new Error('AI 키가 없습니다 (GEMINI_API_KEY 또는 SUPABASE_DATA_KEY).');
}

/** 응답에서 첫 JSON 객체를 뽑아 파싱 */
export async function askAIJSON<T>(system: string, user: string, maxTokens?: number): Promise<T> {
  const text = await askAI(system, user, maxTokens);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`JSON 응답이 아닙니다: ${text.slice(0, 300)}`);
  return JSON.parse(text.slice(start, end + 1)) as T;
}
