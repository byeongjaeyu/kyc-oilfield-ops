// 계약서(PDF·사진) → Gemini → 계약 종류·만기·갱신·인상·원상복구 등 항목 + 계약서 원문 인용
// 계약서가 속한 주유소에서 계약 수정 권한이 있는 회원만 호출 가능. 결과는 저장하지 않고 돌려주기만 함 (화면에서 사람이 확인 후 저장)
import { createClient } from 'npm:@supabase/supabase-js@2';
import { encodeBase64 } from 'jsr:@std/encoding@1/base64';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GEMINI_KEY = Deno.env.get('GEMINI_API_KEY') ?? '';
const MODEL = Deno.env.get('GEMINI_MODEL') ?? 'gemini-3.8-flash';
// Gemini 인라인 전송 한도(요청 전체 20MB)를 넘지 않게
const MAX_BYTES = 19 * 1024 * 1024;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const SYSTEM = `당신은 주유소 운영과 관련된 계약서를 읽는 꼼꼼한 검토자입니다. 임대차 계약뿐 아니라 정유사 상표·공급 계약, 세차기·카드단말기 같은 렌탈·리스, 유지보수·보안·보험 계약도 읽습니다. 아래 항목을 뽑습니다.

규칙:
- 계약서에 실제로 적힌 내용만 씁니다. 없으면 null. 추측하지 마세요.
- kind: 계약 종류. lease(부지·시설 임대차) | supply(정유사 상표·공급) | rental(렌탈·리스) | service(유지보수·보안·보험 등 용역) | etc 중 하나.
- tenant_name: 임대차면 임차인, 그 밖의 계약이면 상대 업체 이름.
- 날짜는 YYYY-MM-DD. "계약일로부터 5년"처럼 계산이 필요한 경우 계산하고 uncertain 에 넣습니다.
- 금액은 원 단위 정수 (예: "금 오천만원정" → 50000000). 부가세 별도/포함 여부를 vat_included 에 (true=포함, false=별도).
- deposit: 보증금·담보 금액. monthly_rent: 매월 내는 금액 (임대료·렌탈료·월 요금). 매월 정해진 금액이 없으면 null.
- rent_due_day: 매월 지급·결제일 (예: 매월 25일 → 25).
- renewal_notice_days: 만기 며칠 전까지 갱신(또는 해지) 의사를 통지해야 하는지. "3개월 전" → 90.
- 인상 조항: increase_rate(%), increase_every_months(몇 개월마다), next_increase_date(다음 인상일, 계산 필요하면 계산), increase_rule(조항 요약 한 문장, 예: "2년마다 소비자물가상승률만큼, 최대 5%").
- restoration: 임대차의 원상복구 조항 요약 1~2문장. restoration_items: 범위에 든 것 (예: "토양정화", "지하탱크 철거", "캐노피 철거"). 임대차가 아니면 null 과 [].
- quotes: 각 항목을 뽑은 근거가 되는 계약서 원문을 그대로 인용 (항목 이름을 키로, 200자 이내). 원문이 없으면 넣지 않습니다.
- uncertain: 확신이 없거나 계산·해석이 들어간 항목 이름 목록.
- notes: 사장님이 알아야 할 특이 조항(중도해지 위약금, 최소 구매량, 독점 공급, 전대 금지, 담보·보증보험 등)을 짧게.

반드시 아래 JSON 하나만 출력하세요:
{"kind": string, "title": string|null, "tenant_name": string|null, "start_date": string|null, "end_date": string|null,
 "deposit": number|null, "monthly_rent": number|null, "vat_included": boolean|null, "rent_due_day": number|null,
 "auto_renew": boolean|null, "renewal_notice_days": number|null,
 "increase_rate": number|null, "increase_every_months": number|null, "next_increase_date": string|null, "increase_rule": string|null,
 "restoration": string|null, "restoration_items": string[],
 "quotes": {[field: string]: string}, "uncertain": string[], "notes": string}`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const userClient = createClient(SB_URL, ANON, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: userData } = await userClient.auth.getUser();
    if (!userData.user) return json({ error: '로그인이 필요합니다.' }, 401);
    const { path } = (await req.json()) as { path?: string };
    if (!path) return json({ error: 'path 가 필요합니다.' }, 400);

    // 파일이 붙은 계약서(사용자 권한으로 보이는 것)의 주유소에서 계약 수정 권한이 있어야 함
    const { data: contract } = await userClient.from('contracts').select('station_id').eq('file_path', path).maybeSingle();
    let allowed = false;
    if (contract) {
      const { data: perms } = await userClient.rpc('my_permissions', { sid: contract.station_id });
      allowed = (perms ?? []).some((p: { area: string; can_write: boolean }) => p.area === 'contracts' && p.can_write);
    }
    if (!allowed) return json({ error: '계약 일정 수정 권한이 없습니다.' }, 403);

    if (!GEMINI_KEY) {
      return json({ error: 'NO_KEY', message: 'AI 추출용 GEMINI_API_KEY 가 Supabase 에 아직 없습니다. 항목을 직접 입력해 주세요.' }, 503);
    }

    const admin = createClient(SB_URL, SERVICE);
    const { data: ok, error: limitErr } = await admin.rpc('bump_usage', { uid: userData.user.id, fn: 'extract-contract', per_user: 20, total: 100 });
    if (!limitErr && ok === false) return json({ error: 'LIMIT', message: '오늘 AI 읽기 한도를 다 썼습니다. 항목을 직접 입력하거나 내일 다시 해 주세요.' }, 429);
    const { data: file, error } = await admin.storage.from('contract-files').download(path);
    if (error || !file) return json({ error: `계약서 파일을 읽지 못했습니다: ${error?.message}` }, 400);
    if (file.size > MAX_BYTES) return json({ error: '파일이 19MB 를 넘어 AI로 읽을 수 없습니다. 스캔 해상도를 낮춰 다시 올리거나 직접 입력해 주세요.' }, 413);

    const isPdf = file.type === 'application/pdf' || path.toLowerCase().endsWith('.pdf');
    const mime = isPdf ? 'application/pdf' : file.type || 'image/jpeg';
    const data = encodeBase64(new Uint8Array(await file.arrayBuffer()));

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [
          {
            role: 'user',
            parts: [{ inline_data: { mime_type: mime, data } }, { text: '이 계약서에서 항목을 뽑아 JSON 으로만 답하세요.' }],
          },
        ],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
    });
    const body = await res.json();
    if (!res.ok) return json({ error: `AI 호출 실패 (${res.status}): ${body?.error?.message ?? ''}` }, 502);

    const cand = body.candidates?.[0];
    const text: string = (cand?.content?.parts ?? []).map((p: { text?: string; thought?: boolean }) => (p.thought ? '' : p.text ?? '')).join('');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) {
      return json({ error: `AI 응답에서 결과를 찾지 못했습니다 (${cand?.finishReason ?? body?.promptFeedback?.blockReason ?? '원인 미상'}).` }, 502);
    }
    return json({ fields: JSON.parse(text.slice(start, end + 1)), model: MODEL, usage: body.usageMetadata ?? null });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
