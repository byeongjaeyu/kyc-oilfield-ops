/** 반복 할 일 — 기한 계산 (대시보드·알림 잡 공용) */
export interface Routine {
  id: string;
  title: string;
  cadence: 'weekly' | 'monthly';
  due_day: number;
  note: string;
  active: boolean;
}

export const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** 오늘(KST, YYYY-MM-DD) 기준 이번 주기의 키와 기한. 주는 월요일에 시작 */
export function currentPeriod(r: Pick<Routine, 'cadence' | 'due_day'>, today: string): { period: string; due: string; daysLeft: number } {
  const t = Date.parse(`${today}T00:00:00Z`);
  if (r.cadence === 'weekly') {
    const dow = new Date(t).getUTCDay(); // 0=일
    const monday = t - ((dow + 6) % 7) * DAY;
    const due = monday + ((r.due_day + 6) % 7) * DAY;
    return { period: iso(monday), due: iso(due), daysLeft: Math.round((due - t) / DAY) };
  }
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const due = Date.UTC(y, m - 1, Math.min(r.due_day, last));
  return { period: today.slice(0, 7), due: iso(due), daysLeft: Math.round((due - t) / DAY) };
}

export const cadenceText = (r: Pick<Routine, 'cadence' | 'due_day'>) => (r.cadence === 'weekly' ? `매주 ${WEEKDAY_KO[r.due_day]}요일` : `매달 ${r.due_day}일`);
