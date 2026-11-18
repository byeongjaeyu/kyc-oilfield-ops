import { useCallback, useEffect, useMemo, useState } from 'react';
import { md, won } from './data';
import { FUEL_KO, FUELS, todayKst, type FuelKind } from './fuel';
import { FuelClose, type Close } from './FuelClose';
import { FuelRoutines } from './FuelRoutines';
import { FuelStock, type DaySale } from './FuelStock';
import { supabase, type Role, type Station } from './supabase';
import type { Fuel, MarketLatest, PriceHistoryEntry, PriceLatest } from './types';
import { Loading } from './Loading';
import { FuelAdvice } from './FuelAdvice';

const PRICED: Fuel[] = ['gasoline', 'diesel']; // 오피넷 가격 비교가 있는 유종

interface Purchase {
  id: string;
  fuel: FuelKind;
  bought_on: string;
  unit_cost: number;
  liters: number | null;
  supplier: string;
  note: string;
  created_at: string;
}

const num = (v: number | string | null | undefined) => Number(v ?? 0);
const r0 = (v: number) => Math.round(v);
const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(r0(v)).toLocaleString('ko-KR')}원`;

/** 판매가에서 매입 단가와 카드 수수료를 뺀 L당 마진 */
const marginOf = (price: number, cost: number, feePct: number) => price - cost - (price * feePct) / 100;

/** 유류 장부 — 임차인 전용. 1) 마진·가격 결정 */
export function FuelSection({
  station,
  role,
  canWrite,
  latest,
  history,
  market,
}: {
  station: Station;
  role: Role;
  canWrite: boolean;
  latest: PriceLatest | null;
  history: PriceHistoryEntry[];
  market: MarketLatest | null;
}) {
  const sid = station.id;
  const [purchases, setPurchases] = useState<Purchase[] | null>(null);
  const [feePct, setFeePct] = useState(1.5);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [closes, setCloses] = useState<Close[]>([]);
  const [tankFuels, setTankFuels] = useState<FuelKind[]>([]);
  const [preset, setPreset] = useState<{ fuel: Fuel; price: number; key: number } | null>(null);
  const sales: DaySale[] = useMemo(
    () => closes.map((c) => ({ date: c.close_on, liters: { gasoline: c.gasoline_l ?? undefined, diesel: c.diesel_l ?? undefined, premium: c.premium_l ?? undefined, kerosene: c.kerosene_l ?? undefined } })),
    [closes],
  );

  const reload = useCallback(async () => {
    const since = new Date(Date.now() - 62 * 86_400_000).toISOString().slice(0, 10);
    const [p, s, c, t] = await Promise.all([
      supabase.from('fuel_purchases').select('id,fuel,bought_on,unit_cost,liters,supplier,note,created_at').eq('station_id', sid).order('bought_on', { ascending: false }).order('created_at', { ascending: false }).limit(200),
      supabase.from('fuel_settings').select('card_fee_pct').eq('station_id', sid).maybeSingle(),
      supabase.from('daily_closes').select('*').eq('station_id', sid).gte('close_on', since).order('close_on', { ascending: false }),
      supabase.from('fuel_tanks').select('fuel').eq('station_id', sid),
    ]);
    setCloses((c.data as Close[]) ?? []);
    setTankFuels(((t.data ?? []) as Array<{ fuel: FuelKind }>).map((x) => x.fuel));
    if (p.error) setError(p.error.message);
    setPurchases((p.data as Purchase[]) ?? []);
    if (s.data) setFeePct(num(s.data.card_fee_pct));
  }, [sid]);
  useEffect(() => {
    reload();
  }, [reload]);

  const act = async (fn: () => PromiseLike<{ error: { message: string } | null }>, done: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    const { error } = await fn();
    setBusy(false);
    if (error) return setError(error.message);
    setNotice(done);
    await reload();
  };

  /** 최근 30일 마감에서 카드 매출 비중. 마감이 없으면 전부 카드로 봄 */
  const cardShare = useMemo(() => {
    const since = new Date(Date.now() - 30 * 86_400_000 + 9 * 3_600_000).toISOString().slice(0, 10);
    const rows = closes.filter((c) => c.close_on >= since);
    const card = rows.reduce((s, c) => s + num(c.card_sales), 0);
    const all = rows.reduce((s, c) => s + num(c.card_sales) + num(c.cash_sales) + num(c.other_sales), 0);
    return all > 0 ? card / all : null;
  }, [closes]);
  /** 판매가 대비 실제로 나가는 카드 수수료(%) */
  const effFee = feePct * (cardShare ?? 1);

  /** 유종별 가장 최근 매입 */
  const lastCost = useMemo(() => {
    const out: Partial<Record<FuelKind, Purchase>> = {};
    for (const p of purchases ?? []) if (!out[p.fuel]) out[p.fuel] = p;
    return out;
  }, [purchases]);

  return (
    <section className="block" aria-labelledby="fuel-title">
      <header className="block-head">
        <h2 id="fuel-title">유류 장부</h2>
        <p className="block-meta">
          {station.operation === 'self' ? '직접 운영하는 주유소의 매입·마진·재고·마감 장부입니다' : '임차인의 영업 정보라 임차인이 공유를 켜야 임대인도 봅니다'}
        </p>
      </header>
      {station.operation === 'leased' && role === 'tenant' && canWrite && <ShareWithOwner sid={sid} onError={setError} onNotice={setNotice} />}
      {station.operation === 'leased' && role === 'owner' && <p className="info-note">임차인이 공유해 둔 유류 장부입니다. 임차인이 공유를 끄면 보이지 않습니다.</p>}

      {error && (
        <p className="change-note" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="info-note">{notice}</p>}

      <FuelRoutines sid={sid} canWrite={canWrite} onError={setError} />

      {!purchases ? (
        <Loading />
      ) : (
        <>
          {latest && (
            <FuelAdvice
              latest={latest}
              history={history}
              market={market}
              costs={Object.fromEntries(PRICED.filter((f) => lastCost[f]).map((f) => [f, { cost: num(lastCost[f]!.unit_cost), date: lastCost[f]!.bought_on }]))}
              feePct={feePct}
              cardShare={cardShare}
              closes={closes}
              onTry={(fuel, price) => {
                setPreset({ fuel, price, key: Date.now() });
                requestAnimationFrame(() => document.getElementById('fuel-sim')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
              }}
            />
          )}
          <h3 className="sub-head">L당 마진</h3>
          <div className="kpis">
            {PRICED.map((f) => {
              const price = latest?.stats[f].ours ?? null;
              const last = lastCost[f];
              if (price == null || !last) {
                return (
                  <div className="kpi" key={f}>
                    <p className="kpi-label">{FUEL_KO[f]}</p>
                    <p className="kpi-empty">
                      {!last ? '매입 단가를 넣으면 마진이 나옵니다' : '오피넷에 우리 판매가가 올라오지 않아 계산하지 못합니다'}
                    </p>
                  </div>
                );
              }
              const cost = num(last.unit_cost);
              const fee = (price * effFee) / 100;
              const m = marginOf(price, cost, effFee);
              return (
                <div className={`kpi ${m < 0 ? 'kpi-warn' : ''}`} key={f}>
                  <p className="kpi-label">{FUEL_KO[f]}</p>
                  <p className={`kpi-value ${m < 0 ? 'alert-text' : ''}`}>{signed(m).replace('+', '')}</p>
                  <ul className="kpi-calc">
                    <li>
                      <span>판매</span>
                      <span>{won(price)}</span>
                    </li>
                    <li>
                      <span>매입</span>
                      <span>−{won(r0(cost))}</span>
                    </li>
                    <li>
                      <span>카드 수수료{cardShare != null && ` (카드 ${Math.round(cardShare * 100)}%)`}</span>
                      <span>−{won(r0(fee))}</span>
                    </li>
                  </ul>
                  <ul className="kpi-sub">
                    <li>매입 단가는 {md(last.bought_on)} 입고 기준</li>
                    <li>판매가의 {((m / price) * 100).toFixed(1)}%</li>
                  </ul>
                </div>
              );
            })}
          </div>
          <p className="fine">
            판매가는 오피넷에 올라간 우리 가격, 매입 단가는 가장 최근에 넣은 값입니다. 인건비·임대료 같은 고정비는 빼지 않은 숫자입니다.
          </p>

          {latest && PRICED.some((f) => latest.stats[f].ours != null && lastCost[f]) && (
            <Simulator latest={latest} costs={{ gasoline: lastCost.gasoline ? num(lastCost.gasoline.unit_cost) : null, diesel: lastCost.diesel ? num(lastCost.diesel.unit_cost) : null }} feePct={effFee} preset={preset} />
          )}

          <FuelStock sid={sid} canWrite={canWrite} deliveries={purchases} sales={sales} market={market} onError={setError} onNotice={setNotice} />

          <FuelClose
            sid={sid}
            canWrite={canWrite}
            closes={closes}
            fuels={FUELS.filter((f) => (tankFuels.length ? tankFuels.includes(f) : f === 'gasoline' || f === 'diesel') || closes.some((c) => c[`${f}_l` as keyof Close] != null))}
            feePct={feePct}
            margins={Object.fromEntries(
              PRICED.filter((f) => latest?.stats[f].ours != null && lastCost[f]).map((f) => [f, marginOf(latest!.stats[f].ours!, num(lastCost[f]!.unit_cost), effFee)]),
            )}
            onChanged={reload}
            onError={setError}
            onNotice={setNotice}
          />

          <h3 className="sub-head">매입 기록</h3>
          {canWrite &&
            (adding ? (
              <PurchaseForm
                busy={busy}
                onCancel={() => setAdding(false)}
                onSave={(row) =>
                  act(
                    () => supabase.from('fuel_purchases').insert({ ...row, station_id: sid }),
                    `${FUEL_KO[row.fuel]} 매입 단가 ${won(row.unit_cost)}을 기록했습니다.`,
                  ).then(() => setAdding(false))
                }
              />
            ) : (
              <button type="button" className="primary" onClick={() => setAdding(true)}>
                매입 기록 넣기
              </button>
            ))}
          {purchases.length === 0 ? (
            <p className="note">아직 매입 기록이 없습니다. 기름이 들어올 때 거래명세서의 L당 단가(부가세 포함)를 넣으세요.</p>
          ) : (
            <div className="table-scroll">
              <table className="price-table nowrap">
                <caption className="sr-only">매입 기록, 최근 순</caption>
                <thead>
                  <tr>
                    <th scope="col">날짜</th>
                    <th scope="col">유종</th>
                    <th scope="col" className="num">단가</th>
                    <th scope="col" className="num">수량</th>
                    <th scope="col">공급처</th>
                    {canWrite && <th scope="col"><span className="sr-only">지우기</span></th>}
                  </tr>
                </thead>
                <tbody>
                  {purchases.slice(0, 30).map((p) => (
                    <tr key={p.id}>
                      <th scope="row">{md(p.bought_on)}</th>
                      <td>{FUEL_KO[p.fuel]}</td>
                      <td className="num">{num(p.unit_cost).toLocaleString('ko-KR')}</td>
                      <td className="num">{p.liters == null ? '' : `${num(p.liters).toLocaleString('ko-KR')}L`}</td>
                      <td>{p.supplier}</td>
                      {canWrite && (
                        <td className="num">
                          <button
                            type="button"
                            className="link-btn danger-inline"
                            disabled={busy}
                            onClick={() => {
                              if (!confirm(`${md(p.bought_on)} ${FUEL_KO[p.fuel]} 매입 기록을 지울까요?`)) return;
                              act(() => supabase.from('fuel_purchases').delete().eq('id', p.id), '매입 기록을 지웠습니다.');
                            }}
                          >
                            지우기
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3 className="sub-head">카드 수수료율</h3>
          <FeeForm
            value={feePct}
            disabled={!canWrite || busy}
            onSave={(v) => act(() => supabase.from('fuel_settings').upsert({ station_id: sid, card_fee_pct: v }), `카드 수수료율을 ${v}%로 바꿨습니다.`)}
          />
        </>
      )}
    </section>
  );
}

/** 가격을 바꾸면 순위와 마진이 어떻게 되는지 */
function Simulator({ latest, costs, feePct, preset }: { latest: PriceLatest; costs: Record<Fuel, number | null>; feePct: number; preset: { fuel: Fuel; price: number; key: number } | null }) {
  const usable = PRICED.filter((f) => latest.stats[f].ours != null && costs[f] != null);
  const [fuel, setFuel] = useState<Fuel>(usable[0]);
  const f = usable.includes(fuel) ? fuel : usable[0];
  const ours = latest.stats[f].ours!;
  const cost = costs[f]!;
  const [draft, setDraft] = useState<Record<string, number>>({});
  const price = draft[f] ?? ours;
  const others = useMemo(() => latest.neighbors.map((n) => n[f]).filter((p): p is number => p != null).sort((a, b) => a - b), [latest, f]);
  const total = others.length + 1;
  const rankAt = (p: number) => others.filter((x) => x < p).length + 1;
  const nowRank = rankAt(ours);
  const newRank = rankAt(price);
  const mNow = marginOf(ours, cost, feePct);
  const mNew = marginOf(price, cost, feePct);
  const avg = others.length ? others.reduce((s, x) => s + x, 0) / others.length : null;
  const set = (p: number) => setDraft({ ...draft, [f]: Math.max(1, Math.min(9999, Math.round(p))) });
  useEffect(() => {
    if (!preset || !usable.includes(preset.fuel)) return;
    setFuel(preset.fuel);
    setDraft((d) => ({ ...d, [preset.fuel]: preset.price }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset?.key]);

  // 순위를 올리려면: r위가 되려면 r번째로 싼 경쟁 주유소 가격 이하 (같은 값이면 같은 순위)
  const ladder = useMemo(() => {
    const rows: Array<{ rank: number; price: number }> = [];
    for (let r = nowRank - 1; r >= 1 && rows.length < 5; r--) {
      const p = others[r - 1];
      if (p < ours && (!rows.length || rows[rows.length - 1].price !== p)) rows.push({ rank: rankAt(p), price: p });
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [others, ours, nowRank]);

  return (
    <>
      <h3 className="sub-head" id="fuel-sim">
        가격을 바꾸면
      </h3>
      {usable.length > 1 && (
        <div className="seg" role="group" aria-label="유종">
          {usable.map((x) => (
            <button key={x} type="button" aria-pressed={x === f} onClick={() => setFuel(x)}>
              {FUEL_KO[x]}
            </button>
          ))}
        </div>
      )}
      <div className="sim">
        <div className="sim-stepper" role="group" aria-label={`${FUEL_KO[f]} 판매가`}>
          <button type="button" className="more" onClick={() => set(price - 10)} aria-label="10원 내리기">
            −10
          </button>
          <label className="sim-price">
            <span className="sr-only">판매가</span>
            <input inputMode="numeric" value={price} onChange={(e) => set(Number(e.target.value.replace(/\D/g, '')) || 0)} />
            <span>원</span>
          </label>
          <button type="button" className="more" onClick={() => set(price + 10)} aria-label="10원 올리기">
            +10
          </button>
          {price !== ours && (
            <button type="button" className="link-btn" onClick={() => set(ours)}>
              지금 가격으로
            </button>
          )}
        </div>
        <dl className="sim-out">
          <div>
            <dt>순위</dt>
            <dd>
              {total}곳 중 <b>{newRank}위</b>
              {newRank !== nowRank && <span className="sim-was">지금 {nowRank}위</span>}
            </dd>
          </div>
          <div>
            <dt>L당 마진</dt>
            <dd>
              <b className={mNew < 0 ? 'alert-text' : ''}>{signed(mNew).replace('+', '')}</b>
              {price !== ours && <span className="sim-was">지금 {signed(mNow).replace('+', '')}</span>}
            </dd>
          </div>
          {avg != null && (
            <div>
              <dt>반경 평균과</dt>
              <dd>{Math.round(price - avg) === 0 ? '같음' : price > avg ? `${won(r0(price - avg))} 비쌈` : `${won(r0(avg - price))} 쌈`}</dd>
            </div>
          )}
        </dl>
      </div>
      {ladder.length > 0 && (
        <div className="table-scroll">
          <table className="price-table">
            <caption className="sr-only">순위를 올리는 데 필요한 가격과 그때의 마진</caption>
            <thead>
              <tr>
                <th scope="col">순위를 올리려면</th>
                <th scope="col" className="num">판매가</th>
                <th scope="col" className="num">지금보다</th>
                <th scope="col" className="num">L당 마진</th>
              </tr>
            </thead>
            <tbody>
              {ladder.map((row) => {
                const m = marginOf(row.price, cost, feePct);
                return (
                  <tr key={row.price}>
                    <th scope="row">
                      <button type="button" className="link-btn" onClick={() => set(row.price)}>
                        {row.rank}위
                      </button>
                    </th>
                    <td className="num">{row.price.toLocaleString('ko-KR')}</td>
                    <td className="num">−{(ours - row.price).toLocaleString('ko-KR')}</td>
                    <td className={`num ${m < 0 ? 'alert-text' : ''}`}>{signed(m).replace('+', '')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="fine">여기서 바꾼 가격은 계산만 해 보는 값입니다. 실제 판매가는 주유기와 오피넷 보고에서 바꿉니다.</p>
    </>
  );
}

function PurchaseForm({
  busy,
  onCancel,
  onSave,
}: {
  busy: boolean;
  onCancel: () => void;
  onSave: (row: { fuel: FuelKind; bought_on: string; unit_cost: number; liters: number | null; supplier: string }) => void;
}) {
  const [fuel, setFuel] = useState<FuelKind>('gasoline');
  const [date, setDate] = useState(todayKst());
  const [cost, setCost] = useState('');
  const [liters, setLiters] = useState('');
  const [supplier, setSupplier] = useState('');
  const c = Number(cost);
  const ok = c > 0 && c < 10000 && date;
  return (
    <form
      className="form boxed"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onSave({ fuel, bought_on: date, unit_cost: c, liters: Number(liters) > 0 ? Number(liters) : null, supplier: supplier.trim() });
      }}
    >
      <div className="seg" role="radiogroup" aria-label="유종">
        {(Object.keys(FUEL_KO) as FuelKind[]).map((x) => (
          <button key={x} type="button" role="radio" aria-checked={fuel === x} onClick={() => setFuel(x)}>
            {FUEL_KO[x]}
          </button>
        ))}
      </div>
      <div className="cf-grid">
        <label className="cf-field">
          <span>L당 단가 (부가세 포함, 원)</span>
          <input inputMode="decimal" required placeholder="예: 1652.5" value={cost} onChange={(e) => setCost(e.target.value.replace(/[^\d.]/g, ''))} />
        </label>
        <label className="cf-field">
          <span>들어온 날</span>
          <input type="date" required max={todayKst()} value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="cf-field">
          <span>수량 (L, 몰라도 됨)</span>
          <input inputMode="decimal" placeholder="예: 20000" value={liters} onChange={(e) => setLiters(e.target.value.replace(/[^\d.]/g, ''))} />
        </label>
        <label className="cf-field">
          <span>공급처 (선택)</span>
          <input value={supplier} maxLength={40} onChange={(e) => setSupplier(e.target.value)} />
        </label>
      </div>
      <div className="form-actions">
        <button type="submit" className="primary" disabled={busy || !ok}>
          기록
        </button>
        <button type="button" className="more" onClick={onCancel}>
          취소
        </button>
      </div>
    </form>
  );
}

function FeeForm({ value, disabled, onSave }: { value: number; disabled: boolean; onSave: (v: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const nv = Number(v);
  return (
    <>
      <div className="copy-row fee-row">
        <input inputMode="decimal" aria-label="카드 수수료율 (%)" value={v} disabled={disabled} onChange={(e) => setV(e.target.value.replace(/[^\d.]/g, ''))} />
        <span>%</span>
        <button type="button" className="more" disabled={disabled || !(nv >= 0 && nv <= 10) || nv === value} onClick={() => onSave(nv)}>
          저장
        </button>
      </div>
      <p className="fine">마진을 계산할 때 판매가에서 이 비율만큼 뺍니다. 카드사 정산서의 실제 수수료율로 맞춰 주세요.</p>
    </>
  );
}

/** 임대 중인 주유소: 임차인이 임대인에게 유류 장부를 보여줄지 */
function ShareWithOwner({ sid, onError, onNotice }: { sid: string; onError: (m: string) => void; onNotice: (m: string) => void }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    supabase
      .from('station_permissions')
      .select('can_read')
      .eq('station_id', sid)
      .eq('role', 'owner')
      .eq('area', 'fuel')
      .maybeSingle()
      .then(({ data }) => setOn(!!data?.can_read));
  }, [sid]);
  if (on == null) return null;
  const toggle = async () => {
    setBusy(true);
    onError('');
    const next = !on;
    const { error } = await supabase.from('station_permissions').update({ can_read: next, can_write: false }).eq('station_id', sid).eq('role', 'owner').eq('area', 'fuel');
    setBusy(false);
    if (error) return onError(error.message);
    setOn(next);
    onNotice(next ? '임대인도 유류 장부를 볼 수 있게 했습니다. 고치는 건 임차인만 할 수 있습니다.' : '임대인에게 유류 장부를 숨겼습니다.');
  };
  return (
    <div className="share-row">
      <p>
        <b>임대인에게 {on ? '공유 중' : '공유 안 함'}</b>
        <span>{on ? '임대인이 보기만 할 수 있습니다.' : '매입가·마진·매출은 임차인만 봅니다.'}</span>
      </p>
      <button type="button" className="more" disabled={busy} onClick={toggle} aria-pressed={on}>
        {on ? '공유 끄기' : '임대인에게 보여주기'}
      </button>
    </div>
  );
}
