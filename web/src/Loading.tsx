/**
 * 불러오는 중 화면 — 작은 주유기가 자동차에 기름을 넣는 모션
 *  size="page": 화면 가운데 크게 (처음 열 때), "block": 카드 안, "inline": 표·목록 자리
 *  움직임 줄이기 설정이면 멈춘 그림만 보여 줌
 */
export function Loading({ label = '불러오는 중', size = 'block', dark = false }: { label?: string; size?: 'page' | 'block' | 'inline'; dark?: boolean }) {
  return (
    <div className={`loading loading-${size} ${dark ? 'loading-dark' : ''}`} role="status" aria-live="polite">
      <svg className="ld-art" viewBox="0 0 168 104" aria-hidden focusable="false">
        {/* 바닥 */}
        <path className="ld-ground" d="M6 96 H162" />
        {/* 주유기 */}
        <g className="ld-pump">
          <rect x="14" y="22" width="40" height="74" rx="7" className="ld-pump-body" />
          <rect x="14" y="22" width="40" height="10" rx="5" className="ld-pump-cap" />
          <rect x="21" y="38" width="26" height="15" rx="3" className="ld-screen" />
          <rect x="24" y="43" width="20" height="5" rx="1.5" className="ld-screen-fill" />
          {/* 얼굴 */}
          <circle cx="27" cy="66" r="2.6" className="ld-eye" />
          <circle cx="41" cy="66" r="2.6" className="ld-eye" />
          <path d="M29 73 q5 4.5 10 0" className="ld-smile" />
          <circle cx="22.5" cy="72" r="2.4" className="ld-blush" />
          <circle cx="45.5" cy="72" r="2.4" className="ld-blush" />
          {/* 손잡이 걸이 */}
          <path d="M54 46 h5 a3 3 0 0 1 3 3 v10" className="ld-hook" />
        </g>
        {/* 호스: 점선이 흘러가며 기름이 가는 것처럼 */}
        <path className="ld-hose" d="M62 58 C 66 92, 92 92, 100 64" />
        <path className="ld-flow" d="M62 58 C 66 92, 92 92, 100 64" />
        {/* 노즐 */}
        <path className="ld-nozzle" d="M97 66 l5 -9 l8 3 l-3 6 z" />
        {/* 자동차 */}
        <g className="ld-car">
          <path className="ld-car-body" d="M100 82 v-14 c0-5 3-8 8-8 h8 l9-11 c2-2 4-3 7-3 h12 c4 0 7 2 9 6 l6 12 c2 1 3 3 3 6 v12 c0 2-2 4-4 4 h-54 c-2 0-4-2-4-4 z" />
          <path className="ld-car-window" d="M128 52 h9 c2 0 3 1 4 3 l4 9 h-24 z" />
          <rect x="105" y="66" width="7" height="5" rx="1.5" className="ld-cap" />
          <circle cx="115" cy="88" r="8" className="ld-wheel" />
          <circle cx="147" cy="88" r="8" className="ld-wheel" />
          <circle cx="115" cy="88" r="3" className="ld-hub" />
          <circle cx="147" cy="88" r="3" className="ld-hub" />
          <circle cx="156" cy="72" r="2.2" className="ld-light" />
        </g>
        {/* 연료 게이지 E → F */}
        <g className="ld-gauge" transform="translate(132 20)">
          <path d="M-13 0 A13 13 0 0 1 13 0" className="ld-gauge-arc" />
          <text x="-16" y="7" className="ld-gauge-t">E</text>
          <text x="11" y="7" className="ld-gauge-t">F</text>
          <line x1="0" y1="0" x2="0" y2="-10" className="ld-needle" />
          <circle r="2" className="ld-gauge-dot" />
        </g>
      </svg>
      {size !== 'inline' && <p className="ld-label">{label}</p>}
      {size === 'inline' && <span className="sr-only">{label}</span>}
    </div>
  );
}
