import { useCallback, useEffect, useMemo, useState } from 'react';
import { md } from './data';
import { FUEL_KO, FUELS, type FuelKind } from './fuel';
import { supabase } from './supabase';
import type { MarketLatest } from './types';
import { Loading } from './Loading';

interface Tank {
  fuel: FuelKind;
  capacity_l: number;
  reorder_l: number;
}
interface Dip {
  id: string;
  fuel: FuelKind;
  measured_at: string;
  liters: number;
}
export interface Delivery {
  fuel: FuelKind;
  liters: number | null;
  created_at: string;
}
/** 일 마감에서 온 하루 판매량 (L) */
export interface DaySale {
  date: string;
  liters: Partial<Record<FuelKind, number>>;
}

const num = (v: number | string | null | undefined) => Number(v ?? 0);
const L = (v: number) => `${Math.round(v).toLocaleString('ko-KR')}L`;
const DAY = 86_400_000;
const kstDate = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3_600_000).toISOString().slice(0, 10);

export interface StockEstimate {
  fuel: FuelKind;
  /** 지금 추정 재고 */
  now: number | null;
  perDay: number | null;
  daysLeft: number | null;
  lastDip: Dip | null;
  tank: Tank | null;
  /** 하루 판매량을 어디서 구했는지 */
  basis: 'closes' | 'dips' | null;
}

/**
 * 재고 추정. 하루 판매량은 일 마감 기록이 있으면 그 평균(최근 14일), 없으면 측정값 사이에 줄어든 양으로 구함.
 */
export function estimate(fuel: FuelKind, tank: Tank | null, dips: Dip[], deliveries: Delivery[], sales: DaySale[], now = Date.now()): StockEstimate {
  const mine = dips.filter((d) => d.fuel === fuel).sort((a, b) => Date.parse(a.measured_at) - Date.parse(b.measured_at));
  const del = deliveries.filter((d) => d.fuel === fuel && d.liters != null);
  const inBetween = (from: number, to: number) => del.filter((d) => Date.parse(d.created_at) > from && Date.parse(d.created_at) <= to).reduce((s, d) => s + num(d.liters), 0);
  const last = mine[mine.length - 1] ?? null;

  // 하루 판매량
  let perDay: number | null = null;
  let basis: StockEstimate['basis'] = null;
  const recentSales = sales.filter((s) => s.liters[fuel] != null && Date.parse(`${s.date}T00:00:00+09:00`) >= now - 14 * DAY);
  if (recentSales.length >= 3) {
    perDay = recentSales.reduce((s, x) => s + num(x.liters[fuel]), 0) / recentSales.length;
    basis = 'closes';
  } else {
    const since = now - 35 * DAY;
    let used = 0;
    let span = 0;
    for (let i = 1; i < mine.length; i++) {
      const a = Date.parse(mine[i - 1].measured_at);
      const b = Date.parse(mine[i].measured_at);
      if (b < since || b - a < DAY / 4) continue;
      const u = num(mine[i - 1].liters) + inBetween(a, b) - num(mine[i].liters);
      if (u < 0) continue; // 입고를 안 적은 구간: 계산에서 뺌
      used += u;
      span += b - a;
    }
    if (span >= DAY) {
      perDay = used / (span / DAY);
      basis = 'dips';
    }
  }

  if (!last) return { fuel, now: null, perDay, daysLeft: null, lastDip: null, tank, basis };
  const t0 = Date.parse(last.measured_at);
  const added = inBetween(t0, now);
  // 측정 뒤 판 양: 마감 기록이 있는 날은 그 값, 없는 날은 하루 평균
  const dipDay = kstDate(last.measured_at);
  const closed = sales.filter((s) => s.date > dipDay && s.liters[fuel] != null);
  const closedSum = closed.reduce((s, x) => s + num(x.liters[fuel]), 0);
  const daysSince = Math.max(0, (now - t0) / DAY);
  const uncovered = Math.max(0, daysSince - closed.length);
  const sold = closedSum + (perDay ?? 0) * uncovered;
  const est = Math.max(0, num(last.liters) + added - sold);
  return { fuel, now: est, perDay, daysLeft: perDay && perDay > 0 ? est / perDay : null, lastDip: last, tank, basis };
}

/** 원유값(원화 환산) 2주 변화로 본 공급가 방향 */
export function supplyTrend(market: MarketLatest | null): { dir: 'up' | 'down' | 'flat'; pct: number } | null {
  const pct = market?.crude?.changePct;
  if (pct == null) return null;
  return { dir: pct >= 2 ? 'up' : pct <= -2 ? 'down' : 'flat', pct };
}

function advice(e: StockEstimate, trend: ReturnType<typeof supplyTrend>): { text: string; tone: 'now' | 'soon' | 'wait' | 'ok' } | null {
  if (e.now == null) return null;
  const low = e.tank && num(e.tank.reorder_l) > 0 && e.now <= num(e.tank.reorder_l);
  if (e.daysLeft != null && e.daysLeft <= 2) return { text: '이틀 치도 안 남았습니다. 지금 발주하세요.', tone: 'now' };
  if (low) return { text: '발주 기준 아래입니다. 발주할 때입니다.', tone: 'now' };
  if (e.daysLeft != null && e.daysLeft <= 5) {
    if (trend?.dir === 'down') return { text: '곧 발주해야 합니다. 공급가가 내릴 흐름이라 필요한 만큼만 받는 편이 유리합니다.', tone: 'soon' };
    if (trend?.dir === 'up') return { text: '곧 발주해야 합니다. 공급가가 오를 흐름이라 넉넉히 받는 편이 유리합니다.', tone: 'soon' };
    return { text: '며칠 안에 발주해야 합니다.', tone: 'soon' };
  }
  if (trend?.dir === 'up') return { text: '재고는 넉넉하지만 공급가가 오를 흐름입니다. 탱크에 자리가 있으면 미리 채우는 것도 방법입니다.', tone: 'soon' };
  if (trend?.dir === 'down') return { text: '재고가 넉넉하고 공급가가 내릴 흐름입니다. 기다려도 됩니다.', tone: 'wait' };
  return { text: '재고가 넉넉합니다.', tone: 'ok' };
}

/** 유류 장부 2) 탱크 재고와 발주 타이밍 */
export function FuelStock({
  sid,
  canWrite,
  deliveries,
  sales,
  market,
  onError,
  onNotice,
}: {
  sid: string;
  canWrite: boolean;
  deliveries: Delivery[];
  sales: DaySale[];
  market: MarketLatest | null;
  onError: (m: string) => void;
  onNotice: (m: string) => void;
}) {
  const [tanks, setTanks] = useState<Tank[] | null>(null);
  const [dips, setDips] = useState<Dip[]>([]);
  const [mode, setMode] = useState<'' | 'dip' | 'tanks'>('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const since = new Date(Date.now() - 60 * DAY).toISOString();
    const [t, d] = await Promise.all([
      supabase.from('fuel_tanks').select('fuel,capacity_l,reorder_l').eq('station_id', sid),
      supabase.from('fuel_dips').select('id,fuel,measured_at,liters').eq('station_id', sid).gte('measured_at', since).order('measured_at', { ascending: false }).limit(500),
    ]);
    if (t.error) onError(t.error.message);
    setTanks((t.data as Tank[]) ?? []);
    setDips((d.data as Dip[]) ?? []);
  }, [sid, onError]);
  useEffect(() => {
    reload();
  }, [reload]);

  const act = async (fn: () => PromiseLike<{ error: { message: string } | null }>, done: string) => {
    setBusy(true);
    onError('');
    const { error } = await fn();
    setBusy(false);
    if (error) return onError(error.message);
    onNotice(done);
    setMode('');
    await reload();
  };

  const trend = supplyTrend(market);
  const shown = useMemo(() => FUELS.filter((f) => tanks?.some((t) => t.fuel === f) || dips.some((d) => d.fuel === f)), [tanks, dips]);
  const ests = useMemo(
    () => shown.map((f) => estimate(f, tanks?.find((t) => t.fuel === f) ?? null, dips, deliveries, sales)),
    [shown, tanks, dips, deliveries, sales],
  );

  if (!tanks) return <Loading size="inline" />;

  return (
    <>
      <h3 className="sub-head">탱크 재고와 발주</h3>
      {trend && (
        <p className={`trend trend-${trend.dir}`}>
          <b>
            공급가 흐름: {trend.dir === 'up' ? '오를 가능성' : trend.dir === 'down' ? '내릴 가능성' : '큰 변화 없음'}
          </b>
          원유값(원화 환산)이 2주 전보다 {Math.abs(trend.pct).toFixed(1)}% {trend.pct >= 0 ? '올랐습니다' : '내렸습니다'}. 국내 공급가는 보통 2~3주 늦게 따라갑니다.
        </p>
      )}

      {shown.length === 0 ? (
        <p className="note">탱크 용량을 넣고 재고를 한 번 재서 넣으면, 며칠 치가 남았는지와 발주할 때를 알려 드립니다.</p>
      ) : (
        <ul className="tank-list">
          {ests.map((e) => {
            const cap = e.tank ? num(e.tank.capacity_l) : null;
            const pct = cap && e.now != null ? Math.min(100, (e.now / cap) * 100) : null;
            const a = advice(e, trend);
            return (
              <li key={e.fuel} className={`tank ${a ? `tank-${a.tone}` : ''}`}>
                <div className="tank-head">
                  <p className="tank-name">{FUEL_KO[e.fuel]}</p>
                  <p className="tank-days">{e.daysLeft != null ? `약 ${e.daysLeft < 10 ? e.daysLeft.toFixed(1) : Math.round(e.daysLeft)}일 치` : ''}</p>
                </div>
                {e.now == null ? (
                  <p className="fine">재고를 재서 넣어 주세요.</p>
                ) : (
                  <>
                    <p className="tank-amount">
                      <b>{L(e.now)}</b>
                      {cap && <span> / {L(cap)}</span>}
                    </p>
                    {pct != null && (
                      <div className="gauge" role="img" aria-label={`탱크의 ${Math.round(pct)}%`}>
                        <span style={{ width: `${pct}%` }} />
                        {e.tank && num(e.tank.reorder_l) > 0 && cap && <i style={{ left: `${Math.min(100, (num(e.tank.reorder_l) / cap) * 100)}%` }} title="발주 기준" />}
                      </div>
                    )}
                    {a && <p className="tank-advice">{a.text}</p>}
                    <p className="fine">
                      {md(e.lastDip!.measured_at)}에 잰 {L(num(e.lastDip!.liters))}에서 입고와 판매를 더하고 뺀 추정입니다.
                      {e.perDay != null
                        ? ` 하루 약 ${L(e.perDay)} 판매 (${e.basis === 'closes' ? '일 마감 평균' : '측정값 사이에 줄어든 양'}).`
                        : ' 며칠 뒤 한 번 더 재서 넣으면 하루 판매량과 남은 일수가 나옵니다.'}
                    </p>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canWrite && mode === '' && (
        <div className="sup-actions">
          <button type="button" className="primary" onClick={() => setMode('dip')}>
            재고 재서 넣기
          </button>
          <button type="button" className="more" onClick={() => setMode('tanks')}>
            탱크 용량·발주 기준
          </button>
        </div>
      )}
      {mode === 'dip' && (
        <DipForm
          fuels={tanks.length ? tanks.map((t) => t.fuel) : FUELS}
          busy={busy}
          onCancel={() => setMode('')}
          onSave={(rows) => act(() => supabase.from('fuel_dips').insert(rows.map((r) => ({ ...r, station_id: sid }))), '재고 측정값을 기록했습니다.')}
        />
      )}
      {mode === 'tanks' && (
        <TankForm
          tanks={tanks}
          busy={busy}
          onCancel={() => setMode('')}
          onSave={async (rows, removed) => {
            if (removed.length) await supabase.from('fuel_tanks').delete().eq('station_id', sid).in('fuel', removed);
            await act(() => supabase.from('fuel_tanks').upsert(rows.map((r) => ({ ...r, station_id: sid }))), '탱크 설정을 저장했습니다.');
          }}
        />
      )}
      <p className="fine">
        공급가 흐름은 방향만 참고하세요. 실제 공급가는 정유사·대리점 공지로 확인해야 합니다. 매입 기록에 수량을 적으면 입고로 더해집니다.
      </p>
    </>
  );
}

function DipForm({ fuels, busy, onCancel, onSave }: { fuels: FuelKind[]; busy: boolean; onCancel: () => void; onSave: (rows: Array<{ fuel: FuelKind; liters: number }>) => void }) {
  const [vals, setVals] = useState<Partial<Record<FuelKind, string>>>({});
  const rows = fuels.filter((f) => vals[f] != null && vals[f] !== '').map((f) => ({ fuel: f, liters: Number(vals[f]) }));
  return (
    <form
      className="form boxed"
      onSubmit={(e) => {
        e.preventDefault();
        if (rows.length) onSave(rows);
      }}
    >
      <p className="fine">지금 탱크에 남은 양을 유종별로 넣으세요. 잰 것만 넣어도 됩니다.</p>
      <div className="cf-grid">
        {fuels.map((f) => (
          <label className="cf-field" key={f}>
            <span>{FUEL_KO[f]} (L)</span>
            <input inputMode="decimal" value={vals[f] ?? ''} onChange={(e) => setVals({ ...vals, [f]: e.target.value.replace(/[^\d.]/g, '') })} />
          </label>
        ))}
      </div>
      <div className="form-actions">
        <button type="submit" className="primary" disabled={busy || !rows.length}>
          {rows.length || ''} 기록
        </button>
        <button type="button" className="more" onClick={onCancel}>
          취소
        </button>
      </div>
    </form>
  );
}

function TankForm({
  tanks,
  busy,
  onCancel,
  onSave,
}: {
  tanks: Tank[];
  busy: boolean;
  onCancel: () => void;
  onSave: (rows: Array<{ fuel: FuelKind; capacity_l: number; reorder_l: number }>, removed: FuelKind[]) => void;
}) {
  const [vals, setVals] = useState<Record<FuelKind, { cap: string; re: string }>>(
    () => Object.fromEntries(FUELS.map((f) => { const t = tanks.find((x) => x.fuel === f); return [f, { cap: t ? String(num(t.capacity_l)) : '', re: t ? String(num(t.reorder_l)) : '' }]; })) as Record<FuelKind, { cap: string; re: string }>,
  );
  const rows = FUELS.filter((f) => Number(vals[f].cap) > 0).map((f) => ({ fuel: f, capacity_l: Number(vals[f].cap), reorder_l: Number(vals[f].re) || 0 }));
  const removed = tanks.map((t) => t.fuel).filter((f) => !rows.some((r) => r.fuel === f));
  const bad = rows.some((r) => r.reorder_l > r.capacity_l);
  return (
    <form
      className="form boxed"
      onSubmit={(e) => {
        e.preventDefault();
        if (rows.length && !bad) onSave(rows, removed);
      }}
    >
      <p className="fine">파는 유종만 채우세요. 용량을 비우면 그 유종은 목록에서 빠집니다.</p>
      <div className="tank-form">
        {FUELS.map((f) => (
          <fieldset key={f}>
            <legend>{FUEL_KO[f]}</legend>
            <div className="cf-grid">
              <label className="cf-field">
                <span>탱크 용량 (L)</span>
                <input inputMode="decimal" value={vals[f].cap} onChange={(e) => setVals({ ...vals, [f]: { ...vals[f], cap: e.target.value.replace(/[^\d.]/g, '') } })} />
              </label>
              <label className="cf-field">
                <span>발주 기준 (L 이하면 알림)</span>
                <input inputMode="decimal" value={vals[f].re} onChange={(e) => setVals({ ...vals, [f]: { ...vals[f], re: e.target.value.replace(/[^\d.]/g, '') } })} />
              </label>
            </div>
          </fieldset>
        ))}
      </div>
      {bad && <p className="change-note">발주 기준이 탱크 용량보다 큽니다.</p>}
      <div className="form-actions">
        <button type="submit" className="primary" disabled={busy || !rows.length || bad}>
          저장
        </button>
        <button type="button" className="more" onClick={onCancel}>
          취소
        </button>
      </div>
    </form>
  );
}
