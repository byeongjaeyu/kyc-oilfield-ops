import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { md, won } from './data';

export interface Series {
  key: string;
  name: string;
  color: string;
  dash?: string;
  values: Array<number | null>;
}

const PAD = { top: 16, right: 84, bottom: 28, left: 52 };

/** 같은 단위(원/L)의 시계열 몇 개를 한 축에. 끝점 직접 라벨 + 호버 십자선 */
export function LineChart({
  dates,
  series,
  label,
  formatX = md,
  formatY = won,
  formatTick = (v: number) => v.toLocaleString('ko-KR'),
}: {
  dates: string[];
  series: Series[];
  label: string;
  /** x 라벨·툴팁 날짜 표기 (기본 11.14) */
  formatX?: (d: string) => string;
  /** 툴팁 값 표기 (기본 1,234원) */
  formatY?: (v: number) => string;
  /** y 눈금 표기 */
  formatTick?: (v: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  // 화면 폭 그대로 좌표계를 잡아 모바일에서도 글자가 작아지지 않게
  const frameRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(300, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = W < 520 ? 220 : 260;

  const { x, y, ticks } = useMemo(() => {
    const all = series.flatMap((s) => s.values).filter((v): v is number => v != null);
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    const step = niceStep((hi - lo) / 4 || 10);
    const yMin = Math.max(lo >= 0 ? 0 : -Infinity, Math.floor((lo - step * 0.3) / step) * step);
    const yMax = Math.ceil((hi + step * 0.3) / step) * step;
    const ticks: number[] = [];
    for (let t = yMin; t <= yMax + 1e-9; t += step) ticks.push(t);
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    return {
      x: (i: number) => PAD.left + (dates.length === 1 ? innerW / 2 : (i / (dates.length - 1)) * innerW),
      y: (v: number) => PAD.top + innerH - ((v - yMin) / (yMax - yMin)) * innerH,
      ticks,
    };
  }, [dates, series, W, H]);

  const path = (vals: Array<number | null>) => {
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  // 끝점 라벨이 겹치지 않게 최소 간격 확보
  const endLabels = useMemo(() => {
    const items = series
      .map((s) => {
        const i = lastIndex(s.values);
        return i < 0 ? null : { s, i, y: y(s.values[i] as number) };
      })
      .filter((v): v is NonNullable<typeof v> => v != null)
      .sort((a, b) => a.y - b.y);
    for (let k = 1; k < items.length; k++) items[k].y = Math.max(items[k].y, items[k - 1].y + 16);
    return items;
  }, [series, y]);

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * (W - PAD.left - PAD.right);
    const i = dates.length === 1 ? 0 : Math.round((px / (W - PAD.left - PAD.right)) * (dates.length - 1));
    setHover(Math.max(0, Math.min(dates.length - 1, i)));
  };

  const xTickIdx = dates.length <= 1 ? [0] : [0, Math.floor((dates.length - 1) / 2), dates.length - 1];

  return (
    <figure className="chart">
      <ul className="chart-legend">
        {series.map((s) => (
          <li key={s.key}>
            <svg width="22" height="10" aria-hidden>
              <line x1="1" y1="5" x2="21" y2="5" stroke={s.color} strokeWidth="2.5" strokeDasharray={s.dash} strokeLinecap="round" />
            </svg>
            {s.name}
          </li>
        ))}
      </ul>
      <div className="chart-frame" ref={frameRef}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="grid" />
              <text x={PAD.left - 8} y={y(t) + 4} className="tick" textAnchor="end">
                {formatTick(t)}
              </text>
            </g>
          ))}
          {xTickIdx.map((i) => (
            <text key={i} x={x(i)} y={H - 8} className="tick" textAnchor="middle">
              {formatX(dates[i])}
            </text>
          ))}

          {series.map((s) => (
            <path key={s.key} d={path(s.values)} fill="none" stroke={s.color} strokeWidth="2" strokeDasharray={s.dash} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {series.map((s) => {
            const i = lastIndex(s.values);
            return i < 0 ? null : (
              <circle key={s.key} cx={x(i)} cy={y(s.values[i] as number)} r="4" fill={s.color} stroke="var(--concrete)" strokeWidth="2" />
            );
          })}
          {endLabels.map(({ s, i, y: ly }) => (
            <text key={s.key} x={x(i) + 10} y={ly + 4} className="end-label">
              {s.name}
            </text>
          ))}

          {hover != null && (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={H - PAD.bottom} className="crosshair" />
              {series.map((s) =>
                s.values[hover] == null ? null : (
                  <circle key={s.key} cx={x(hover)} cy={y(s.values[hover] as number)} r="4.5" fill={s.color} stroke="var(--concrete)" strokeWidth="2" />
                ),
              )}
            </g>
          )}
          <rect
            x={PAD.left}
            y={PAD.top}
            width={W - PAD.left - PAD.right}
            height={H - PAD.top - PAD.bottom}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
        {hover != null && (
          <div
            className="chart-tip"
            style={{ left: `${(x(hover) / W) * 100}%`, transform: `translateX(${x(hover) > W * 0.6 ? '-105%' : '5%'})` }}
          >
            <strong>{formatX(dates[hover])}</strong>
            {series.map((s) => (
              <span key={s.key}>
                <i style={{ background: s.color }} />
                {s.name}
                <b>{s.values[hover] == null ? '-' : formatY(s.values[hover] as number)}</b>
              </span>
            ))}
          </div>
        )}
      </div>
    </figure>
  );
}

function lastIndex(vals: Array<number | null>) {
  for (let i = vals.length - 1; i >= 0; i--) if (vals[i] != null) return i;
  return -1;
}

function niceStep(raw: number) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}
