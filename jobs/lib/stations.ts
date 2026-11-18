/**
 * 승인된 주유소 목록 (잡이 주유소별로 돌 때 사용)
 *  - Supabase 키가 있으면 stations 테이블, 없으면 로컬 테스트용 주유소 하나 (config 기본값)
 *  - 주유소별 데이터 키: st/<주유소 id>/<영역>/… (datasets RLS 가 이 형식으로 권한을 판단)
 */
import { join } from 'node:path';
import { env } from './env.ts';
import { rest, supabaseEnabled } from './supabase.ts';

export interface StationRow {
  id: string;
  name: string;
  address: string;
  jibun_address: string;
  opinet_id: string | null;
  brand: string;
  katec_x: number | null;
  katec_y: number | null;
  lawd_cd: string | null;
  dong: string;
  nearby_dongs: string[];
  land_keywords: string[];
  is_demo: boolean;
  telegram_chat_id: string;
}

/** Supabase 없이 로컬에서 돌릴 때 쓸 주유소 (값은 환경 변수로) */
const LOCAL: StationRow = {
  id: 'local',
  name: process.env.LOCAL_STATION_NAME ?? '예시 주유소',
  address: process.env.LOCAL_STATION_ADDRESS ?? '',
  jibun_address: '',
  opinet_id: process.env.LOCAL_OPINET_ID ?? null,
  brand: '',
  katec_x: Number(process.env.LOCAL_KATEC_X) || null,
  katec_y: Number(process.env.LOCAL_KATEC_Y) || null,
  lawd_cd: process.env.LOCAL_LAWD_CD ?? null,
  dong: process.env.LOCAL_DONG ?? '',
  nearby_dongs: [],
  land_keywords: [],
  is_demo: true,
  telegram_chat_id: '',
};

export async function approvedStations(): Promise<StationRow[]> {
  if (!supabaseEnabled()) return [LOCAL];
  return rest<StationRow[]>(
    'stations?select=id,name,address,jibun_address,opinet_id,brand,katec_x,katec_y,lawd_cd,dong,nearby_dongs,land_keywords,is_demo,telegram_chat_id' +
      '&status=eq.approved&order=created_at.asc',
  );
}

export const stationDir = (s: Pick<StationRow, 'id'>, area: string) => join(env.dataDir, 'st', s.id, area);

/** 알림 받을 채팅: 주유소가 정한 채팅. 데모만 개발자 채팅(TELEGRAM_CHAT_ID)으로 */
export const chatIdFor = (s: Pick<StationRow, 'telegram_chat_id' | 'is_demo'>) =>
  s.telegram_chat_id.trim() || (s.is_demo ? env.telegramChatId : '');

/** 주소에서 시·군·구 이름 (예: "광주 북구 운암동 123" → "북구") */
export function regionOf(address: string): string {
  const tokens = address.split(/\s+/).filter(Boolean);
  return tokens.slice(1).find((t) => /(구|군)$/.test(t)) ?? tokens.slice(1).find((t) => /시$/.test(t)) ?? tokens[0] ?? '';
}

/** 같은 값을 쓰는 주유소끼리 묶음 (데모와 실제 주유소가 같은 위치면 수집을 한 번만) */
export function groupBy<T>(items: T[], key: (t: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    if (k == null) continue;
    out.set(k, [...(out.get(k) ?? []), it]);
  }
  return out;
}
