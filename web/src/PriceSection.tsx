import { useMemo, useState } from 'react';
import { md, won } from './data';
import { LineChart, type Series } from './LineChart';
import type { Fuel, FuelStats, PriceHistoryEntry, PriceLatest } from './types';

const FUEL_KO: Record<Fuel, string> = { gasoline: '휘발유', diesel: '경유' };
// validate_palette.js (light, surface #E4E5E0) 통과한 3색
const C = { ours: '#C25E00', avg: '#3B5BAF', min: '#5A8F3A' };
const RANGE_DAYS = 90;
const hm = (iso: string) =>
  new Date(iso).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false });

/** 연료 하나의 요약 카드: 큰 값 + 순위 + 평균·최저 대비 */
function Kpi({ fuel, s, radiusKm }: { fuel: Fuel; s: FuelStats; radiusKm: number }) {
  if (s.ours == null) {
    return (
      <div className="kpi">
        <p className="kpi-label">{FUEL_KO[fuel]}</p>
        <p className="kpi-empty">오늘 오피넷에 올라오지 않았습니다</p>
      </div>
    );
  }
  const total = s.n + 1;
  const rank = s.rank === 1 ? '가장 쌈' : s.rank === total ? '가장 비쌈' : `${s.rank}번째로 쌈`;
  const avg =
    s.diffAvg == null || s.diffAvg === 0 ? '평균과 같음' : s.diffAvg > 0 ? `평균보다 ${won(s.diffAvg)} 비쌈` : `평균보다 ${won(-s.diffAvg)} 쌈`;
  const min = s.min == null || s.ours <= s.min ? '반경 최저가' : `최저가와 ${won(s.ours - s.min)} 차이`;
  return (
    <div className={`kpi ${s.diffAvg != null && s.diffAvg > 0 ? 'kpi-warn' : ''}`}>
      <p className="kpi-label">{FUEL_KO[fuel]}</p>
      <p className="kpi-value">{won(s.ours)}</p>
      <p className="kpi-rank">
        반경 {radiusKm}km {total}곳 중 <b>{rank}</b>
      </p>
      <ul className="kpi-sub">
        <li>{avg}</li>
        <li>{min}</li>
      </ul>
    </div>
  );
}

export function PriceSection({ latest, history }: { latest: PriceLatest; history: PriceHistoryEntry[] }) {
  const [fuel, setFuel] = useState<Fuel>('gasoline');

  const recent = history.slice(-RANGE_DAYS);
  const series: Series[] = useMemo(
    () => [
      { key: 'ours', name: latest.station.name || '우리 주유소', color: C.ours, values: recent.map((h) => h[fuel].ours) },
      { key: 'avg', name: '반경 평균', color: C.avg, values: recent.map((h) => h[fuel].avg) },
      { key: 'min', name: '반경 최저', color: C.min, dash: '5 5', values: recent.map((h) => h[fuel].min) },
    ],
    [recent, fuel],
  );

  const rows = useMemo(() => {
    const ours = { id: latest.station.id, name: latest.station.name, brand: latest.station.brand, distanceKm: 0, price: latest.stats[fuel].ours, self: true };
    const others = latest.neighbors.map((n) => ({ id: n.id, name: n.name, brand: n.brand, distanceKm: n.distanceKm, price: n[fuel], self: false }));
    return [ours, ...others].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  }, [latest, fuel]);

  const oursPrice = latest.stats[fuel].ours;
  const added = new Set(latest.changes.added);

  return (
    <section className="block" aria-labelledby="price-title">
      <header className="block-head">
        <h2 id="price-title">반경 {latest.radiusKm}km 가격</h2>
        <p className="block-meta">오피넷 {md(latest.fetchedAt)} {hm(latest.fetchedAt)} 기준, 4시간마다 갱신</p>
      </header>

      <div className="kpis">
        {(['gasoline', 'diesel'] as Fuel[]).map((f) => (
          <Kpi key={f} fuel={f} s={latest.stats[f]} radiusKm={latest.radiusKm} />
        ))}
      </div>

      {(latest.changes.added.length > 0 || latest.changes.removed.length > 0) && (
        <p className="change-note">
          {latest.changes.added.length > 0 && <>새로 잡힌 주유소: {latest.changes.added.join(', ')}. </>}
          {latest.changes.removed.length > 0 && <>사라진 주유소: {latest.changes.removed.join(', ')}.</>}
        </p>
      )}

      <div className="seg" role="group" aria-label="유종">
        {(['gasoline', 'diesel'] as Fuel[]).map((f) => (
          <button key={f} type="button" aria-pressed={fuel === f} onClick={() => setFuel(f)}>
            {FUEL_KO[f]}
          </button>
        ))}
      </div>

      {recent.length >= 2 ? (
        <LineChart dates={recent.map((h) => h.date)} series={series} label={`${FUEL_KO[fuel]} 가격 추이: ${latest.station.name || '우리 주유소'}, 반경 평균, 반경 최저`} />
      ) : (
        <p className="note">가격은 매일 쌓입니다. 이틀치가 모이면 여기에 추이 그래프가 나옵니다.</p>
      )}

      <table className="price-table">
        <caption className="sr-only">반경 내 주유소 {FUEL_KO[fuel]} 가격, 싼 순</caption>
        <thead>
          <tr>
            <th scope="col">주유소</th>
            <th scope="col" className="num">거리</th>
            <th scope="col" className="num">{FUEL_KO[fuel]}</th>
            <th scope="col" className="num">우리와 차이</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const diff = r.price != null && oursPrice != null && !r.self ? r.price - oursPrice : null;
            return (
              <tr key={r.id} className={r.self ? 'self' : undefined}>
                <th scope="row">
                  {r.name}
                  <span className="brand-name">{r.brand}</span>
                  {added.has(r.name) && <span className="new-badge">신규</span>}
                </th>
                <td className="num">{r.self ? '우리' : `${r.distanceKm}km`}</td>
                <td className="num">{r.price == null ? '판매 안 함' : r.price.toLocaleString('ko-KR')}</td>
                <td className={`num ${diff != null && diff < 0 ? 'cheaper' : ''}`}>
                  {diff == null ? '' : diff === 0 ? '같음' : `${diff > 0 ? '+' : '−'}${Math.abs(diff)}`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
