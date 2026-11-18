import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** 기능 안내 한 단계: target 이 없으면 화면 가운데 카드 */
export interface TourStep {
  id: string;
  title: string;
  body: ReactNode;
  /** 짚을 요소 (CSS 선택자). 화면에 없으면 가운데 카드로 보여줌 */
  target?: string;
  /** 이 단계에서 열어 둘 메뉴 */
  tab?: string;
}

type Box = { top: number; left: number; width: number; height: number };
const PAD = 6;
const GAP = 12;

/**
 * 코치마크: 짚을 요소 둘레만 밝히고 나머지는 어둡게, 옆에 설명 카드.
 * ←→ 로 넘기고 Esc 로 닫음. 카드 밖(어두운 곳)을 눌러도 닫히지 않음 — 실수로 끝나지 않게.
 */
export function Tour({ steps, onStep, onClose }: { steps: TourStep[]; onStep?: (s: TourStep) => void; onClose: () => void }) {
  const [i, setI] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [card, setCard] = useState<{ top: number; left: number; place: 'below' | 'above' | 'center' }>({ top: 0, left: 0, place: 'center' });
  const cardRef = useRef<HTMLDivElement>(null);
  const step = steps[i];
  const last = i === steps.length - 1;

  const measure = useCallback(() => {
    const el = step.target ? (document.querySelector(step.target) as HTMLElement | null) : null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cw = Math.min(360, vw - 24);
    const ch = cardRef.current?.offsetHeight ?? 220;
    if (!el || el.offsetParent === null) {
      setBox(null);
      setCard({ top: Math.max(12, (vh - ch) / 2), left: (vw - cw) / 2, place: 'center' });
      return;
    }
    const r = el.getBoundingClientRect();
    const b = { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
    setBox(b);
    const left = Math.min(Math.max(12, r.left + r.width / 2 - cw / 2), vw - cw - 12);
    const below = b.top + b.height + GAP;
    if (below + ch <= vh - 12) setCard({ top: below, left, place: 'below' });
    else if (b.top - GAP - ch >= 12) setCard({ top: b.top - GAP - ch, left, place: 'above' });
    else setCard({ top: Math.max(12, vh - ch - 12), left, place: 'below' }); // 요소가 화면만큼 크면 아래쪽에 겹쳐서
  }, [step]);

  // 단계가 바뀌면: 메뉴 열기 → 그려진 뒤 요소를 화면 가운데로 → 위치 재기
  useLayoutEffect(() => {
    onStep?.(step);
    let raf = 0;
    const t = window.setTimeout(() => {
      const el = step.target ? (document.querySelector(step.target) as HTMLElement | null) : null;
      if (el && el.offsetParent !== null) {
        const r = el.getBoundingClientRect();
        const fits = r.height < window.innerHeight * 0.55;
        if (r.top < 70 || r.bottom > window.innerHeight - 40 || fits)
          el.scrollIntoView({ block: fits ? 'center' : 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      }
      const tick = () => {
        measure();
        raf = requestAnimationFrame(tick);
      };
      tick();
      window.setTimeout(() => cancelAnimationFrame(raf), 700); // 부드러운 스크롤 동안 따라감
    }, 60);
    cardRef.current?.focus();
    return () => {
      window.clearTimeout(t);
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  useEffect(() => {
    const on = () => measure();
    window.addEventListener('resize', on);
    window.addEventListener('scroll', on, true);
    return () => {
      window.removeEventListener('resize', on);
      window.removeEventListener('scroll', on, true);
    };
  }, [measure]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') setI((x) => Math.min(x + 1, steps.length - 1));
      else if (e.key === 'ArrowLeft') setI((x) => Math.max(x - 1, 0));
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose, steps.length]);

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-body">
      {box ? (
        <div className="tour-spot" style={{ top: box.top, left: box.left, width: box.width, height: box.height }} aria-hidden />
      ) : (
        <div className="tour-dim" aria-hidden />
      )}
      <div ref={cardRef} className={`tour-card ${card.place}`} style={{ top: card.top, left: card.left }} tabIndex={-1}>
        <p className="tour-count">
          {i + 1} / {steps.length}
        </p>
        <h2 id="tour-title" className="tour-title">
          {step.title}
        </h2>
        <div id="tour-body" className="tour-body">
          {step.body}
        </div>
        <div className="tour-progress" aria-hidden>
          {steps.map((s, k) => (
            <span key={s.id} className={k === i ? 'on' : k < i ? 'done' : ''} />
          ))}
        </div>
        <div className="tour-actions">
          {!last && (
            <button type="button" className="link-btn" onClick={onClose}>
              건너뛰기
            </button>
          )}
          <span className="tour-nav">
            {i > 0 && (
              <button type="button" className="more" onClick={() => setI(i - 1)}>
                이전
              </button>
            )}
            <button type="button" className="primary" onClick={() => (last ? onClose() : setI(i + 1))}>
              {last ? '시작하기' : '다음'}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

/** 주유소 대시보드 안내 단계 — 이 사람이 볼 수 있는 메뉴만 */
export function stationSteps({
  stationName,
  tabs,
  canPrices,
  multiRole,
  isManager,
}: {
  stationName: string;
  tabs: string[];
  canPrices: boolean;
  multiRole: boolean;
  isManager: boolean;
}): TourStep[] {
  const has = (t: string) => tabs.includes(t);
  const out: TourStep[] = [
    {
      id: 'hello',
      title: `${stationName} 둘러보기`,
      body: (
        <p>
          주유소 운영에 필요한 가격, 마진, 재고, 기한을 한곳에서 챙기는 장부입니다. 메뉴마다 무엇을 하는지 차례로 짚어 드릴게요. 1분이면 끝나고, 나중에 오른쪽 위 계정 메뉴의
          <b> 사용 안내</b>에서 다시 볼 수 있습니다.
        </p>
      ),
    },
    {
      id: 'role',
      target: '[data-tour="role"]',
      title: multiRole ? '역할 바꾸기' : '내 역할',
      body: multiRole ? (
        <p>이 주유소에서 임대인이면서 임차인이기도 합니다. 여기서 바꾸면 그 역할로 보이는 메뉴와 고칠 수 있는 범위로 바뀝니다.</p>
      ) : (
        <p>이 주유소에서 내 역할입니다. 어떤 메뉴를 보고 고칠 수 있는지는 주유소 관리자가 역할별로 정합니다.</p>
      ),
    },
  ];
  if (canPrices) {
    out.push(
      {
        id: 'board',
        tab: 'prices',
        target: '.pylon .board',
        title: '우리 주유소 가격판',
        body: (
          <p>
            오피넷에 올라간 우리 휘발유·경유 가격을 간판처럼 보여줍니다. 아래 줄은 반경 5km 주유소 가운데 우리가 몇 번째로 싼지입니다. 4시간마다
            새로 받아옵니다.
          </p>
        ),
      },
      {
        id: 'market',
        tab: 'prices',
        target: '.pylon .ticker',
        title: '국제유가·환율',
        body: (
          <p>
            WTI·브렌트 원유 가격과 원/달러 환율, 그리고 원유값을 원화 L당으로 바꾼 값입니다. 국내 기름값은 국제유가를 보통 2~3주 늦게 따라가서 가격을
            정할 때 미리 보기 좋습니다.
          </p>
        ),
      },
    );
  }
  const tabSteps: Array<[string, string, ReactNode]> = [
    ['prices', '가격 비교', <p key="p">반경 5km 주유소의 휘발유·경유 가격과 우리 순위, 평균·최저가와의 차이, 가격이 움직인 그래프를 봅니다.</p>],
    ['land', '부지 가치', <p key="l">국토교통부 토지 실거래가로 주변 동네 땅 거래와 가격 흐름을 보고, 주변 개발·도시계획 소식을 매주 모아 둡니다.</p>],
    ['policy', '정책 요약', <p key="po">전기차 충전 전환, 환경 규제, 폐업 지원처럼 주유소 업계 정책·뉴스를 매주 요약합니다. 지난 주 요약도 골라 볼 수 있습니다.</p>],
    [
      'inspection',
      '법정 검사',
      <p key="i">
        토양오염도·누출·소방 점검과 보험 만기처럼 기한이 있는 일을 남은 날짜 순으로 보여줍니다. 결과지를 올려 보관하고, 기한이 다가오면 텔레그램으로
        알려 드립니다.
      </p>,
    ],
    [
      'contract',
      '계약 일정',
      <p key="c">
        임대차 계약서를 PDF나 사진으로 올리면 AI가 만기, 갱신 통지 마감, 임대료 인상일을 뽑아 일정으로 만듭니다. 내용을 확인하고 확정하면 휴대폰 캘린더에도
        넣을 수 있습니다.
      </p>,
    ],
    [
      'payment',
      '입금 확인',
      <p key="pa">
        계약서의 임대료와 지급일로 달마다 받을 금액을 계산하고, 통장 내역 엑셀이나 은행 입금 문자와 맞춰 봅니다. 밀린 달이 있으면 알려 주고 보낼 문자 초안도
        만들어 줍니다.
      </p>,
    ],
    [
      'supplies',
      '소모품',
      <p key="s">
        요소수·불스원샷·장갑 같은 소모품 재고를 관리합니다. 바코드를 찍어 판매·입고를 기록하고, 정해 둔 수량 아래로 떨어지면 거래처별 주문서를 만들어
        줍니다. 받은 물건은 거래처별로 달마다 모여 월말 정산 때 맞춰 볼 수 있고, 주변 주유소 요소수 가격과 재고도 같이 봅니다.
      </p>,
    ],
    [
      'fuel',
      '유류 장부',
      <p key="f">
        운영하는 사람의 장부입니다. 매입 단가로 L당 마진을 보고, 판매가를 바꾸면 순위와 마진이 어떻게 달라지는지 미리 계산합니다. 탱크 재고로 며칠 치가
        남았는지와 발주할 때를 알려 주고, 하루 판매량과 카드 입금을 맞춰 보는 일 마감도 여기서 합니다. 임대 중인 주유소라면 임차인이 공유를 켜야 임대인도 봅니다.
      </p>,
    ],
  ];
  for (const t of tabs) {
    const st = tabSteps.find(([id]) => id === t);
    if (st) out.push({ id: `tab-${t}`, tab: t, target: `#tab-${t}`, title: st[1], body: st[2] });
  }
  if (isManager) {
    out.push({
      id: 'settings',
      tab: 'settings',
      target: '[data-tour="settings"]',
      title: '주유소 설정',
      body: (
        <p>
          이 주유소 관리자에게만 보입니다. 임대인·임차인을 이메일로 초대하고, 역할마다 볼 수 있는 메뉴와 고칠 수 있는 메뉴를 정하고, 텔레그램 알림과 은행
          입금 문자 연결을 설정합니다. 관리자 자리를 다른 사람에게 넘길 수도 있습니다.
        </p>
      ),
    });
  }
  out.push(
    {
      id: 'account',
      target: '[data-tour="account"]',
      title: '계정 메뉴',
      body: (
        <p>
          의견·버그 보내기, 다른 주유소 등록 신청, 이 안내 다시 보기, 로그아웃이 여기 있습니다. 불편한 점을 보내면 사이트를 만든 개발자가 직접 읽고
          고칩니다.
        </p>
      ),
    },
    {
      id: 'done',
      title: '다 둘러봤습니다',
      body: <p>처음 보던 메뉴로 돌아갑니다. 궁금한 점은 계정 메뉴의 의견·버그 보내기로 남겨 주세요.</p>,
    },
  );
  return out;
}
