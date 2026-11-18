import { useState } from 'react';
import { FUEL_KO } from './fuel';
import type { Close } from './FuelClose';
import { advise, type Advice, type Unit } from './priceAdvice';
import type { Fuel, MarketLatest, PriceHistoryEntry, PriceLatest } from './types';

const won = (v: number) => `${Math.round(v).toLocaleString('ko-KR')}원`;
const wonBig = (v: number) => (Math.abs(v) >= 10_000 ? `${(Math.round(v / 1_000) / 10).toLocaleString('ko-KR')}만 원` : won(v));
const num = (v: number | string | null | undefined) => Number(v ?? 0);
const DAY = 86_400_000;

/** 유류 장부 맨 위: 오늘의 추천 판매가 */
export function FuelAdvice({
  latest,
  history,
  market,
  costs,
  feePct,
  cardShare,
  closes,
  onTry,
}: {
  latest: PriceLatest;
  history: PriceHistoryEntry[];
  market: MarketLatest | null;
  costs: Partial<Record<Fuel, { cost: number; date: string }>>;
  feePct: number;
  cardShare: number | null;
  closes: Close[];
  onTry: (fuel: Fuel, price: number) => void;
}) {
  const since = (days: number) => new Date(Date.now() - days * DAY + 9 * 3_600_000).toISOString().slice(0, 10);
  const perDay = (f: Fuel) => {
    const xs = closes.filter((c) => c.close_on >= since(14) && c[`${f}_l`] != null).map((c) => num(c[`${f}_l`]));
    return xs.length >= 3 ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
  };

  const list = (['gasoline', 'diesel'] as Fuel[])
    .map((f) => {
      const c = costs[f];
      if (!c) return null;
      return advise({ fuel: f, latest, history, market, cost: c.cost, costDate: c.date, feePct, cardShare, litersPerDay: perDay(f) });
    })
    .filter((a): a is Advice => !!a);
  if (!list.length) return null;

  return (
    <>
      <h3 className="sub-head">오늘의 추천 판매가</h3>
      <div className="adv-grid">
        {list.map((a) => (
          <AdviceCard key={a.fuel} a={a} feePct={feePct} cardShare={cardShare} onTry={() => onTry(a.fuel, a.price)} />
        ))}
      </div>
      <p className="fine">
        주변 가격, 우리가 평소 서 있던 가격대, 국제유가 흐름, 최근 매입가와 카드 수수료로 계산한 참고값입니다. 순이익은 인건비·임대료·전기료 같은 고정비를 빼기 전 금액입니다.
      </p>
    </>
  );
}

function AdviceCard({ a, feePct, cardShare, onTry }: { a: Advice; feePct: number; cardShare: number | null; onTry: () => void }) {
  const [open, setOpen] = useState(true);
  const badge = a.action === 'up' ? `${won(a.delta)} 올리기` : a.action === 'down' ? `${won(-a.delta)} 내리기` : '지금 가격 유지';
  const daily = a.litersPerDay != null ? a.unit.net * a.litersPerDay : null;
  const dailyNow = a.litersPerDay != null && a.unitNow ? a.unitNow.net * a.litersPerDay : null;
  return (
    <article className={`adv-card is-${a.action}`} aria-labelledby={`adv-${a.fuel}`}>
      <header className="adv-head">
        <h4 id={`adv-${a.fuel}`}>{FUEL_KO[a.fuel]}</h4>
        <span className="adv-badge">{badge}</span>
      </header>
      <p className="adv-price">
        <b>{a.price.toLocaleString('ko-KR')}</b>원
        {a.ours != null && a.action !== 'hold' && <span className="adv-was">지금 {a.ours.toLocaleString('ko-KR')}원</span>}
      </p>
      <p className="adv-rank">
        {a.rank.total}곳 중 {a.rank.next}위{a.rank.now != null && a.rank.now !== a.rank.next && ` (지금 ${a.rank.now}위)`}
      </p>

      <dl className="adv-profit">
        <div>
          <dt>L당 순이익</dt>
          <dd className={a.unit.net < 0 ? 'alert-text' : ''}>
            {won(a.unit.net)}
            {a.unitNow && a.action !== 'hold' && <span className="adv-was">지금 {won(a.unitNow.net)}</span>}
          </dd>
        </div>
        <div>
          <dt>하루 순이익</dt>
          <dd>
            {daily != null ? (
              <>
                약 {wonBig(daily)}
                <span className="adv-was">하루 {Math.round(a.litersPerDay!).toLocaleString('ko-KR')}L 판매 기준{dailyNow != null && a.action !== 'hold' ? `, 지금 ${wonBig(dailyNow)}` : ''}</span>
              </>
            ) : (
              <span className="adv-was">일 마감에 판매량을 넣으면 나옵니다</span>
            )}
          </dd>
        </div>
      </dl>
      <Calc u={a.unit} feePct={feePct} cardShare={cardShare} />
      {a.volumeBreakEvenPct != null && (
        <p className="adv-vol">
          {a.action === 'up'
            ? `판매량이 ${a.volumeBreakEvenPct.toFixed(1)}% 넘게 줄지 않으면 지금 가격보다 남습니다.`
            : `판매량이 ${a.volumeBreakEvenPct.toFixed(1)}% 넘게 늘어야 지금 가격보다 남습니다.`}
        </p>
      )}
      {a.costDrift != null && Math.abs(a.costDrift) >= 15 && (
        <p className="adv-vol">
          다음 입고가 {a.costDrift > 0 ? '오르면' : '내리면'}(L당 약 {won(Math.abs(a.costDrift))}) 이 가격의 L당 순이익은 {won(a.unit.net - a.costDrift)}이 됩니다.
        </p>
      )}

      <button type="button" className="link-btn adv-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? '추천 이유 접기' : '추천 이유 보기'}
      </button>
      {open && (
        <ul className="adv-reasons">
          {a.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
          {a.cautions.map((r) => (
            <li key={r} className="is-caution">
              {r}
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="more" onClick={onTry}>
        이 값으로 계산해 보기
      </button>
    </article>
  );
}

function Calc({ u, feePct, cardShare }: { u: Unit; feePct: number; cardShare: number | null }) {
  return (
    <ul className="kpi-calc adv-calc">
      <li>
        <span>판매</span>
        <span>{won(u.price)}</span>
      </li>
      <li>
        <span>매입</span>
        <span>−{won(u.cost)}</span>
      </li>
      <li>
        <span>
          카드 수수료 {feePct}%{cardShare != null && ` × 카드 비중 ${Math.round(cardShare * 100)}%`}
        </span>
        <span>−{won(u.fee)}</span>
      </li>
      <li className="adv-net">
        <span>남는 돈</span>
        <span>{won(u.net)}</span>
      </li>
    </ul>
  );
}
