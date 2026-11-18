import { useCallback, useEffect, useMemo, useState } from 'react';
import { BarcodeScanner } from './BarcodeScanner';
import { getJSON, md } from './data';
import { supabase, type Station } from './supabase';
import { PRESETS, SUPPLY_CATEGORIES } from './supplyPresets';
import { Loading } from './Loading';
import { OrderCard, ReceiveForm, VendorSection, suggestQty, type Received } from './SupplyOrders';
import {
  MOVE_KO,
  addMonth,
  isLow,
  monthKo,
  monthOf,
  monthStartIso,
  n,
  qtyFmt,
  vendorMonth,
  won,
  wonShort,
  type Item,
  type Move,
  type Order,
  type OrderLine,
  type Settlement,
  type Vendor,
} from './supplyShared';

interface UreaSeller {
  id: string;
  name: string;
  distanceKm: number;
  price: number | null;
  inStock: boolean;
  reportedAt: string;
}
interface UreaLatest {
  fetchedAt: string;
  radiusKm: number;
  ours: UreaSeller | null;
  nearby: UreaSeller[];
  stats: { n: number; inStock: number; avg: number | null; min: number | null };
  national: { n: number; inStock: number; avg: number | null };
  shortage: boolean;
}

/** 최근 28일 동안 줄어든 양으로 하루 평균 사용량 → 남은 일수 */
function daysLeft(item: Item, moves: Move[]): number | null {
  const since = Date.now() - 28 * 86_400_000;
  const mine = moves.filter((m) => m.item_id === item.id && new Date(m.created_at).getTime() >= since);
  if (!mine.length) return null;
  const used = mine
    .filter((m) => (m.kind === 'out' || m.kind === 'count') && m.stock_before != null && m.stock_after != null && n(m.stock_after) < n(m.stock_before))
    .reduce((s, m) => s + (n(m.stock_before) - n(m.stock_after)), 0);
  // 카운터에서 잘못 눌러 되돌린 판매는 사용량에서 뺌
  const undone = mine.filter((m) => m.kind === 'adjust' && m.note === '카운터 되돌리기' && n(m.qty) > 0).reduce((s, m) => s + n(m.qty), 0);
  if (used - undone <= 0) return null;
  const first = Math.min(...mine.map((m) => new Date(m.created_at).getTime()));
  const days = Math.max(7, (Date.now() - first) / 86_400_000);
  const perDay = (used - undone) / days;
  return Math.max(0, Math.floor(n(item.stock) / perDay));
}

export function SupplySection({ station, canWrite }: { station: Station; canWrite: boolean }) {
  const sid = station.id;
  const [items, setItems] = useState<Item[] | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [moves, setMoves] = useState<Move[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [urea, setUrea] = useState<UreaLatest | null>(null);
  const [purchases, setPurchases] = useState<Move[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [stamp, setStamp] = useState(0);
  const [mode, setMode] = useState<'list' | 'count' | 'add'>('list');
  /** 손으로 만드는 주문서: 거래처와 먼저 넣어 둘 품목 */
  const [compose, setCompose] = useState<{ vendorId: string; itemIds: string[] } | null>(null);
  const [receiving, setReceiving] = useState<string | null>(null);
  const [scan, setScan] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showUrea, setShowUrea] = useState(false);

  const reload = useCallback(async () => {
    const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const lastMonth = monthStartIso(addMonth(monthOf(), -1));
    const [i, v, m, o, p, st] = await Promise.all([
      supabase.from('supply_items').select('*').eq('station_id', sid).order('category').order('name'),
      supabase.from('supply_vendors').select('*').eq('station_id', sid).order('name'),
      supabase.from('supply_moves').select('*').eq('station_id', sid).gte('created_at', since).order('created_at', { ascending: false }).limit(2000),
      supabase.from('supply_orders').select('*').eq('station_id', sid).order('created_at', { ascending: false }).limit(30),
      supabase.from('supply_moves').select('*').eq('station_id', sid).in('kind', ['in', 'adjust']).gte('created_at', lastMonth).order('created_at', { ascending: false }).limit(2000),
      supabase.from('supply_settlements').select('*').eq('station_id', sid).gte('month', `${addMonth(monthOf(), -12)}-01`),
    ]);
    if (i.error) setError(i.error.message);
    setItems((i.data as Item[]) ?? []);
    setVendors((v.data as Vendor[]) ?? []);
    setMoves((m.data as Move[]) ?? []);
    setOrders((o.data as Order[]) ?? []);
    setPurchases((p.data as Move[]) ?? []);
    setSettlements((st.data as Settlement[]) ?? []);
    setStamp((x) => x + 1);
  }, [sid]);

  useEffect(() => {
    reload();
    getJSON<UreaLatest>(`st/${sid}/supplies/urea.json`).then(setUrea);
  }, [reload, sid]);

  const run = async (label: string, fn: () => Promise<void>, done?: string) => {
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await fn();
      if (done) setNotice(done);
      await reload();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy('');
    }
  };
  const must = <T,>(r: { error: { message: string } | null; data?: T | null }) => {
    if (r.error) throw new Error(r.error.message);
    return r.data as T;
  };
  const move = (item: Item, kind: Move['kind'], qty: number, note = '', extra: { order_id?: string; vendor_id?: string | null; unit_cost?: number | null } = {}) =>
    supabase.from('supply_moves').insert({ item_id: item.id, station_id: sid, kind, qty, note, ...extra });

  const active = useMemo(() => (items ?? []).filter((i) => i.active), [items]);
  const low = active.filter(isLow);
  const openOrders = orders.filter((o) => o.status === 'sent');
  const orderedIds = new Set(openOrders.flatMap((o) => o.lines.map((l) => l.item_id)));
  const toOrder = low.filter((i) => !orderedIds.has(i.id));
  const vendorOf = (id: string | null) => vendors.find((v) => v.id === id);
  const inVendor = (i: Item, vid: string) => (vid ? i.vendor_id === vid : !vendorOf(i.vendor_id));
  const draftGroups: Array<[string, Item[]]> = [];
  for (const it of toOrder) {
    const k = vendorOf(it.vendor_id) ? it.vendor_id! : '';
    const g = draftGroups.find(([vid]) => vid === k);
    if (g) g[1].push(it);
    else draftGroups.push([k, [it]]);
  }
  const prevYm = addMonth(monthOf(), -1);
  const dueVendors = vendors
    .map((v) => [v, vendorMonth(purchases, v.id, prevYm)] as const)
    .filter(([v, m]) => m.total > 0 && !settlements.some((x) => x.vendor_id === v.id && x.month.slice(0, 7) === prevYm));

  const openCompose = (vendorId: string, itemIds: string[] = []) => {
    setCompose({ vendorId, itemIds });
    requestAnimationFrame(() => document.getElementById('sup-compose')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  const sent = (vendor: Vendor | undefined, lines: OrderLine[], message: string) =>
    run('주문 기록하는 중', async () => {
      must(
        await supabase.from('supply_orders').insert({
          station_id: sid,
          vendor_id: vendor?.id ?? null,
          vendor_name: vendor?.name ?? '거래처 미지정',
          status: 'sent',
          lines,
          message,
          sent_at: new Date().toISOString(),
        }),
      );
      setCompose(null);
    }, '주문한 것으로 기록했습니다. 물건이 오면 "받음"을 눌러 받은 수량·단가를 확인하고 입고하세요.');
  const receive = (o: Order, rows: Received[]) =>
    run('입고하는 중', async () => {
      for (const r of rows) {
        must(await move(r.item, 'in', r.qty, `${o.vendor_name} 주문 입고`, { order_id: o.id, vendor_id: o.vendor_id, unit_cost: r.unit_cost }));
        if (r.unit_cost != null && r.unit_cost !== r.item.unit_cost) must(await supabase.from('supply_items').update({ unit_cost: r.unit_cost }).eq('id', r.item.id));
      }
      must(await supabase.from('supply_orders').update({ status: 'received', received_at: new Date().toISOString() }).eq('id', o.id));
      setReceiving(null);
    }, `${rows.length}개 품목을 입고했습니다. ${o.vendor_name} ${monthKo(monthOf())} 입고 내역에 들어갔습니다.`);
  const byCode = (c: string) => (items ?? []).find((i) => i.barcode === c);

  if (!items) {
    return (
      <section className="block">
        <header className="block-head">
          <h2>소모품</h2>
        </header>
        {error ? <p className="change-note">{error}</p> : <Loading />}
      </section>
    );
  }

  const catOf = (i: Item) => ((SUPPLY_CATEGORIES as readonly string[]).includes(i.category) ? i.category : '기타');
  const grouped: Array<[string, Item[]]> = SUPPLY_CATEGORIES.map((c) => [c as string, items.filter((i) => catOf(i) === c)] as [string, Item[]]).filter(
    ([, list]) => list.length > 0,
  );

  return (
    <section className="block" aria-labelledby="sup-title">
      <header className="block-head">
        <h2 id="sup-title">소모품</h2>
        <p className="block-meta">
          {active.length}개 품목{low.length > 0 && `, 주문할 것 ${low.length}개`}
        </p>
      </header>

      {items.length === 0 ? (
        <p className="readout">아직 품목이 없습니다. 주유소에서 흔히 쓰는 소모품 목록에서 고르거나 직접 추가하세요.</p>
      ) : low.length > 0 ? (
        <p className="readout">
          <b className="price-big alert-text">주문할 것 {low.length}개</b> 발주점 이하로 떨어진 품목: {low.map((i) => i.name).join(', ')}.
          {openOrders.length > 0 && ` 도착을 기다리는 주문 ${openOrders.length}건.`}
        </p>
      ) : (
        <p className="readout">
          모든 품목이 발주점보다 넉넉합니다.{openOrders.length > 0 && ` 도착을 기다리는 주문 ${openOrders.length}건.`}
        </p>
      )}
      {dueVendors.length > 0 && (
        <p className="sup-due">
          {monthKo(prevYm)} 정산 안 한 거래처: {dueVendors.map(([v, m]) => `${v.name} ${wonShort(m.total)}`).join(', ')}.{' '}
          <a href="#sup-vendors" className="link-btn">
            거래처에서 확인
          </a>
        </p>
      )}

      {canWrite && (
        <div className="sup-actions">
          <button type="button" className="primary" onClick={() => (setScan(true), setCode(null))}>
            바코드로 찍기
          </button>
          <a className="more" href="#counter">
            카운터 화면
          </a>
          <button type="button" className="more" aria-pressed={mode === 'count'} onClick={() => setMode(mode === 'count' ? 'list' : 'count')}>
            재고 실사
          </button>
          <button type="button" className="more" aria-pressed={mode === 'add'} onClick={() => setMode(mode === 'add' ? 'list' : 'add')}>
            품목 추가
          </button>
        </div>
      )}

      {busy && (
        <p className="note" role="status">
          {busy}…
        </p>
      )}
      {notice && <p className="info-note">{notice}</p>}
      {error && (
        <p className="change-note" role="alert">
          {error}
        </p>
      )}

      {scan && canWrite && (
        <div className="form boxed scan-box">
          {!code ? (
            <BarcodeScanner onCode={setCode} onClose={() => setScan(false)} />
          ) : (
            <ScanResult
              code={code}
              item={byCode(code)}
              items={items}
              busy={busy}
              onAgain={() => setCode(null)}
              onClose={() => (setScan(false), setCode(null))}
              onMove={(it, kind, qty) =>
                run('기록하는 중', async () => {
                  must(await move(it, kind, qty, '바코드'));
                  setCode(null);
                }, `${it.name} ${MOVE_KO[kind]} ${qtyFmt(qty)}${it.unit} 기록했습니다.`)
              }
              onAssign={(it) =>
                run('바코드 연결하는 중', async () => {
                  must(await supabase.from('supply_items').update({ barcode: code }).eq('id', it.id));
                }, `${it.name}에 바코드 ${code}를 연결했습니다. 다음부터 찍으면 바로 나옵니다.`)
              }
              onCreate={(name, category, unit) =>
                run('품목 추가하는 중', async () => {
                  must(await supabase.from('supply_items').insert({ station_id: sid, name, barcode: code, category, unit }));
                }, `${name}을(를) 추가했습니다. 발주점·주문 수량은 목록에서 정해 주세요.`)
              }
            />
          )}
        </div>
      )}

      {mode === 'count' && canWrite && (
        <CountForm
          items={active}
          busy={busy}
          onCancel={() => setMode('list')}
          onSave={(counts) =>
            run('실사 저장하는 중', async () => {
              for (const [it, q] of counts) must(await move(it, 'count', q, '재고 실사'));
              setMode('list');
            }, `${counts.length}개 품목의 재고를 맞췄습니다. 줄어든 만큼은 판매·사용량으로 계산합니다.`)
          }
        />
      )}

      {mode === 'add' && canWrite && (
        <AddItems
          existing={items}
          vendors={vendors}
          busy={busy}
          onCancel={() => setMode('list')}
          onAdd={(rows) =>
            run('품목 추가하는 중', async () => {
              must(await supabase.from('supply_items').insert(rows.map((r) => ({ ...r, station_id: sid }))));
              setMode('list');
            }, `${rows.length}개 품목을 추가했습니다. 현재 재고는 "재고 실사"로 한 번에 넣으세요.`)
          }
        />
      )}

      {/* ── 주문 ── */}
      {items.length > 0 && (
        <>
          <h3 className="sub-head" id="sup-orders">
            주문
          </h3>
          {openOrders.length > 0 && (
            <ul className="tx-list order-list">
              {openOrders.map((o) => (
                <li key={o.id} className={receiving === o.id ? 'is-open' : ''}>
                  <span className="tx-main">
                    <b>{o.vendor_name}</b> {o.lines.map((l) => `${l.name} ${qtyFmt(n(l.qty))}${l.unit}`).join(', ')}
                    <span className="brand-name">{o.sent_at ? md(o.sent_at) : ''} 주문, 도착 기다리는 중</span>
                  </span>
                  {canWrite && receiving !== o.id && (
                    <span className="tx-actions">
                      <button type="button" className="primary" disabled={!!busy} onClick={() => setReceiving(o.id)}>
                        받음
                      </button>
                      <button
                        type="button"
                        className="link-btn danger-inline"
                        onClick={() => {
                          if (!confirm(`${o.vendor_name} 주문을 취소할까요? 재고는 바뀌지 않습니다.`)) return;
                          run('취소하는 중', async () => {
                            must(await supabase.from('supply_orders').update({ status: 'cancelled' }).eq('id', o.id));
                          });
                        }}
                      >
                        주문 취소
                      </button>
                    </span>
                  )}
                  {receiving === o.id && (
                    <ReceiveForm order={o} items={items} busy={busy} onCancel={() => setReceiving(null)} onReceive={(rows) => receive(o, rows)} />
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="order-drafts" id="sup-compose">
            {compose && (
              <OrderCard
                key={`new:${compose.vendorId}:${compose.itemIds.join(',')}`}
                station={station}
                vendor={vendorOf(compose.vendorId)}
                vendors={vendors}
                items={active}
                initial={Object.fromEntries([
                  ...toOrder.filter((i) => inVendor(i, compose.vendorId)).map((i) => [i.id, suggestQty(i)] as const),
                  ...compose.itemIds.map((id) => active.find((i) => i.id === id)).filter((i): i is Item => !!i).map((i) => [i.id, suggestQty(i)] as const),
                ])}
                canWrite={canWrite}
                busy={busy}
                onVendor={(vendorId) => setCompose({ vendorId, itemIds: compose.itemIds })}
                onClose={() => setCompose(null)}
                onSent={sent}
              />
            )}
            {draftGroups
              .filter(([vid]) => !compose || compose.vendorId !== vid)
              .map(([vid, list]) => (
                <OrderCard
                  key={`${vid}:${list.map((i) => i.id).join(',')}`}
                  station={station}
                  vendor={vendorOf(vid)}
                  vendors={vendors}
                  items={active}
                  initial={Object.fromEntries(list.map((i) => [i.id, suggestQty(i)]))}
                  canWrite={canWrite}
                  busy={busy}
                  onSent={sent}
                />
              ))}
          </div>
          {!compose && (
            <div className="order-new">
              {toOrder.length === 0 && openOrders.length === 0 && <p className="fine">지금 발주점 아래로 떨어진 품목은 없습니다. 미리 주문하거나 영업사원이 왔을 때는 주문서를 직접 만드세요.</p>}
              {canWrite && (
                <button type="button" className="more" onClick={() => openCompose(vendors[0]?.id ?? '')}>
                  {toOrder.length > 0 ? '다른 주문서 만들기' : '주문서 만들기'}
                </button>
              )}
            </div>
          )}
        </>
      )}

      {/* ── 재고 ── */}
      {items.length > 0 && (
        <>
          <h3 className="sub-head">재고</h3>
          {grouped.map(([cat, list]) => (
            <div key={cat} className="sup-group">
              <h4 className="sup-cat">{cat}</h4>
              <ul className="sup-list">
                {list.map((it) => {
                  const left = daysLeft(it, moves);
                  const rp = n(it.reorder_point);
                  const ratio = rp > 0 ? Math.min(1, n(it.stock) / (rp * 3)) : Math.min(1, n(it.stock) / 20);
                  return (
                    <li key={it.id} className={`sup-item ${isLow(it) ? 'low' : ''} ${it.active ? '' : 'inactive'}`}>
                      <button type="button" className="sup-row" aria-expanded={editing === it.id} onClick={() => setEditing(editing === it.id ? null : it.id)}>
                        <span className="sup-name">
                          {it.name}
                          {!it.active && <span className="brand-name">안 씀</span>}
                          <span className="sup-sub">
                            {vendorOf(it.vendor_id)?.name ?? '거래처 미지정'}
                            {rp > 0 ? `, 발주점 ${qtyFmt(rp)}${it.unit}` : ', 발주점 미설정'}
                            {orderedIds.has(it.id) && ', 주문함'}
                          </span>
                        </span>
                        <span className="sup-stock">
                          <b>{qtyFmt(n(it.stock))}</b>
                          {it.unit}
                          <span className="sup-bar" aria-hidden>
                            <span style={{ width: `${Math.round(ratio * 100)}%` }} />
                          </span>
                          <span className="sup-sub">{left == null ? '사용량 기록 없음' : left === 0 ? '오늘 소진 예상' : `약 ${left}일분`}</span>
                        </span>
                      </button>
                      {canWrite && (
                        <span className="sup-quick">
                          <button type="button" className="more" disabled={!!busy || n(it.stock) <= 0} onClick={() => run('기록하는 중', async () => void must(await move(it, 'out', 1)))} aria-label={`${it.name} 1${it.unit} 판매`}>
                            −1
                          </button>
                          <button type="button" className="more" disabled={!!busy} onClick={() => run('기록하는 중', async () => void must(await move(it, 'in', 1)))} aria-label={`${it.name} 1${it.unit} 입고`}>
                            +1
                          </button>
                        </span>
                      )}
                      {editing === it.id && (
                        <ItemDetail
                          item={it}
                          vendors={vendors}
                          moves={moves.filter((m) => m.item_id === it.id).slice(0, 10)}
                          canWrite={canWrite}
                          busy={busy}
                          ordered={orderedIds.has(it.id)}
                          onOrder={() => (setEditing(null), openCompose(vendorOf(it.vendor_id) ? it.vendor_id! : '', [it.id]))}
                          onMove={(kind, qty, note) => run('기록하는 중', async () => void must(await move(it, kind, qty, note)), `${it.name} ${MOVE_KO[kind]} 기록했습니다.`)}
                          onSave={(patch) =>
                            run('저장하는 중', async () => {
                              must(await supabase.from('supply_items').update(patch).eq('id', it.id));
                              setEditing(null);
                            }, '저장했습니다.')
                          }
                          onDelete={() => {
                            if (!confirm(`${it.name} 품목과 기록을 모두 지울까요? 잠깐 안 쓰는 거라면 "안 씀"으로 두는 게 낫습니다.`)) return;
                            run('지우는 중', async () => {
                              must(await supabase.from('supply_items').delete().eq('id', it.id));
                              setEditing(null);
                            });
                          }}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </>
      )}

      {/* ── 거래처 ── */}
      <VendorSection
        station={station}
        vendors={vendors}
        items={items}
        purchases={purchases}
        settlements={settlements}
        canWrite={canWrite}
        busy={busy}
        stamp={stamp}
        onCompose={(vid) => openCompose(vid)}
        onSave={(v) =>
          run('거래처 저장하는 중', async () => {
            const { id, ...rest } = v;
            must(id ? await supabase.from('supply_vendors').update(rest).eq('id', id) : await supabase.from('supply_vendors').insert({ ...rest, station_id: sid }));
          }, v.id ? '거래처를 저장했습니다.' : `${v.name}을(를) 추가했습니다. 품목을 눌러 이 거래처를 지정하면 주문서가 거래처별로 묶입니다.`)
        }
        onDelete={(v) => {
          if (!confirm(`${v.name} 거래처를 지울까요? 이 거래처로 지정된 품목은 "거래처 미지정"이 되고, 정산 기록도 지워집니다. 입고 기록은 남습니다.`)) return;
          run('지우는 중', async () => {
            must(await supabase.from('supply_vendors').delete().eq('id', v.id));
          });
        }}
        onSettle={(vendorId, ym, amount) =>
          run('정산 기록하는 중', async () => {
            must(await supabase.from('supply_settlements').upsert({ vendor_id: vendorId, month: `${ym}-01`, station_id: sid, amount, settled_at: new Date().toISOString() }, { onConflict: 'vendor_id,month' }));
          }, `${vendorOf(vendorId)?.name ?? ''} ${monthKo(ym)} 정산을 ${won(amount)}으로 기록했습니다.`)
        }
        onUnsettle={(vendorId, ym) =>
          run('정산 취소하는 중', async () => {
            must(await supabase.from('supply_settlements').delete().eq('vendor_id', vendorId).eq('month', `${ym}-01`));
          })
        }
        onFixCost={(m, cost) =>
          run('단가 고치는 중', async () => {
            must(await supabase.from('supply_moves').update({ unit_cost: cost }).eq('id', m.id));
          })
        }
      />

      {/* ── 요소수 시세 ── */}
      {urea && (
        <>
          <h3 className="sub-head">주변 요소수 시세</h3>
          {urea.shortage && (
            <p className="change-note" role="alert">
              반경 {urea.radiusKm}km 판매처 {urea.stats.n}곳 중 {urea.stats.n - urea.stats.inStock}곳이 품절입니다. 요소수 재고를 확인하고 미리 발주해 두세요.
            </p>
          )}
          <p className="readout">
            {urea.stats.n > 0 ? (
              <>
                반경 {urea.radiusKm}km 판매처 {urea.stats.n}곳 평균 <b>{urea.stats.avg != null ? `${won(urea.stats.avg)}/L` : '-'}</b>
                {urea.stats.min != null && <>, 최저 {won(urea.stats.min)}</>}
                {urea.stats.n - urea.stats.inStock > 0 ? `, 품절 ${urea.stats.n - urea.stats.inStock}곳` : ', 모두 재고 있음'}.
              </>
            ) : (
              <>반경 {urea.radiusKm}km 안에 오피넷에 요소수를 공시한 주유소가 없습니다.</>
            )}{' '}
            {urea.ours
              ? `우리는 ${urea.ours.price != null ? `${won(urea.ours.price)}/L` : '가격 미공시'}, ${urea.ours.inStock ? '재고 있음' : '품절'}으로 공시돼 있습니다.`
              : '우리 주유소는 오피넷에 요소수를 공시하지 않았습니다.'}
          </p>
          <p className="fine">
            같은 시·도 판매처 {urea.national.n.toLocaleString('ko-KR')}곳 중 재고 있음 {urea.national.inStock.toLocaleString('ko-KR')}곳, 평균{' '}
            {urea.national.avg != null ? won(urea.national.avg) : '-'}/L. 오피넷 공시 기준이며 하루 네 번(7·13·18·24시) 바뀝니다.
          </p>
          {urea.nearby.length > 0 && (
            <>
              <button type="button" className="link-btn" aria-expanded={showUrea} onClick={() => setShowUrea(!showUrea)}>
                {showUrea ? '판매처 숨기기' : `판매처 ${urea.nearby.length}곳 보기`}
              </button>
              {showUrea && (
                <div className="table-scroll">
                  <table className="price-table">
                    <thead>
                      <tr>
                        <th scope="col">주유소</th>
                        <th scope="col" className="num">거리</th>
                        <th scope="col" className="num">원/L</th>
                        <th scope="col">재고</th>
                      </tr>
                    </thead>
                    <tbody>
                      {urea.nearby.map((s) => (
                        <tr key={s.id}>
                          <th scope="row">{s.name}</th>
                          <td className="num">{s.distanceKm}km</td>
                          <td className="num">{s.price != null ? s.price.toLocaleString('ko-KR') : '-'}</td>
                          <td>{s.inStock ? '있음' : <b className="alert-text">품절</b>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

// ── 바코드 찍은 뒤 ───────────────────────────────────────────────
interface Product {
  found: boolean;
  name?: string | null;
  brand?: string | null;
  spec?: string | null;
  category?: string | null;
  unit?: string | null;
  source?: string | null;
  reason?: string;
}

/** 이름 비슷한 정도 (글자 두 개씩 묶어 겹치는 비율, 0~1) */
function similar(a: string, b: string) {
  const norm = (s: string) => s.toLowerCase().replace(/[\s()\[\]·,.\-_/]+/g, '');
  const grams = (s: string) => {
    const g = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) g.set(s.slice(i, i + 2), (g.get(s.slice(i, i + 2)) ?? 0) + 1);
    return g;
  };
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x.includes(y) || y.includes(x)) return 0.9;
  const gx = grams(x);
  const gy = grams(y);
  let both = 0;
  gx.forEach((n, k) => (both += Math.min(n, gy.get(k) ?? 0)));
  return (2 * both) / (x.length - 1 + (y.length - 1) || 1);
}

function ScanResult({
  code,
  item,
  items,
  busy,
  onAgain,
  onClose,
  onMove,
  onAssign,
  onCreate,
}: {
  code: string;
  item?: Item;
  items: Item[];
  busy: string;
  onAgain: () => void;
  onClose: () => void;
  onMove: (it: Item, kind: Move['kind'], qty: number) => void;
  onAssign: (it: Item) => void;
  onCreate: (name: string, category: string, unit: string) => void;
}) {
  const [qty, setQty] = useState('1');
  const [assign, setAssign] = useState('');
  const [name, setName] = useState('');
  const [cat, setCat] = useState('기타');
  const [unit, setUnit] = useState('개');
  const [product, setProduct] = useState<Product | null>(null);
  const [looking, setLooking] = useState(false);
  const q = Number(qty);
  const free = items.filter((i) => !i.barcode);

  // 우리 품목에 없는 바코드면 웹에서 상품 이름을 찾아 연결·추가를 미리 채움
  useEffect(() => {
    if (item) return;
    let off = false;
    setProduct(null);
    setLooking(true);
    supabase.functions
      .invoke('barcode-lookup', { body: { code } })
      .then(({ data, error }) => {
        if (off) return;
        const p: Product = error ? { found: false, reason: 'LOOKUP_FAILED' } : (data as Product);
        setProduct(p);
        if (p.found && p.name) {
          setName((v) => v || p.name!);
          if (p.category && (SUPPLY_CATEGORIES as readonly string[]).includes(p.category)) setCat(p.category);
          if (p.unit) setUnit(p.unit);
          const best = free
            .map((i) => [i, similar(i.name, p.name!)] as const)
            .sort((a, b) => b[1] - a[1])[0];
          if (best && best[1] >= 0.45) setAssign((v) => v || best[0].id);
        }
      })
      .finally(() => !off && setLooking(false));
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, item?.id]);

  const suggested = assign ? items.find((i) => i.id === assign) : undefined;

  return (
    <div className="scan-result">
      <p className="fine">바코드 {code}</p>
      {item ? (
        <>
          <p className="insp-name">
            {item.name} <span className="brand-name">지금 {qtyFmt(n(item.stock))}{item.unit}</span>
          </p>
          <div className="copy-row qty-row">
            <input inputMode="decimal" aria-label="수량" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d.]/g, ''))} />
            <button type="button" className="primary" disabled={!!busy || !(q > 0)} onClick={() => onMove(item, 'out', q)}>
              판매 {qty || 0}
            </button>
            <button type="button" className="more" disabled={!!busy || !(q > 0)} onClick={() => onMove(item, 'in', q)}>
              입고 {qty || 0}
            </button>
          </div>
        </>
      ) : (
        <>
          {looking ? (
            <p className="readout" role="status">
              우리 품목에 아직 연결되지 않은 바코드입니다. 웹에서 어떤 상품인지 찾는 중이에요 (길면 30초쯤). 기다리지 않고 아래에서 바로 연결해도 됩니다.
            </p>
          ) : product?.found ? (
            <p className="readout">
              웹 검색으로는 <b>{product.name}</b>(으)로 보입니다. 우리 품목에는 아직 연결되지 않았으니 맞는지 확인하고 연결하거나 추가하세요.
              {product.source && (
                <>
                  {' '}
                  <a href={product.source} target="_blank" rel="noreferrer">
                    확인한 페이지
                  </a>
                </>
              )}
            </p>
          ) : (
            <p className="readout">
              {product?.reason === 'CHECK_DIGIT'
                ? '바코드 숫자가 잘못 읽혔습니다. 다시 찍거나 숫자를 확인해 주세요.'
                : product?.reason === 'LIMIT'
                  ? '오늘 바코드 웹 검색 한도를 다 썼습니다. 아래에서 품목에 연결하거나 이름을 직접 넣어 추가하세요.'
                  : '우리 품목에 아직 연결되지 않은 바코드이고, 웹에서도 상품 이름을 찾지 못했습니다. 아래에서 품목에 연결하거나 새로 추가하세요.'}
            </p>
          )}

          {free.length > 0 && (
            <>
              <p className="fine">{suggested && product?.found ? '이름이 비슷한 우리 품목을 골라 두었습니다. 맞으면 연결하세요.' : '이미 있는 품목이면 연결하세요.'}</p>
              <div className="copy-row">
                <select aria-label="연결할 품목" value={assign} onChange={(e) => setAssign(e.target.value)}>
                  <option value="">연결할 품목 고르기</option>
                  {free.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
                </select>
                <button type="button" className="primary" disabled={!assign || !!busy} onClick={() => onAssign(suggested!)}>
                  연결
                </button>
              </div>
            </>
          )}

          <p className="fine">처음 들이는 상품이면 새 품목으로 추가하세요.</p>
          <div className="copy-row">
            <input placeholder="새 품목 이름" value={name} onChange={(e) => setName(e.target.value)} aria-label="새 품목 이름" />
            <button type="button" className="more" disabled={!name.trim() || !!busy} onClick={() => onCreate(name.trim(), cat, unit.trim() || '개')}>
              새 품목으로
            </button>
          </div>
          {name.trim() && (
            <div className="copy-row">
              <select aria-label="분류" value={cat} onChange={(e) => setCat(e.target.value)}>
                {SUPPLY_CATEGORIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
              <input aria-label="단위" placeholder="단위" value={unit} onChange={(e) => setUnit(e.target.value)} style={{ maxWidth: '6em' }} />
            </div>
          )}
        </>
      )}
      <div className="form-actions">
        <button type="button" className="more" onClick={onAgain}>
          다음 바코드
        </button>
        <button type="button" className="link-btn" onClick={onClose}>
          닫기
        </button>
      </div>
    </div>
  );
}

// ── 재고 실사 ───────────────────────────────────────────────────
function CountForm({ items, busy, onCancel, onSave }: { items: Item[]; busy: string; onCancel: () => void; onSave: (c: Array<[Item, number]>) => void }) {
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(items.map((i) => [i.id, String(n(i.stock))])));
  const changed = items.filter((i) => vals[i.id] !== '' && Number(vals[i.id]) !== n(i.stock) && Number.isFinite(Number(vals[i.id])));
  return (
    <form
      className="form boxed count-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(changed.map((i) => [i, Number(vals[i.id])]));
      }}
    >
      <p className="fine">창고·진열대에 있는 개수를 세어 넣으세요. 바뀐 품목만 저장되고, 줄어든 양은 판매·사용으로 계산합니다. 주 1회면 충분합니다.</p>
      <ul className="count-list">
        {items.map((i) => (
          <li key={i.id}>
            <label>
              <span>
                {i.name} <span className="brand-name">장부 {qtyFmt(n(i.stock))}</span>
              </span>
              <span className="count-input">
                <input inputMode="decimal" value={vals[i.id]} onChange={(e) => setVals({ ...vals, [i.id]: e.target.value.replace(/[^\d.]/g, '') })} onFocus={(e) => e.target.select()} />
                {i.unit}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="form-actions">
        <button type="submit" className="primary" disabled={!!busy || changed.length === 0}>
          {changed.length}개 저장
        </button>
        <button type="button" className="more" onClick={onCancel}>
          취소
        </button>
      </div>
    </form>
  );
}

// ── 품목 추가 (기본 목록 + 직접) ─────────────────────────────────────
function AddItems({
  existing,
  vendors,
  busy,
  onCancel,
  onAdd,
}: {
  existing: Item[];
  vendors: Vendor[];
  busy: string;
  onCancel: () => void;
  onAdd: (rows: Array<Partial<Item>>) => void;
}) {
  const have = new Set(existing.map((i) => i.name));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [custom, setCustom] = useState({ name: '', category: '기타', unit: '개', reorder_point: '', order_qty: '', vendor_id: '' });
  const toggle = (name: string) => {
    const next = new Set(picked);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setPicked(next);
  };
  return (
    <div className="form boxed add-items">
      <p className="fine">주유소에서 흔히 쓰는 소모품입니다. 쓰는 것만 고르세요. 이름·단위는 추가한 뒤 고칠 수 있습니다.</p>
      {SUPPLY_CATEGORIES.map((c) => {
        const list = PRESETS.filter((p) => p.category === c);
        if (!list.length) return null;
        return (
          <fieldset key={c}>
            <legend>{c}</legend>
            <div className="preset-grid">
              {list.map((p) => (
                <label key={p.name} className={`preset ${have.has(p.name) ? 'has' : ''}`}>
                  <input type="checkbox" disabled={have.has(p.name)} checked={have.has(p.name) || picked.has(p.name)} onChange={() => toggle(p.name)} />
                  <span>
                    {p.name}
                    {(p.hint || have.has(p.name)) && <span className="found-addr">{have.has(p.name) ? '이미 있음' : p.hint}</span>}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        );
      })}
      <div className="form-actions">
        <button
          type="button"
          className="primary"
          disabled={!!busy || picked.size === 0}
          onClick={() => onAdd(PRESETS.filter((p) => picked.has(p.name)).map((p) => ({ name: p.name, category: p.category, unit: p.unit })))}
        >
          {picked.size}개 추가
        </button>
        <button type="button" className="more" onClick={onCancel}>
          닫기
        </button>
      </div>

      <form
        className="custom-item"
        onSubmit={(e) => {
          e.preventDefault();
          if (!custom.name.trim()) return;
          onAdd([
            {
              name: custom.name.trim(),
              category: custom.category,
              unit: custom.unit.trim() || '개',
              reorder_point: Number(custom.reorder_point) || 0,
              order_qty: Number(custom.order_qty) || 0,
              vendor_id: custom.vendor_id || null,
            },
          ]);
        }}
      >
        <h4 className="sup-cat">목록에 없는 품목 직접 추가</h4>
        <div className="cf-grid">
          <label className="cf-field">
            <span>품목 이름</span>
            <input required value={custom.name} placeholder="예: 타이어 공기압 게이지" onChange={(e) => setCustom({ ...custom, name: e.target.value })} />
          </label>
          <label className="cf-field">
            <span>분류</span>
            <select value={custom.category} onChange={(e) => setCustom({ ...custom, category: e.target.value })}>
              {SUPPLY_CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="cf-field">
            <span>단위</span>
            <input value={custom.unit} placeholder="개, 통, 박스, 롤" onChange={(e) => setCustom({ ...custom, unit: e.target.value })} />
          </label>
          <label className="cf-field">
            <span>발주점 (이하면 주문)</span>
            <input inputMode="decimal" value={custom.reorder_point} onChange={(e) => setCustom({ ...custom, reorder_point: e.target.value.replace(/[^\d.]/g, '') })} />
          </label>
          <label className="cf-field">
            <span>한 번에 주문할 수량</span>
            <input inputMode="decimal" value={custom.order_qty} onChange={(e) => setCustom({ ...custom, order_qty: e.target.value.replace(/[^\d.]/g, '') })} />
          </label>
          <label className="cf-field">
            <span>거래처</span>
            <select value={custom.vendor_id} onChange={(e) => setCustom({ ...custom, vendor_id: e.target.value })}>
              <option value="">미지정</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-actions">
          <button type="submit" className="primary" disabled={!!busy || !custom.name.trim()}>
            직접 추가
          </button>
        </div>
      </form>
    </div>
  );
}

// ── 품목 상세·수정 ──────────────────────────────────────────────
function ItemDetail({
  item,
  vendors,
  moves,
  canWrite,
  busy,
  ordered,
  onOrder,
  onMove,
  onSave,
  onDelete,
}: {
  item: Item;
  vendors: Vendor[];
  moves: Move[];
  canWrite: boolean;
  busy: string;
  ordered: boolean;
  onOrder: () => void;
  onMove: (kind: Move['kind'], qty: number, note: string) => void;
  onSave: (patch: Partial<Item>) => void;
  onDelete: () => void;
}) {
  const [f, setF] = useState({
    name: item.name,
    category: item.category,
    unit: item.unit,
    barcode: item.barcode ?? '',
    vendor_id: item.vendor_id ?? '',
    reorder_point: String(n(item.reorder_point)),
    order_qty: String(n(item.order_qty)),
    unit_cost: item.unit_cost != null ? String(item.unit_cost) : '',
    sell_price: item.sell_price != null ? String(item.sell_price) : '',
    active: item.active,
    note: item.note,
  });
  const [qty, setQty] = useState('');
  const num = (s: string) => s.replace(/[^\d.]/g, '');
  return (
    <div className="sup-detail">
      {canWrite && (
        <div className="copy-row qty-row">
          <input inputMode="decimal" placeholder="수량" aria-label={`${item.name} 수량`} value={qty} onChange={(e) => setQty(num(e.target.value))} />
          <button type="button" className="primary" disabled={!!busy || !(Number(qty) > 0)} onClick={() => (onMove('in', Number(qty), ''), setQty(''))}>
            입고
          </button>
          <button type="button" className="more" disabled={!!busy || !(Number(qty) > 0)} onClick={() => (onMove('out', Number(qty), ''), setQty(''))}>
            판매·사용
          </button>
          <button type="button" className="more" disabled={!!busy || qty === ''} onClick={() => (onMove('count', Number(qty), '개별 실사'), setQty(''))}>
            이 수로 맞춤
          </button>
          <button type="button" className="more" onClick={onOrder}>
            {ordered ? '또 주문하기' : '주문하기'}
          </button>
        </div>
      )}
      {moves.length > 0 && (
        <ul className="move-list">
          {moves.map((m) => (
            <li key={m.id}>
              {md(m.created_at)} {MOVE_KO[m.kind]} {m.kind === 'count' ? `${qtyFmt(n(m.qty))}${item.unit}로` : `${qtyFmt(n(m.qty))}${item.unit}`}
              {m.stock_before != null && m.stock_after != null && (
                <span className="brand-name">
                  {qtyFmt(n(m.stock_before))} → {qtyFmt(n(m.stock_after))}
                </span>
              )}
              {m.note && <span className="brand-name">{m.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            onSave({
              name: f.name.trim() || item.name,
              category: f.category,
              unit: f.unit.trim() || '개',
              barcode: f.barcode.trim() || null,
              vendor_id: f.vendor_id || null,
              reorder_point: Number(f.reorder_point) || 0,
              order_qty: Number(f.order_qty) || 0,
              unit_cost: f.unit_cost === '' ? null : Number(f.unit_cost),
              sell_price: f.sell_price === '' ? null : Number(f.sell_price),
              active: f.active,
              note: f.note,
            });
          }}
        >
          <div className="cf-grid">
            <label className="cf-field">
              <span>품목 이름</span>
              <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </label>
            <label className="cf-field">
              <span>분류</span>
              <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
                {SUPPLY_CATEGORIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className="cf-field">
              <span>단위</span>
              <input value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} />
            </label>
            <label className="cf-field">
              <span>거래처</span>
              <select value={f.vendor_id} onChange={(e) => setF({ ...f, vendor_id: e.target.value })}>
                <option value="">미지정</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="cf-field">
              <span>발주점 (이하면 주문)</span>
              <input inputMode="decimal" value={f.reorder_point} onChange={(e) => setF({ ...f, reorder_point: num(e.target.value) })} />
            </label>
            <label className="cf-field">
              <span>한 번에 주문할 수량</span>
              <input inputMode="decimal" value={f.order_qty} onChange={(e) => setF({ ...f, order_qty: num(e.target.value) })} />
            </label>
            <label className="cf-field">
              <span>들여오는 값 (원)</span>
              <input inputMode="numeric" value={f.unit_cost} onChange={(e) => setF({ ...f, unit_cost: e.target.value.replace(/\D/g, '') })} />
            </label>
            <label className="cf-field">
              <span>파는 값 (원)</span>
              <input inputMode="numeric" value={f.sell_price} onChange={(e) => setF({ ...f, sell_price: e.target.value.replace(/\D/g, '') })} />
            </label>
            <label className="cf-field">
              <span>바코드</span>
              <input inputMode="numeric" value={f.barcode} onChange={(e) => setF({ ...f, barcode: e.target.value })} />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={!f.active} onChange={(e) => setF({ ...f, active: !e.target.checked })} /> 안 씀 (목록에 남기되 주문·알림에서 뺌)
          </label>
          <div className="form-actions">
            <button type="submit" className="primary" disabled={!!busy}>
              저장
            </button>
            <button type="button" className="link-btn danger" onClick={onDelete}>
              품목 지우기
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
