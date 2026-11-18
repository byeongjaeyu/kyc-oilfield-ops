// 소모품 화면들이 같이 쓰는 타입·도우미
export type Method = 'sms' | 'email' | 'kakao' | 'phone' | 'etc';
export interface Vendor {
  id: string;
  name: string;
  contact_name: string;
  phone: string;
  email: string;
  order_method: Method;
  note: string;
}
export interface Item {
  id: string;
  name: string;
  category: string;
  unit: string;
  barcode: string | null;
  vendor_id: string | null;
  stock: number;
  reorder_point: number;
  order_qty: number;
  unit_cost: number | null;
  sell_price: number | null;
  active: boolean;
  note: string;
}
export interface Move {
  id: string;
  item_id: string;
  kind: 'in' | 'out' | 'count' | 'adjust';
  qty: number;
  stock_before: number | null;
  stock_after: number | null;
  note: string;
  vendor_id?: string | null;
  unit_cost?: number | null;
  order_id?: string | null;
  created_at: string;
}
export interface OrderLine {
  item_id: string;
  name: string;
  qty: number;
  unit: string;
}
export interface Order {
  id: string;
  vendor_id: string | null;
  vendor_name: string;
  status: 'draft' | 'sent' | 'received' | 'cancelled';
  lines: OrderLine[];
  message: string;
  sent_at: string | null;
  received_at: string | null;
  created_at: string;
}
export interface Settlement {
  vendor_id: string;
  month: string; // YYYY-MM-01
  amount: number;
  note: string;
  settled_at: string;
}

export const METHOD_KO: Record<Method, string> = { sms: '문자', email: '이메일', kakao: '카카오톡', phone: '전화', etc: '기타' };
export const MOVE_KO: Record<Move['kind'], string> = { in: '입고', out: '판매·사용', count: '실사', adjust: '보정' };
export const n = (v: number | string | null | undefined) => Number(v ?? 0);
export const qtyFmt = (v: number) => (Number.isInteger(v) ? v.toLocaleString('ko-KR') : v.toLocaleString('ko-KR', { maximumFractionDigits: 2 }));
export const won = (v: number) => `${Math.round(v).toLocaleString('ko-KR')}원`;
/** 32만 원, 1,250원 처럼 짧게 */
export const wonShort = (v: number) => (v >= 100_000 ? `${Math.round(v / 10_000).toLocaleString('ko-KR')}만 원` : won(v));
export const isLow = (i: Item) => i.active && n(i.reorder_point) > 0 && n(i.stock) <= n(i.reorder_point);
export const telOf = (v?: Vendor) => v?.phone.replace(/[^\d+]/g, '') ?? '';

// ── 달 (한국 시간) ──
const kst = (d = new Date()) => new Date(d.getTime() + 9 * 3_600_000);
/** '2026-11' */
export const monthOf = (iso?: string) => kst(iso ? new Date(iso) : new Date()).toISOString().slice(0, 7);
export const addMonth = (ym: string, k: number) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + k, 1));
  return d.toISOString().slice(0, 7);
};
export const monthStartIso = (ym: string) => new Date(`${ym}-01T00:00:00+09:00`).toISOString();
export const monthKo = (ym: string) => `${Number(ym.slice(5, 7))}월`;
export const monthKoFull = (ym: string) => `${ym.slice(0, 4)}년 ${Number(ym.slice(5, 7))}월`;
export const dayKo = (iso: string) => {
  const d = kst(new Date(iso));
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};

/** 정산에 들어가는 기록: 입고, 그리고 카운터에서 입고를 되돌린 것(음수) */
export const isPurchase = (m: Move) => m.kind === 'in' || (m.kind === 'adjust' && m.note === '카운터 되돌리기' && n(m.qty) < 0);
export const amountOf = (m: Move) => (m.unit_cost == null ? 0 : n(m.qty) * n(m.unit_cost));

export interface VendorMonth {
  total: number;
  count: number;
  missing: number; // 단가 없는 기록 수
}
export function vendorMonth(moves: Move[], vendorId: string, ym: string): VendorMonth {
  const mine = moves.filter((m) => m.vendor_id === vendorId && isPurchase(m) && monthOf(m.created_at) === ym);
  return {
    total: mine.reduce((s, m) => s + amountOf(m), 0),
    count: mine.filter((m) => m.kind === 'in').length,
    missing: mine.filter((m) => m.kind === 'in' && m.unit_cost == null).length,
  };
}
