/**
 * Supabase REST (서비스 키) — Actions 잡 전용. 키는 GitHub Secrets 의 SUPABASE_DATA_KEY.
 * 서비스 키는 RLS 를 건너뛰므로 브라우저 코드에는 절대 넣지 않는다.
 */
const URL_ = process.env.SUPABASE_URL?.trim() || 'https://srpcirbgrifyvkplmkoe.supabase.co';
const KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_DATA_KEY || '').trim();

export const supabaseEnabled = () => KEY.length > 0;

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { apikey: KEY, 'Content-Type': 'application/json', ...extra };
  // 예전 JWT 형식 키는 Authorization 에도 넣어야 함 (새 sb_secret_ 키는 apikey 만으로 충분)
  if (KEY.startsWith('eyJ')) h.Authorization = `Bearer ${KEY}`;
  return h;
}

export async function rest<T>(path: string, init: RequestInit & { prefer?: string } = {}): Promise<T> {
  if (!KEY) throw new Error('SUPABASE_DATA_KEY(서비스 키)가 없습니다.');
  const { prefer, ...rest } = init;
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    ...rest,
    headers: headers(prefer ? { Prefer: prefer } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (res.status === 401) {
    // 값은 숨기고 형식만 알려 줌
    const kind = KEY.startsWith('sb_secret_') ? 'sb_secret_ 키' : KEY.startsWith('sb_publishable_') ? 'publishable(공개) 키 — 서비스 키가 아님' : KEY.startsWith('eyJ') ? 'JWT 형식 키' : '알 수 없는 형식(키가 아닌 값일 수 있음)';
    throw new Error(`Supabase 키가 거부됐습니다 (${kind}, ${KEY.length}자). Supabase 프로젝트의 Secret key(sb_secret_…) 또는 service_role 키를 SUPABASE_DATA_KEY 에 넣어 주세요. 응답: ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`Supabase ${res.status} ${path}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** 저장소 파일 지우기 (서비스 키) */
export async function storageRemove(bucket: string, paths: string[]): Promise<void> {
  if (!KEY) throw new Error('SUPABASE_DATA_KEY(서비스 키)가 없습니다.');
  if (!paths.length) return;
  const res = await fetch(`${URL_}/storage/v1/object/${bucket}`, {
    method: 'DELETE',
    headers: headers(),
    body: JSON.stringify({ prefixes: paths }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Storage ${res.status} ${bucket}: ${(await res.text()).slice(0, 200)}`);
}
