/**
 * 로그인 전 데모용 가짜 Supabase 클라이언트 — 브라우저 안에서만 도는 예시 장부
 *  · 장부(계약·입금·소모품·유류 장부 등)는 fixtures 로 시작해 이 탭 안에서만 바뀜 (sessionStorage)
 *  · 수집 데이터(가격·시세·부지·정책)는 실제 서버의 demo/… 키를 읽음 (이름을 가린 공개용 복사본)
 *  · 파일 올리기·AI·이메일은 쓰지 않음
 * 앱이 쓰는 supabase-js 기능만 흉내 냄: from().select/insert/update/upsert/delete + eq/neq/in/gte/lte/gt/lt/order/limit/single/maybeSingle, rpc, auth, storage, functions, channel
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SupabaseClient } from '@supabase/supabase-js';
import { DEMO_SID, DEMO_UID, makeFixtures } from './fixtures';

type Row = Record<string, any>;
type Db = Record<string, Row[]>;
type Res = { data: any; error: { message: string; code?: string } | null; count?: number | null };

const STORE_KEY = 'demo:db:v5';
const NO_ID = new Set(['station_members', 'station_permissions', 'station_invites', 'fuel_settings', 'fuel_tanks', 'daily_closes', 'routine_checks', 'site_config', 'bank_webhooks', 'calendar_feeds', 'profiles', 'supply_settlements', 'chat_profiles']);
const CONFLICT: Record<string, string[]> = {
  chat_profiles: ['user_id'],
  station_members: ['station_id', 'user_id', 'role'],
  station_permissions: ['station_id', 'role', 'area'],
  fuel_settings: ['station_id'],
  fuel_tanks: ['station_id', 'fuel'],
  daily_closes: ['station_id', 'close_on'],
  routine_checks: ['routine_id', 'period'],
};
const OFF = '데모에서는 쓸 수 없는 기능입니다. 로그인하면 쓸 수 있습니다.';

const uuid = () =>
  (crypto as Crypto & { randomUUID?: () => string }).randomUUID?.() ??
  'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => ((Math.random() * 16) | 0).toString(16));
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const todayKst = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);

let db: Db | null = null;
function load(): Db {
  if (db) return db;
  try {
    const saved = sessionStorage.getItem(STORE_KEY);
    if (saved) return (db = JSON.parse(saved));
  } catch {
    /* 저장소 없음 */
  }
  return (db = makeFixtures());
}
function save() {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(db));
  } catch {
    /* 꽉 참 등: 메모리에만 */
  }
}
export function resetDemoData() {
  db = makeFixtures();
  save();
}

// ── 조회 결과 계산 (뷰·내장 관계) ─────────────────────────────
function rentChargeStatus(d: Db): Row[] {
  const today = todayKst();
  return (d.rent_charges ?? []).map((rc) => {
    const c = d.contracts.find((x) => x.id === rc.contract_id);
    const txs = (d.bank_transactions ?? []).filter((t) => t.charge_id === rc.id);
    const paid = txs.reduce((s, t) => s + Number(t.amount), 0);
    const status =
      paid >= rc.expected_amount && paid > rc.expected_amount + 1000 ? '초과' : paid >= rc.expected_amount ? '완납' : paid > 0 ? '부분' : rc.due_date < today ? '미납' : '예정';
    return {
      ...rc,
      contract_title: c?.title ?? '',
      paid_amount: paid,
      payment_count: txs.length,
      last_paid_at: txs.map((t) => t.occurred_at).sort().pop() ?? null,
      status,
    };
  });
}
function tableRows(d: Db, table: string): Row[] {
  if (table === 'rent_charge_status') return rentChargeStatus(d);
  return d[table] ?? (d[table] = []);
}
/** "*, contract_events(*)" 같은 내장 관계: 자식 목록(…_id 로 연결) 또는 부모 하나 */
function embed(d: Db, table: string, rows: Row[], select: string): Row[] {
  const rels = [...select.matchAll(/([a-z_]+)\(/g)].map((m) => m[1]);
  if (!rels.length) return rows;
  const single = (t: string) => t.replace(/s$/, '');
  return rows.map((r) => {
    const out = { ...r };
    for (const rel of rels) {
      const childKey = `${single(table)}_id`;
      const relRows = tableRows(d, rel);
      if (relRows.some((x) => childKey in x) || !(`${single(rel)}_id` in r)) out[rel] = relRows.filter((x) => x[childKey] === r.id).map((x) => ({ ...x }));
      else out[rel] = relRows.find((x) => x.id === r[`${single(rel)}_id`]) ?? null;
    }
    return out;
  });
}

// ── 쓰기 때 DB 트리거 흉내 ───────────────────────────────────
function beforeInsert(d: Db, table: string, row: Row): Res | null {
  const now = new Date().toISOString();
  if (!NO_ID.has(table) && !row.id) row.id = uuid();
  if (!('created_at' in row) && table !== 'station_permissions') row.created_at = now;
  if (['contracts', 'inspections', 'supply_items', 'feedback', 'daily_closes', 'fuel_tanks', 'fuel_settings'].includes(table)) row.updated_at = now;
  if (['fuel_purchases', 'fuel_dips', 'daily_closes', 'supply_moves', 'supply_orders', 'bank_transactions', 'inspection_results'].includes(table) && !row.created_by) row.created_by = DEMO_UID;
  if (table === 'supply_moves') {
    const it = d.supply_items.find((x) => x.id === row.item_id);
    if (!it) return { data: null, error: { message: '품목이 없습니다.' } };
    const before = Number(it.stock);
    const q = Number(row.qty);
    const after = row.kind === 'in' ? before + q : row.kind === 'out' ? before - q : row.kind === 'count' ? q : before + q;
    if (after < 0) return { data: null, error: { message: '재고보다 많이 뺄 수 없습니다.' } };
    row.stock_before = before;
    row.stock_after = after;
    if (row.kind === 'in' || row.kind === 'adjust') {
      row.vendor_id = row.vendor_id ?? it.vendor_id ?? null;
      row.unit_cost = row.unit_cost ?? it.unit_cost ?? null;
    } else {
      row.vendor_id = null;
      row.unit_cost = null;
    }
    it.stock = after;
    it.updated_at = now;
  }
  if (table === 'chat_messages') {
    const nick = d.chat_profiles?.find((x) => x.user_id === DEMO_UID)?.nickname;
    if (!nick) return { data: null, error: { message: '대화명을 먼저 정해 주세요.' } };
    row.user_id = DEMO_UID;
    row.nickname = nick;
    row.is_admin = false;
    row.body = String(row.body ?? '').trim();
  }
  if (table === 'chat_profiles') row.user_id = DEMO_UID;
  if (table === 'supply_settlements') {
    row.station_id = d.supply_vendors.find((x) => x.id === row.vendor_id)?.station_id ?? row.station_id;
    row.settled_at = row.settled_at ?? now;
    row.note = row.note ?? '';
  }
  if (table === 'routine_checks') row.station_id = d.routines.find((x) => x.id === row.routine_id)?.station_id ?? row.station_id;
  if (table === 'routine_checks') row.done_at = now;
  if (table === 'feedback') Object.assign(row, { user_id: DEMO_UID, user_email: 'demo@example.com', status: row.status ?? 'new', reply: row.reply ?? '' });
  if (table === 'bank_transactions' && !row.charge_id) {
    // 입금자 이름·금액이 맞는 가장 이른 미납 달에 자동 연결 (실제 DB 트리거와 같은 규칙의 단순판)
    const c = d.contracts.find((x) => x.status === 'confirmed');
    const names: string[] = c?.payer_names ?? [];
    if (names.some((n) => (row.payer ?? '').includes(n))) {
      const due = rentChargeStatus(d).filter((x) => ['미납', '예정', '부분'].includes(x.status)).sort((a, b) => a.due_date.localeCompare(b.due_date));
      const hit = due.find((x) => x.expected_amount - x.paid_amount === Number(row.amount)) ?? null;
      if (hit) row.charge_id = hit.id;
    }
  }
  return null;
}

// ── 쿼리 빌더 ────────────────────────────────────────────────
class Query implements PromiseLike<Res> {
  private filters: Array<(r: Row) => boolean> = [];
  private orders: Array<{ col: string; asc: boolean; nullsFirst?: boolean }> = [];
  private lim: number | null = null;
  private one: 'single' | 'maybe' | null = null;
  private op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
  private payload: Row[] = [];
  private patch: Row = {};
  private selectCols = '*';
  private returning = false;
  private conflict: string[] | null = null;
  /** datasets: 실제 서버에서 읽을 demo/ 키 */
  protected remoteKey: string | null = null;
  constructor(private table: string) {}

  select(cols = '*') {
    if (this.op === 'select') this.selectCols = cols;
    else this.returning = true;
    return this;
  }
  insert(v: Row | Row[]) {
    this.op = 'insert';
    this.payload = clone(Array.isArray(v) ? v : [v]);
    return this;
  }
  upsert(v: Row | Row[], opts?: { onConflict?: string }) {
    this.op = 'upsert';
    this.payload = clone(Array.isArray(v) ? v : [v]);
    this.conflict = opts?.onConflict ? opts.onConflict.split(',').map((s) => s.trim()) : null;
    return this;
  }
  update(p: Row) {
    this.op = 'update';
    this.patch = clone(p);
    return this;
  }
  delete() {
    this.op = 'delete';
    return this;
  }
  eq(c: string, v: any) {
    this.filters.push((r) => r[c] === v || (v !== null && r[c] != null && String(r[c]) === String(v)));
    return this;
  }
  neq(c: string, v: any) {
    this.filters.push((r) => r[c] !== v);
    return this;
  }
  in(c: string, vs: any[]) {
    this.filters.push((r) => vs.includes(r[c]));
    return this;
  }
  is(c: string, v: any) {
    this.filters.push((r) => (v === null ? r[c] == null : r[c] === v));
    return this;
  }
  gte(c: string, v: any) {
    this.filters.push((r) => r[c] != null && r[c] >= v);
    return this;
  }
  lte(c: string, v: any) {
    this.filters.push((r) => r[c] != null && r[c] <= v);
    return this;
  }
  gt(c: string, v: any) {
    this.filters.push((r) => r[c] != null && r[c] > v);
    return this;
  }
  lt(c: string, v: any) {
    this.filters.push((r) => r[c] != null && r[c] < v);
    return this;
  }
  match(o: Row) {
    for (const [k, v] of Object.entries(o)) this.eq(k, v);
    return this;
  }
  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
    this.orders.push({ col, asc: opts?.ascending !== false, nullsFirst: opts?.nullsFirst });
    return this;
  }
  limit(n: number) {
    this.lim = n;
    return this;
  }
  range(from: number, to: number) {
    this.lim = to - from + 1;
    return this;
  }
  single() {
    this.one = 'single';
    return this;
  }
  maybeSingle() {
    this.one = 'maybe';
    return this;
  }

  private pick(rows: Row[]): Res {
    let out = rows;
    for (const o of [...this.orders].reverse()) {
      out = [...out].sort((a, b) => {
        const x = a[o.col];
        const y = b[o.col];
        if (x == null && y == null) return 0;
        if (x == null) return o.nullsFirst ?? !o.asc ? -1 : 1;
        if (y == null) return o.nullsFirst ?? !o.asc ? 1 : -1;
        const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
        return o.asc ? c : -c;
      });
    }
    if (this.lim != null) out = out.slice(0, this.lim);
    if (this.one) {
      if (out.length > 1 && this.one === 'single') return { data: null, error: { message: '여러 줄이 나왔습니다.' } };
      if (!out.length) return this.one === 'single' ? { data: null, error: { message: '찾지 못했습니다.', code: 'PGRST116' } } : { data: null, error: null };
      return { data: out[0], error: null };
    }
    return { data: out, error: null, count: out.length };
  }

  run(): Res {
    const d = load();
    if (this.table === 'datasets' || this.table === 'site_config') return { data: null, error: { message: 'remote' } };
    const rows = tableRows(d, this.table);
    const match = (r: Row) => this.filters.every((f) => f(r));
    if (this.op === 'select') return this.pick(embed(d, this.table, rows.filter(match).map((r) => ({ ...r })), this.selectCols));
    if (this.table === 'rent_charge_status') return { data: null, error: { message: '읽기 전용' } };

    let changed: Row[] = [];
    if (this.op === 'insert' || this.op === 'upsert') {
      const keys = this.conflict ?? CONFLICT[this.table] ?? ['id'];
      for (const row of this.payload) {
        const existing = this.op === 'upsert' ? rows.find((r) => keys.every((k) => row[k] !== undefined && r[k] === row[k])) : undefined;
        if (existing) {
          Object.assign(existing, row, 'updated_at' in existing ? { updated_at: new Date().toISOString() } : {});
          changed.push(existing);
          continue;
        }
        const dupe = CONFLICT[this.table] && rows.find((r) => CONFLICT[this.table].every((k) => r[k] === row[k]));
        if (dupe) return { data: null, error: { message: '이미 있습니다.', code: '23505' } };
        const err = beforeInsert(d, this.table, row);
        if (err) return err;
        rows.push(row);
        changed.push(row);
      }
    } else if (this.op === 'update') {
      changed = rows.filter(match);
      for (const r of changed) Object.assign(r, this.patch, 'updated_at' in r ? { updated_at: new Date().toISOString() } : {});
      if (this.table === 'supply_items' && 'stock' in this.patch) for (const r of changed) r.low_alerted_at = null;
    } else {
      changed = rows.filter(match);
      d[this.table] = rows.filter((r) => !match(r));
      // 지운 부모의 자식도 같이 (on delete cascade)
      if (this.table === 'contracts') for (const c of changed) for (const t of ['contract_events', 'rent_charges']) d[t] = d[t].filter((x) => x.contract_id !== c.id);
      if (this.table === 'inspections') d.inspection_results = d.inspection_results.filter((x) => !changed.some((c) => c.id === x.inspection_id));
      if (this.table === 'routines') d.routine_checks = d.routine_checks.filter((x) => !changed.some((c) => c.id === x.routine_id));
    }
    save();
    if (!this.returning) return { data: null, error: null };
    return this.pick(changed.map((r) => ({ ...r })));
  }

  then<A = Res, B = never>(ok?: ((v: Res) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    const p = (async () => {
      await new Promise((r) => setTimeout(r, 120)); // 서버처럼 아주 잠깐 기다림
      if (this.table === 'datasets' || this.table === 'site_config') return remote(this.table, this.remoteKey, this.one);
      return this.run();
    })();
    return p.then(ok, bad);
  }
}

// ── 공개 데이터는 실제 서버에서 (demo/… 키, site_config) ────────
let real: SupabaseClient | null = null;
export function setRealClient(c: SupabaseClient) {
  real = c;
}
async function remote(table: string, key: string | null, one: 'single' | 'maybe' | null): Promise<Res> {
  if (!real) return { data: null, error: { message: 'no client' } };
  if (table === 'site_config') {
    const q = real.from('site_config').select('*');
    return (await (one ? q.maybeSingle() : q)) as Res;
  }
  if (!key) return { data: null, error: null };
  const q = real.from('datasets').select('data').eq('key', key);
  return (await (one ? q.maybeSingle() : q)) as Res;
}
export function demoKey(k: string) {
  const m = k.match(/^st\/[^/]+\/(.+)$/);
  if (m) return `demo/${m[1]}`;
  if (k.startsWith('market/') || k.startsWith('policy/')) return `demo/${k}`;
  return `demo/__none__/${k}`;
}

// datasets 는 .eq('key', …) 로만 읽으므로 그 키를 demo/ 키로 바꿔 둠
class DatasetQuery extends Query {
  eq(c: string, v: any) {
    if (c === 'key') this.remoteKey = demoKey(String(v));
    return this;
  }
}

// ── 클라이언트 ───────────────────────────────────────────────
const demoUser = { id: DEMO_UID, email: 'demo@example.com', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
const session = { access_token: 'demo', token_type: 'bearer', expires_in: 3600, refresh_token: 'demo', user: demoUser };

function myPermissions(sid: string) {
  const d = load();
  const st = d.stations.find((s) => s.id === sid);
  const AREAS = ['prices', 'land', 'policy', 'contracts', 'inspections', 'payments', 'supplies', 'fuel'];
  return d.station_members
    .filter((m) => m.station_id === sid && m.user_id === DEMO_UID)
    .flatMap((m) =>
      AREAS.map((a) => {
        const p = d.station_permissions.find((x) => x.station_id === sid && x.role === m.role && x.area === a);
        const ownerFuelLeased = a === 'fuel' && m.role === 'owner' && st?.operation !== 'self';
        return {
          role: m.role,
          is_manager: m.is_manager,
          area: a,
          can_read: ownerFuelLeased ? !!p?.can_read : m.is_manager || !!p?.can_read,
          can_write: ownerFuelLeased ? !!p?.can_write : m.is_manager || !!p?.can_write,
        };
      }),
    );
}

export function createDemoClient(onExit: () => void): SupabaseClient {
  const client = {
    from: (table: string) => (table === 'datasets' ? new DatasetQuery(table) : new Query(table)),
    rpc: async (name: string, args: Row = {}): Promise<Res> => {
      await new Promise((r) => setTimeout(r, 80));
      if (name === 'my_permissions') return { data: myPermissions(args.sid), error: null };
      if (name === 'station_taken') return { data: false, error: null };
      if (name === 'touch_activity') return { data: null, error: null };
      return { data: null, error: { message: OFF } };
    },
    functions: {
      invoke: async () => ({ data: null, error: Object.assign(new Error(OFF), { context: new Response(JSON.stringify({ error: 'DEMO', message: OFF }), { status: 403 }) }) }),
    },
    storage: {
      from: () => ({
        upload: async () => ({ data: null, error: { message: '데모에서는 파일을 올릴 수 없습니다. 로그인하면 계약서·결과지 파일을 올려 보관할 수 있습니다.' } }),
        createSignedUrl: async () => ({ data: null, error: { message: '데모에는 저장된 파일이 없습니다.' } }),
        remove: async () => ({ data: [], error: null }),
      }),
    },
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      getUser: async () => ({ data: { user: demoUser }, error: null }),
      onAuthStateChange: (cb: (e: string, s: unknown) => void) => {
        setTimeout(() => cb('SIGNED_IN', session), 0);
        return { data: { subscription: { unsubscribe() {} } } };
      },
      signOut: async () => {
        onExit();
        return { error: null };
      },
      signInWithOtp: async () => ({ data: null, error: { message: OFF } }),
    },
    channel: () => {
      const ch = {
        on: () => ch,
        subscribe: (cb?: (s: string) => void) => {
          setTimeout(() => cb?.('SUBSCRIBED'), 0);
          return ch;
        },
        unsubscribe: async () => 'ok',
      };
      return ch;
    },
    removeChannel: async () => 'ok',
  };
  return client as unknown as SupabaseClient;
}

export { DEMO_SID };
