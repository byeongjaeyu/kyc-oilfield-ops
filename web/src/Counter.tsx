import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase, type Station } from './supabase';
import { SUPPLY_CATEGORIES } from './supplyPresets';
import { Loading } from './Loading';

interface Item {
  id: string;
  name: string;
  category: string;
  unit: string;
  stock: number;
  reorder_point: number;
  order_qty: number;
  active: boolean;
}
interface Last {
  key: number;
  item: Item;
  kind: 'out' | 'in';
  qty: number;
  after: number;
  undone?: boolean;
}

const n = (v: number | string | null | undefined) => Number(v ?? 0);
const fmt = (v: number) => (Number.isInteger(v) ? v.toLocaleString('ko-KR') : v.toLocaleString('ko-KR', { maximumFractionDigits: 2 }));
const isLow = (i: Item) => n(i.reorder_point) > 0 && n(i.stock) <= n(i.reorder_point);
const UNDO_MS = 8000;

/**
 * 카운터 화면: 있는 소모품만 크게, − 판매 / + 입고 한 번씩.
 * 카운터 태블릿·휴대폰에 띄워 두는 용도. 다른 기기에서 바뀐 재고는 실시간으로 따라옴.
 */
export function Counter({ station, onExit }: { station: Station; onExit: () => void }) {
  const sid = station.id;
  const [items, setItems] = useState<Item[] | null>(null);
  const [cat, setCat] = useState('전체');
  const [q, setQ] = useState('');
  const [last, setLast] = useState<Last | null>(null);
  const [error, setError] = useState('');
  const [live, setLive] = useState(false);
  /** 입고 수량을 넣는 중인 품목과 수량 */
  const [intake, setIntake] = useState<{ id: string; qty: string } | null>(null);
  const [full, setFull] = useState(!!document.fullscreenElement);
  const pending = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (pending.current > 0) return; // 누르는 중엔 화면 숫자를 덮어쓰지 않음
    const { data, error } = await supabase
      .from('supply_items')
      .select('id,name,category,unit,stock,reorder_point,order_qty,active')
      .eq('station_id', sid)
      .eq('active', true)
      .order('category')
      .order('name');
    if (error) return setError(error.message);
    setItems(data as Item[]);
  }, [sid]);

  // 처음 불러오기 + 다른 기기 변경 실시간 + 30초마다·화면 돌아올 때 다시 맞추기
  useEffect(() => {
    load();
    const ch = supabase
      .channel(`counter:${sid}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'supply_items', filter: `station_id=eq.${sid}` }, (p) => {
        if (pending.current > 0) return;
        if (p.eventType === 'UPDATE') {
          const row = p.new as Item;
          setItems((cur) => (cur ? (row.active ? cur.map((i) => (i.id === row.id ? { ...i, ...row } : i)) : cur.filter((i) => i.id !== row.id)) : cur));
        } else load();
      })
      .subscribe((s) => setLive(s === 'SUBSCRIBED'));
    const poll = window.setInterval(load, 30_000);
    const onVis = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      supabase.removeChannel(ch);
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [load, sid]);

  // 띄워 두는 화면이라 꺼지지 않게 (지원하는 브라우저만)
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const get = async () => {
      try {
        lock = await (navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request('screen') ?? null;
      } catch {
        /* 배터리 절약 모드 등에서는 안 됨 */
      }
    };
    get();
    const onVis = () => document.visibilityState === 'visible' && get();
    document.addEventListener('visibilitychange', onVis);
    const onFs = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      lock?.release().catch(() => undefined);
      document.removeEventListener('visibilitychange', onVis);
      document.removeEventListener('fullscreenchange', onFs);
    };
  }, []);

  useEffect(() => {
    if (!last) return;
    const t = window.setTimeout(() => setLast((l) => (l?.key === last.key ? null : l)), UNDO_MS);
    return () => window.clearTimeout(t);
  }, [last]);

  /** 화면 숫자를 먼저 바꾸고 기록. 실패하면 되돌림 */
  const record = async (item: Item, kind: 'out' | 'in' | 'adjust', qty: number, note: string) => {
    const delta = kind === 'out' ? -qty : qty;
    pending.current += 1;
    setError('');
    setItems((cur) => cur?.map((i) => (i.id === item.id ? { ...i, stock: n(i.stock) + delta } : i)) ?? cur);
    const { data, error } = await supabase
      .from('supply_moves')
      .insert({ item_id: item.id, station_id: sid, kind, qty, note })
      .select('stock_after')
      .single();
    pending.current -= 1;
    if (error) {
      setItems((cur) => cur?.map((i) => (i.id === item.id ? { ...i, stock: n(i.stock) - delta } : i)) ?? cur);
      setError(`${item.name} 기록 실패: ${error.message}`);
      return null;
    }
    const after = n((data as { stock_after: number }).stock_after);
    setItems((cur) => cur?.map((i) => (i.id === item.id ? { ...i, stock: after } : i)) ?? cur);
    return after;
  };

  const tap = async (item: Item, kind: 'out' | 'in', qty = 1) => {
    if (kind === 'out' && n(item.stock) < qty) return;
    navigator.vibrate?.(15);
    const after = await record(item, kind, qty, '카운터');
    if (after != null) setLast({ key: Date.now(), item, kind, qty, after });
  };

  const undo = async () => {
    if (!last || last.undone) return;
    setLast({ ...last, undone: true });
    // 기록은 지우지 않고 반대로 보정 (누가 언제 무엇을 되돌렸는지 남김)
    await record(last.item, 'adjust', last.kind === 'out' ? last.qty : -last.qty, '카운터 되돌리기');
  };

  const cats = useMemo(() => {
    const has = new Set((items ?? []).map((i) => ((SUPPLY_CATEGORIES as readonly string[]).includes(i.category) ? i.category : '기타')));
    return ['전체', ...SUPPLY_CATEGORIES.filter((c) => has.has(c))];
  }, [items]);
  const shown = (items ?? []).filter(
    (i) =>
      (cat === '전체' || i.category === cat || (cat === '기타' && !(SUPPLY_CATEGORIES as readonly string[]).includes(i.category))) &&
      (!q.trim() || i.name.toLowerCase().includes(q.trim().toLowerCase())),
  );

  const toggleFull = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    else rootRef.current?.requestFullscreen?.().catch(() => undefined);
  };

  return (
    <div className="counter" ref={rootRef}>
      <header className="counter-bar">
        <div className="counter-title">
          <h1>소모품 카운터</h1>
          <span className="counter-station">
            {station.name}
            <span className={`live-dot ${live ? 'on' : ''}`} title={live ? '다른 기기와 실시간으로 맞춰지는 중' : '연결 중'} />
          </span>
        </div>
        <div className="counter-tools">
          {document.fullscreenEnabled && (
            <button type="button" className="tb-btn on-dark" onClick={toggleFull}>
              {full ? '전체 화면 끄기' : '전체 화면'}
            </button>
          )}
          <button type="button" className="tb-btn on-dark" onClick={onExit}>
            닫기
          </button>
        </div>
      </header>

      <div className="counter-filter">
        {cats.length > 2 && (
          <div className="seg seg-dark" role="group" aria-label="분류">
            {cats.map((c) => (
              <button key={c} type="button" aria-pressed={c === cat} onClick={() => setCat(c)}>
                {c}
              </button>
            ))}
          </div>
        )}
        {(items?.length ?? 0) > 8 && <input className="counter-search" type="search" placeholder="품목 찾기" aria-label="품목 찾기" value={q} onChange={(e) => setQ(e.target.value)} />}
      </div>

      {error && (
        <p className="counter-error" role="alert">
          {error}
        </p>
      )}

      {!items ? (
        <Loading size="page" dark />
      ) : items.length === 0 ? (
        <div className="counter-empty">
          <p>아직 품목이 없습니다. 소모품 화면에서 품목을 먼저 추가하세요.</p>
          <button type="button" className="primary" onClick={onExit}>
            소모품 화면으로
          </button>
        </div>
      ) : (
        <ul className="counter-grid">
          {shown.map((i) => {
            const low = isLow(i);
            const out = n(i.stock) <= 0;
            return (
              <li key={i.id} className={`counter-tile ${low ? 'is-low' : ''} ${out ? 'is-out' : ''}`}>
                <p className="ct-name">{i.name}</p>
                <p className="ct-stock" aria-live="polite">
                  <b>{fmt(n(i.stock))}</b>
                  <span>{i.unit}</span>
                </p>
                <p className="ct-state">{out ? '재고 없음' : low ? `주문할 때 (기준 ${fmt(n(i.reorder_point))}${i.unit})` : ' '}</p>
                {intake?.id === i.id ? (
                  <IntakeForm
                    item={i}
                    qty={intake.qty}
                    onQty={(v) => setIntake({ id: i.id, qty: v })}
                    onCancel={() => setIntake(null)}
                    onSave={(q) => {
                      setIntake(null);
                      tap(i, 'in', q);
                    }}
                  />
                ) : (
                  <div className="ct-actions">
                    <button type="button" className="ct-out" disabled={out} onClick={() => tap(i, 'out')} aria-label={`${i.name} 1${i.unit} 판매`}>
                      <span aria-hidden>−</span> 판매
                    </button>
                    <button
                      type="button"
                      className="ct-in"
                      onClick={() => setIntake({ id: i.id, qty: n(i.order_qty) > 0 ? String(n(i.order_qty)) : '1' })}
                      aria-label={`${i.name} 입고 수량 넣기`}
                    >
                      <span aria-hidden>+</span> 입고
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="counter-help">
        판매는 누를 때마다 1개씩, 입고는 들어온 수량을 넣어 기록합니다. 잘못 누르면 아래에 뜨는 되돌리기를 누르세요. 휴대폰·태블릿에서는 브라우저 메뉴의 <b>홈 화면에 추가</b>로 이 화면을
        바로 열 수 있습니다.
      </p>

      {last && (
        <div className="counter-toast" role="status">
          <span>
            {last.undone ? (
              <>
                {last.item.name} {last.kind === 'out' ? '판매' : '입고'}를 되돌렸습니다
              </>
            ) : (
              <>
                {last.item.name} {last.kind === 'out' ? '판매' : '입고'} {fmt(last.qty)}
                {last.item.unit}, 지금 {fmt(last.after)}
                {last.item.unit}
              </>
            )}
          </span>
          {!last.undone && (
            <button type="button" onClick={undo}>
              되돌리기
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** 입고 수량 — 카드 안에서 바로 */
function IntakeForm({
  item,
  qty,
  onQty,
  onCancel,
  onSave,
}: {
  item: Item;
  qty: string;
  onQty: (v: string) => void;
  onCancel: () => void;
  onSave: (q: number) => void;
}) {
  const q = Number(qty);
  const ok = q > 0 && q <= 100000;
  const add = (d: number) => onQty(String(Math.max(0, (Number(qty) || 0) + d)));
  return (
    <form
      className="ct-intake"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onSave(q);
      }}
    >
      <label className="ct-qty">
        <span className="sr-only">{item.name} 입고 수량</span>
        <input inputMode="decimal" autoFocus value={qty} onChange={(e) => onQty(e.target.value.replace(/[^\d.]/g, ''))} onFocus={(e) => e.target.select()} />
        <span>{item.unit}</span>
      </label>
      <div className="ct-quick">
        {[1, 5, 10].map((d) => (
          <button key={d} type="button" onClick={() => add(d)} aria-label={`${d} 늘리기`}>
            +{d}
          </button>
        ))}
      </div>
      <div className="ct-actions">
        <button type="button" className="ct-in" onClick={onCancel}>
          취소
        </button>
        <button type="submit" className="ct-out" disabled={!ok}>
          {ok ? `${fmt(q)}${item.unit} 입고` : '입고'}
        </button>
      </div>
    </form>
  );
}
