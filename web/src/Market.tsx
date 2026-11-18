import { useMemo, useState } from 'react';
import { md, won } from './data';
import { LineChart, type Series } from './LineChart';
import type { MarketLatest, MarketPoint, MarketQuote, PriceLatest } from './types';

// PriceSection 과 같은 검증된 색 (light, surface #E4E5E0)
const C = { a: '#C25E00', b: '#3B5BAF', c: '#5A8F3A' };
const RANGE_DAYS = 90;

const hm = (iso: string) =>
  new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const pct = (n: number | null) => (n == null ? '' : `${n > 0 ? '+' : ''}${n.toFixed(Math.abs(n) < 10 ? 2 : 1)}%`);
const dollar = (v: number) => `${v.toFixed(2)}달러`;
const fx = (v: number) => `${v.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}원`;

/** 시세판 숫자 (DSEG7): 고정 자릿수 + 소수점 */
function TickerLed({ value, int, frac, label }: { value: number; int: number; frac: number; label: string }) {
  const text = value.toFixed(frac);
  const ghost = `${'8'.repeat(int)}${frac ? `.${'8'.repeat(frac)}` : ''}`;
  return (
    <span className="led ticker-led" role="img" aria-label={`${label} ${text}`}>
      <span className="led-ghost" aria-hidden>
        {ghost}
      </span>
      <span className="led-lit" aria-hidden>
        {text}
      </span>
    </span>
  );
}

function Delta({ q }: { q: MarketQuote }) {
  if (q.changePct == null) return <span className="tick-delta" />;
  const dir = q.changePct > 0 ? 'up' : q.changePct < 0 ? 'down' : 'flat';
  return (
    <span className={`tick-delta ${dir}`}>
      <span aria-hidden>{dir === 'up' ? '▲' : dir === 'down' ? '▼' : '–'}</span>
      {pct(q.changePct)}
    </span>
  );
}

/** 폴사인 기둥에 달린 국제 시세판 */
export function MarketBoard({ market }: { market: MarketLatest }) {
  const { wti, brent, usdkrw } = market.quotes;
  const rows: Array<[MarketQuote, number, number]> = [
    [wti, 3, 2],
    [brent, 3, 2],
    [usdkrw, 4, 1],
  ];
  return (
    <section className="ticker" aria-label="국제유가와 환율">
      <header className="ticker-head">
        <span>국제 시세</span>
        <time dateTime={market.fetchedAt}>{hm(market.fetchedAt)}</time>
      </header>
      {rows.map(([q, int, frac]) => (
        <div key={q.key} className="tick-row">
          <span className="tick-name">
            {q.name}
            <span className="tick-unit">{q.key === 'usdkrw' ? '원' : '$/배럴'}</span>
          </span>
          <TickerLed value={q.price} int={int} frac={frac} label={q.name} />
          <Delta q={q} />
        </div>
      ))}
      {market.crude && (
        <p className="ticker-foot">
          원화로 바꾼 원유 L당 <b>{market.crude.now.toLocaleString('ko-KR')}원</b>
          {market.crude.changePct != null && <>, 2주 전보다 {pct(market.crude.changePct)}</>}
        </p>
      )}
    </section>
  );
}

type View = 'crude' | 'oil' | 'fx';

/** 가격 비교 탭 아래: 국제유가·환율과 전국 평균 */
export function MarketSection({ market, prices }: { market: MarketLatest; prices: PriceLatest | null }) {
  const [view, setView] = useState<View>('crude');
  const { wti, brent, usdkrw } = market.quotes;
  const crude = market.crude;
  const dom = market.domestic;

  const chart = useMemo(() => {
    const last = <T extends { date: string }>(a: T[]) => a.slice(-RANGE_DAYS);
    if (view === 'crude' && crude) {
      const h = last(crude.history);
      return {
        dates: h.map((p) => p.date),
        series: [{ key: 'crude', name: '원화 환산 원유', color: C.a, values: h.map((p) => p.value) }] as Series[],
        label: '원화로 환산한 브렌트유 가격 추이 (원/L)',
        formatY: won,
      };
    }
    if (view === 'fx') {
      const h = last(usdkrw.history);
      return {
        dates: h.map((p) => p.date),
        series: [{ key: 'fx', name: '원/달러', color: C.b, values: h.map((p) => p.value) }] as Series[],
        label: '원/달러 환율 추이',
        formatY: fx,
      };
    }
    // WTI·브렌트: 날짜를 합쳐 한 축에
    const dates = [...new Set([...last(wti.history), ...last(brent.history)].map((p) => p.date))].sort().slice(-RANGE_DAYS);
    const at = (h: MarketPoint[]) => {
      const m = new Map(h.map((p) => [p.date, p.value]));
      return dates.map((d) => m.get(d) ?? null);
    };
    return {
      dates,
      series: [
        { key: 'brent', name: '브렌트', color: C.a, values: at(brent.history) },
        { key: 'wti', name: 'WTI', color: C.b, values: at(wti.history) },
      ] as Series[],
      label: 'WTI·브렌트 원유 가격 추이 (달러/배럴)',
      formatY: dollar,
    };
  }, [view, crude, wti, brent, usdkrw]);

  const ours = prices?.stats;
  const vsNational = (o: number | null | undefined, n: number | null | undefined) =>
    o != null && n != null ? (Math.round(o - n) === 0 ? '전국 평균과 같음' : `전국 평균보다 ${won(Math.abs(Math.round(o - n)))} ${o > n ? '비쌈' : '쌈'}`) : null;

  return (
    <section className="block" aria-labelledby="market-title">
      <header className="block-head">
        <h2 id="market-title">국제유가·환율</h2>
        <p className="block-meta">{hm(market.fetchedAt)} 기준, 4시간마다 갱신</p>
      </header>

      {crude && (
        <p className="readout">
          <b className="price-big">L당 {crude.now.toLocaleString('ko-KR')}원</b> 브렌트유를 오늘 환율({fx(usdkrw.price)})로 바꾼 원유 값입니다.
          {crude.changePct != null && (
            <>
              {' '}
              2주 전({crude.twoWeeksAgo?.toLocaleString('ko-KR')}원)보다 {Math.abs(crude.changePct).toFixed(1)}% {crude.changePct >= 0 ? '올랐습니다' : '내렸습니다'}.
            </>
          )}{' '}
          국제 가격 변화는 보통 2~3주 뒤 주유소 판매가에 반영됩니다.
        </p>
      )}

      <dl className="market-stats">
        {[wti, brent].map((q) => (
          <div key={q.key}>
            <dt>{q.name}</dt>
            <dd>
              {dollar(q.price)}
              <span className={`stat-delta ${q.changePct && q.changePct > 0 ? 'up' : q.changePct && q.changePct < 0 ? 'down' : ''}`}>
                {q.change != null && `${q.change > 0 ? '▲' : q.change < 0 ? '▼' : ''} ${pct(q.changePct)}`}
              </span>
            </dd>
          </div>
        ))}
        <div>
          <dt>원/달러</dt>
          <dd>
            {fx(usdkrw.price)}
            <span className={`stat-delta ${usdkrw.changePct && usdkrw.changePct > 0 ? 'up' : usdkrw.changePct && usdkrw.changePct < 0 ? 'down' : ''}`}>
              {usdkrw.change != null && `${usdkrw.change > 0 ? '▲' : usdkrw.change < 0 ? '▼' : ''} ${pct(usdkrw.changePct)}`}
            </span>
          </dd>
        </div>
        {dom && (
          <>
            <div>
              <dt>전국 평균 휘발유</dt>
              <dd>
                {dom.gasoline ? won(Math.round(dom.gasoline)) : '-'}
                {vsNational(ours?.gasoline.ours, dom.gasoline) && <span className="stat-note">우리 {vsNational(ours?.gasoline.ours, dom.gasoline)}</span>}
              </dd>
            </div>
            <div>
              <dt>전국 평균 경유</dt>
              <dd>
                {dom.diesel ? won(Math.round(dom.diesel)) : '-'}
                {vsNational(ours?.diesel.ours, dom.diesel) && <span className="stat-note">우리 {vsNational(ours?.diesel.ours, dom.diesel)}</span>}
              </dd>
            </div>
          </>
        )}
      </dl>

      <div className="seg" role="group" aria-label="그래프">
        <button type="button" aria-pressed={view === 'crude'} onClick={() => setView('crude')} disabled={!crude}>
          원화 환산 원유
        </button>
        <button type="button" aria-pressed={view === 'oil'} onClick={() => setView('oil')}>
          WTI·브렌트
        </button>
        <button type="button" aria-pressed={view === 'fx'} onClick={() => setView('fx')}>
          원/달러
        </button>
      </div>
      <LineChart dates={chart.dates} series={chart.series} label={chart.label} formatY={chart.formatY} formatX={md} />
      <p className="fine">
        WTI·브렌트는 뉴욕상업거래소 선물 근월물, 환율은 시장 환율입니다
        {Object.values(market.quotes).some((q) => q.source === 'fred') && ' (일부는 미국 연준 자료라 며칠 늦을 수 있음)'}. 한국 정유사가 주로 들여오는 두바이유는
        무료로 받을 수 있는 출처가 없어 비슷하게 움직이는 브렌트로 계산했습니다. 1배럴은 158.987L.
      </p>
    </section>
  );
}
