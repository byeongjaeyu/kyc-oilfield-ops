/** 법정 검사·보험 — 데이터 모양과 날짜 계산 (대시보드·알림 잡 공용) */

export type Party = '임차인' | '임대인' | '';
export type Verdict = '적합' | '부적합' | '완료' | '';

export const BUCKET = 'inspection-files';

export interface InspectionResult {
  id: string;
  inspection_id: string;
  done_on: string;
  verdict: Verdict;
  note: string;
  file_path: string | null;
  file_name: string | null;
  file_type: string | null;
  file_size: number | null;
  created_by: string | null;
  created_at: string;
}

export interface Inspection {
  id: string;
  name: string;
  due: string | null;
  cycle_months: number | null;
  party: Party;
  agency: string;
  note: string;
  updated_at: string;
  inspection_results: InspectionResult[];
}

/** KST 오늘 YYYY-MM-DD */
export const todayKst = (now = new Date()) => new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);

/** 남은 일수 (오늘 0, 지났으면 음수) */
export function daysUntil(due: string, today = todayKst()): number {
  return Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** 월 더하기 — 말일 보정 (1/31 + 1개월 = 2/28) */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

export const lastResult = (it: Pick<Inspection, 'inspection_results'>) =>
  [...it.inspection_results].sort((a, b) => b.done_on.localeCompare(a.done_on))[0] as InspectionResult | undefined;
