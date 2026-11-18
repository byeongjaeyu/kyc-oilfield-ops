import { useMemo, useState } from 'react';
import { md, won } from './data';
import { LineChart, type Series } from './LineChart';
import type { LandLatest } from './types';

// validate_palette.js 통과 색 (가격 그래프와 같은 세트)
const C = { nearby: '#C25E00', gwangsan: '#3B5BAF' };
/** 거래가 이보다 적은 달은 중위값이 튀므로 그래프에서 비움 */
const MIN_N = 3;
const ROWS = 12;

const ym = (d: string) => `${d.slice(2, 4)}.${Number(d.slice(5, 7))}`;
/** 원/㎡ → 원/평 */
const toPyeong = (wonPerM2: number) => Math.round(wonPerM2 * 3.3058);
const manWonLabel = (v: number) => `${Math.round(v / 10_000).toLocaleString('ko-KR')}만원`;
const pyeong = (wonPerM2: number) => Math.round((wonPerM2 * 3.3058) / 10_000).toLocaleString('ko-KR');
const manWon = (man: number) =>
  man >= 10_000 ? `${(man / 10_000).toFixed(man % 10_000 ? 1 : 0)}억` : `${man.toLocaleString('ko-KR')}만`;

export function LandSection({ land }: { land: LandLatest }) {
  const [all, setAll] = useState(false);
  const { recent } = land;
  const region = land.region || '시·군·구';
  const nearbyLabel = land.ourDong ? `${land.ourDong} 주변` : '주변 동';

  const series: Series[] = useMemo(
    () => [
      {
        key: 'nearby',
        name: nearbyLabel,
        color: C.nearby,
        values: land.months.map((m) => (m.nearby.n >= MIN_N && m.nearby.median ? toPyeong(m.nearby.median) : null)),
      },
      {
        key: 'gwangsan',
        name: `${region} 전체`,
        color: C.gwangsan,
        values: land.months.map((m) => (m.gwangsan.n >= MIN_N && m.gwangsan.median ? toPyeong(m.gwangsan.median) : null)),
      },
    ],
    [land, region, nearbyLabel],
  );
  const hasChart = land.months.filter((m) => m.gwangsan.n >= MIN_N).length >= 2;
  const rows = all ? land.notable : land.notable.slice(0, ROWS);

  return (
    <section className="block" aria-labelledby="land-title">
      <header className="block-head">
        <h2 id="land-title">부지 가치</h2>
        <p className="block-meta">국토부 토지 실거래가, {md(land.generatedAt)} 갱신</p>
      </header>

      {land.warnings.map((w) => (
        <p key={w} className="change-note">
          {w}
        </p>
      ))}

      <div className="readouts">
        <p className="readout">
          {recent.nearby.median != null ? (
            <>
              <b className="price-big">평당 {pyeong(recent.nearby.median)}만원</b> 최근 {recent.months}개월 {nearbyLabel}에서 대지·잡종지 등{' '}
              {recent.nearby.n}건이 거래됐고, ㎡당 중위 단가는 {won(recent.nearby.median)}입니다.
            </>
          ) : (
            <>최근 {recent.months}개월 {nearbyLabel}에서 단가를 비교할 만한 거래(대지·잡종지 등)가 없었습니다.</>
          )}{' '}
          {recent.gwangsan.median != null && (
            <>
              {region} 전체는 {recent.gwangsan.n}건, ㎡당 {won(recent.gwangsan.median)}입니다.
            </>
          )}{' '}
          {land.ourDong}은 {recent.ourDong.n}건입니다.
        </p>
      </div>

      {hasChart ? (
        <LineChart
          dates={land.months.map((m) => `${m.ym}-01`)}
          series={series}
          formatX={ym}
          formatY={manWonLabel}
          formatTick={(v) => `${Math.round(v / 10_000).toLocaleString('ko-KR')}만`}
          label={`월별 토지 평당 중위 단가: ${nearbyLabel}, ${region} 전체`}
        />
      ) : (
        <p className="note">월별 단가 그래프는 거래가 두 달 이상 쌓이면 나옵니다.</p>
      )}
      <p className="fine">
        평당 중위 단가(만원). 대지·잡종지·주유소용지·공장용지·창고용지만 넣고 지분 거래와 33㎡ 미만 필지는 뺐습니다. 또 거래가 {MIN_N}건 미만인 달은 비웠습니다. {nearbyLabel}:{' '}
        {land.nearbyDongs.join(', ')}.
      </p>

      {land.notable.length > 0 && (
        <>
          <h3 className="sub-head">눈여겨볼 거래</h3>
          <p className="fine">최근 6개월, {region}의 주유소용지와 {nearbyLabel}의 대지·잡종지·공장·창고용지</p>
          <div className="table-scroll">
            <table className="price-table land-table">
              <thead>
                <tr>
                  <th scope="col">계약일</th>
                  <th scope="col">위치</th>
                  <th scope="col">지목 / 용도지역</th>
                  <th scope="col" className="num">면적</th>
                  <th scope="col" className="num">금액</th>
                  <th scope="col" className="num">평당</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} className={t.dong === land.ourDong ? 'mine' : undefined}>
                    <td className="num-l">{md(t.date)}</td>
                    <th scope="row">
                      {t.dong} <span className="brand-name">{t.jibun}</span>
                    </th>
                    <td>
                      {t.jimok}
                      <span className="brand-name">{t.landUse}</span>
                      {t.share && <span className="brand-name">지분</span>}
                    </td>
                    <td className="num">{Math.round(t.areaM2).toLocaleString('ko-KR')}㎡</td>
                    <td className="num">{manWon(t.amountMan)}</td>
                    <td className="num">{t.share ? '-' : `${pyeong(t.wonPerM2)}만`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {land.notable.length > ROWS && (
            <button type="button" className="more" onClick={() => setAll((v) => !v)} aria-expanded={all}>
              {all ? '접기' : `${land.notable.length}건 모두 보기`}
            </button>
          )}
        </>
      )}

      <h3 className="sub-head">개발·도시계획 소식</h3>
      {land.news.headline && <p className="headline small">{land.news.headline}</p>}
      {land.news.items.length === 0 ? (
        <p className="note">이번 주에는 부지 가치에 관련된 기사가 없었습니다.</p>
      ) : (
        <ol className="items">
          {land.news.items.map((it, i) => (
            <li key={it.url || i} className={`item imp-${it.importance}`}>
              <span className="lamp" title={['', '참고', '권역 영향', '직접 영향'][it.importance]} />
              <div className="item-body">
                {it.url ? (
                  <a href={it.url} target="_blank" rel="noreferrer noopener" className="item-title">
                    {it.title}
                  </a>
                ) : (
                  <span className="item-title">{it.title}</span>
                )}
                {it.summary && <p className="item-summary">{it.summary}</p>}
                {it.impact && (
                  <p className="item-impact">
                    <b>우리 부지</b>
                    {it.impact}
                  </p>
                )}
                <p className="item-src">
                  <span>{it.source}</span>
                  <time dateTime={it.publishedAt}>{md(it.publishedAt)}</time>
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
