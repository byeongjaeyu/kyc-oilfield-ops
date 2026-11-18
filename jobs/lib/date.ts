const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** KST 기준 YYYY-MM-DD */
export function kstDate(d: Date = new Date()): string {
  return new Date(d.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** KST 기준 ISO 주차, 예: 2026-W47 */
export function kstIsoWeek(d: Date = new Date()): string {
  const k = new Date(d.getTime() + KST_OFFSET_MS);
  const date = new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** 11/09 형식 (KST) */
export function kstShort(d: Date): string {
  const [, m, day] = kstDate(d).split('-');
  return `${m}/${day}`;
}
