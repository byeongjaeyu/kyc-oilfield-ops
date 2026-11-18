// 주유소 등록 신청 화면: 오피넷에서 주유소 이름으로 검색
//  GET /functions/v1/opinet-search?q=<이름>   (로그인한 사용자만)
//  → { stations: [{ id, name, brand, address, jibun, x, y, taken }] }
//  오피넷 키는 Edge Function Secrets 의 OPINET_API_KEY, 없으면 app_secrets 테이블
import { createClient } from 'npm:@supabase/supabase-js@2';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
let KEY = Deno.env.get('OPINET_API_KEY') ?? '';

/** 함수 시크릿에 없으면 app_secrets 테이블(서버 전용)에서 — GitHub Actions 가 넣어 둠 */
async function opinetKey() {
  if (KEY || !SERVICE) return KEY;
  const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });
  const { data } = await admin.from('app_secrets').select('value').eq('name', 'OPINET_API_KEY').maybeSingle();
  KEY = data?.value ?? '';
  return KEY;
}

const BRANDS: Record<string, string> = {
  SKE: 'SK에너지', GSC: 'GS칼텍스', HDO: 'HD현대오일뱅크', SOL: 'S-OIL', RTO: '자영알뜰', RTX: '고속도로알뜰',
  NHO: '농협알뜰', ETC: '자가상표', E1G: 'E1', SKG: 'SK가스',
};

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });

interface Oil {
  UNI_ID: string;
  POLL_DIV_CD?: string;
  OS_NM: string;
  VAN_ADR?: string;
  NEW_ADR?: string;
  GIS_X_COOR?: number | string;
  GIS_Y_COOR?: number | string;
}

async function opinet(path: string, params: Record<string, string>): Promise<Oil[]> {
  const qs = new URLSearchParams({ code: KEY, out: 'json', ...params });
  for (const base of ['https://www.opinet.co.kr/api', 'http://www.opinet.co.kr/api']) {
    try {
      const res = await fetch(`${base}/${path}?${qs}`, { signal: AbortSignal.timeout(15_000) });
      const body = JSON.parse(await res.text());
      return body?.RESULT?.OIL ?? [];
    } catch {
      continue;
    }
  }
  throw new Error('오피넷에 연결하지 못했습니다.');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const user = createClient(SB_URL, ANON, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
  const { data: u } = await user.auth.getUser();
  if (!u.user) return json({ error: '로그인이 필요합니다.' }, 401);
  if (!(await opinetKey())) return json({ error: 'NO_KEY', message: '오피넷 검색이 아직 설정되지 않았습니다. 주유소 이름과 주소를 직접 입력해 주세요.' }, 503);

  const q = (new URL(req.url).searchParams.get('q') ?? '').trim();
  if (q.length < 2) return json({ error: '주유소 이름을 두 글자 이상 넣어 주세요.' }, 400);

  // 오피넷 키는 하루 호출 수가 정해져 있어 가격 수집이 막히지 않도록 검색 한도를 둠
  if (SERVICE) {
    const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });
    const { data: ok, error } = await admin.rpc('bump_usage', { uid: u.user.id, fn: 'opinet-search', per_user: 150, total: 800 });
    if (!error && ok === false) return json({ error: 'LIMIT', message: '오늘 검색을 너무 많이 했습니다. 내일 다시 하거나 주유소 이름과 주소를 직접 입력해 주세요.' }, 429);
  }

  try {
    const list = (await opinet('searchByName.do', { osnm: q.slice(0, 30) })).slice(0, 30);
    const stations = await Promise.all(
      list.map(async (o) => {
        const { data: taken } = await user.rpc('station_taken', { oid: o.UNI_ID });
        return {
          id: o.UNI_ID,
          name: o.OS_NM,
          brand: BRANDS[o.POLL_DIV_CD ?? ''] ?? o.POLL_DIV_CD ?? '',
          address: o.NEW_ADR ?? '',
          jibun: o.VAN_ADR ?? '',
          x: Number(o.GIS_X_COOR) || null,
          y: Number(o.GIS_Y_COOR) || null,
          taken: !!taken,
        };
      }),
    );
    return json({ stations });
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});
