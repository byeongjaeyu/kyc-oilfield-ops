import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createDemoClient, setRealClient } from './demo/client';

// 공개(publishable) 키 — 브라우저에 두는 용도. 데이터 접근은 로그인 + RLS 로 막는다.
export const SUPABASE_URL = 'https://srpcirbgrifyvkplmkoe.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_Jw1-cGPwZDneyrtPwEYccA_u6-3GZyM';

// ── 마지막 요청 시각 기록 (사이트 관리자의 접속 탭) ──
//  로그인한 사람이 서버에 데이터를 요청할 때마다, 최대 1분에 한 번 touch_activity 로 남김
export const activity = { signedIn: false, sid: null as string | null };
const TOUCH_EVERY = 60_000;
let lastTouch = 0;
let touchTimer: number | undefined;
function touchNow() {
  touchTimer = undefined;
  if (!activity.signedIn) return;
  lastTouch = Date.now();
  const dev = matchMedia('(pointer: coarse)').matches || innerWidth < 700 ? 'mobile' : 'desktop';
  realClient.rpc('touch_activity', { sid: activity.sid, dev }).then(() => undefined);
}
/** 요청이 있었음을 알림: 1분이 지났으면 바로, 아니면 1분 채울 때 한 번 */
export function markActivity() {
  if (!activity.signedIn || touchTimer !== undefined) return;
  const wait = lastTouch + TOUCH_EVERY - Date.now();
  if (wait <= 0) touchNow();
  else touchTimer = window.setTimeout(touchNow, wait);
}
const fetchWithActivity: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (/\/(rest|functions|storage)\/v1\//.test(url) && !url.includes('touch_activity')) markActivity();
  return res;
};

const realClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  global: { fetch: fetchWithActivity },
  auth: {
    // 메일 앱이 다른 브라우저로 링크를 열어도 로그인되도록 implicit 흐름
    flowType: 'implicit',
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
setRealClient(realClient);

// ── 로그인 전 데모 ── 이 탭에서 "로그인 없이 둘러보기"를 누르면 브라우저 안 예시 장부로 바꿔 끼움
const DEMO_FLAG = 'demo:on';
export const isDemo = () => {
  try {
    return sessionStorage.getItem(DEMO_FLAG) === '1';
  } catch {
    return false;
  }
};
export function startDemo() {
  try {
    sessionStorage.setItem(DEMO_FLAG, '1');
  } catch {
    /* 저장소 없음 */
  }
  location.hash = '#prices';
  location.reload();
}
export function exitDemo() {
  try {
    sessionStorage.removeItem(DEMO_FLAG);
    sessionStorage.removeItem('demo:db:v2');
  } catch {
    /* 저장소 없음 */
  }
  location.hash = '';
  location.reload();
}
const demoClient = createDemoClient(exitDemo);

/** 앱 전체가 쓰는 클라이언트: 데모면 예시 장부, 아니면 실제 서버 */
export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get: (_t, k) => {
    const c = (isDemo() ? demoClient : realClient) as unknown as Record<PropertyKey, unknown>;
    const v = c[k];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(c) : v;
  },
});

export type Role = 'owner' | 'tenant';

export interface Profile {
  id: string;
  email: string;
  name: string;
  is_site_admin: boolean;
}

export type StationStatus = 'pending' | 'approved' | 'rejected' | 'suspended';

export interface Station {
  id: string;
  name: string;
  address: string;
  jibun_address: string;
  opinet_id: string | null;
  brand: string;
  lawd_cd: string | null;
  dong: string;
  biz_no: string;
  biz_doc_path: string | null;
  biz_doc_name: string | null;
  applicant_role: Role;
  applicant_email: string;
  applied_by: string | null;
  status: StationStatus;
  review_note: string;
  reviewed_at: string | null;
  is_demo: boolean;
  /** leased: 임대인·임차인이 따로, self: 소유자가 직접 운영 */
  operation: 'leased' | 'self';
  telegram_chat_id: string;
  created_at: string;
}

export const STATUS_KO: Record<StationStatus, string> = {
  pending: '검토 중',
  approved: '승인',
  rejected: '반려',
  suspended: '이용 중지',
};

/** 내가 회원인 주유소 (역할이 둘이면 roles 에 둘 다) */
export interface Membership {
  station: Station;
  roles: Role[];
  managerRoles: Role[];
}

export const bizNoFmt = (n: string) => (n.length === 10 ? `${n.slice(0, 3)}-${n.slice(3, 5)}-${n.slice(5)}` : n);

export const ROLE_KO: Record<Role, string> = { owner: '임대인', tenant: '임차인' };

export type Area = 'prices' | 'land' | 'policy' | 'contracts' | 'inspections' | 'payments' | 'supplies' | 'fuel';
export type Perms = Record<Area, { read: boolean; write: boolean }>;
export const AREA_KO: Record<Area, string> = {
  prices: '가격 비교',
  land: '부지 가치',
  policy: '정책 요약',
  inspections: '법정 검사',
  contracts: '계약 일정',
  payments: '입금 확인',
  supplies: '소모품',
  fuel: '유류 장부',
};
export const ALL_PERMS: Perms = {
  prices: { read: true, write: true },
  land: { read: true, write: true },
  policy: { read: true, write: true },
  contracts: { read: true, write: true },
  inspections: { read: true, write: true },
  payments: { read: true, write: true },
  supplies: { read: true, write: true },
  fuel: { read: true, write: true },
};
