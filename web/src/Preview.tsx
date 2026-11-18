import { useState, type ReactNode } from 'react';
import { Landing } from './Landing';
import { Onboarding } from './Onboarding';
import type { Profile, Station } from './supabase';

type Screen = 'landing' | 'none' | 'pending' | 'rejected' | 'dashboard';

const SCREENS: Array<{ id: Screen; name: string; who: string; what: ReactNode }> = [
  {
    id: 'landing',
    name: '로그인 전',
    who: '사이트 주소로 처음 들어온 사람',
    what: (
      <>
        서비스 소개와 로그인 칸이 보입니다. 비밀번호 없이 이메일로 받은 링크를 눌러 들어옵니다. 미리보기에서는 메일을 보내지 않고 <b>보낸 뒤 화면</b>만
        보여줍니다.
      </>
    ),
  },
  {
    id: 'none',
    name: '주유소 없음',
    who: '로그인했지만 들어갈 주유소가 없는 사람',
    what: (
      <>
        이미 등록된 주유소면 그 주유소 관리자에게 초대를 받고, 처음이면 여기서 등록을 신청합니다. 오피넷 검색은 실제로 동작하고, <b>등록 신청</b>을 눌러도
        저장되지 않습니다.
      </>
    ),
  },
  {
    id: 'pending',
    name: '심사 중',
    who: '신청을 마치고 승인을 기다리는 사람',
    what: (
      <>
        사이트 관리 화면에서 사업자등록증을 확인하고 승인하면, 이 사람이 그 주유소의 관리자가 되고 이 화면이 대시보드로 바뀝니다. 승인 전에는 신청을 취소할
        수 있습니다.
      </>
    ),
  },
  {
    id: 'rejected',
    name: '반려됨',
    who: '신청이 반려된 사람',
    what: <>반려할 때 적은 사유가 그대로 보이고, 사업자등록증을 다시 올린 뒤 다시 신청할 수 있습니다.</>,
  },
  {
    id: 'dashboard',
    name: '첫 대시보드',
    who: '승인되거나 초대받아 처음 주유소에 들어온 사람',
    what: (
      <>
        처음 들어오면 메뉴마다 무엇을 하는지 짚어 주는 <b>기능 안내</b>가 한 번 자동으로 뜹니다. 그 사람이 볼 수 있는 메뉴만 짚고, 관리자에게는 주유소 설정도
        짚습니다. 나중에는 계정 메뉴의 <b>사용 안내</b>로 다시 볼 수 있습니다.
      </>
    ),
  },
];

const sample = (me: Profile, over: Partial<Station>): Station => ({
  id: `preview-${over.status}`,
  name: '예시 주유소',
  address: '예시시 예시구 예시로 1',
  jibun_address: '',
  opinet_id: null,
  brand: 'SK에너지',
  lawd_cd: null,
  dong: '',
  biz_no: '1234567890',
  biz_doc_path: 'preview/doc.jpg',
  biz_doc_name: '사업자등록증.jpg',
  applicant_role: 'tenant',
  operation: 'leased',
  applicant_email: me.email,
  applied_by: me.id,
  status: 'pending',
  review_note: '',
  reviewed_at: null,
  is_demo: false,
  telegram_chat_id: '',
  created_at: new Date().toISOString(),
  ...over,
});

/** 사이트 관리자 전용: 새로 온 사람이 보는 화면을 상태별로 그대로 보기 (저장·전송 없음) */
export function Preview({
  me,
  frame,
  onClose,
  onTour,
}: {
  me: Profile;
  /** 주유소 밖 화면 틀 (꺼진 간판 + 책상) */
  frame: (children: ReactNode) => ReactNode;
  onClose: () => void;
  /** 데모 주유소로 가서 기능 안내 시작. 데모 주유소 구성원이 아니면 없음 */
  onTour?: () => void;
}) {
  const [screen, setScreen] = useState<Screen>('landing');
  const cur = SCREENS.find((s) => s.id === screen)!;
  const newcomer: Profile = { ...me, name: '', email: 'new-user@example.com', is_site_admin: false };

  const body =
    screen === 'landing' ? (
      <Landing key="landing" preview />
    ) : screen === 'dashboard' ? (
      frame(
        <section className="block">
          <header className="block-head">
            <h2>첫 대시보드 기능 안내</h2>
          </header>
          <p className="readout">
            안내는 실제 대시보드 위에 겹쳐서 나옵니다. 데모 주유소로 이동해 같은 안내를 처음부터 띄웁니다. 데모 주유소에서 역할(임대인·임차인)을 바꿔 다시 보면
            역할마다 짚는 메뉴가 어떻게 달라지는지도 볼 수 있습니다.
          </p>
          {onTour ? (
            <button type="button" className="primary" onClick={onTour}>
              데모 주유소에서 안내 시작
            </button>
          ) : (
            <p className="change-note">데모 주유소 구성원이 아니라 안내를 띄울 수 없습니다.</p>
          )}
        </section>,
      )
    ) : (
      frame(
        <Onboarding
          key={screen}
          preview
          me={newcomer}
          hasStations={false}
          applications={
            screen === 'pending'
              ? [sample(me, { status: 'pending' })]
              : screen === 'rejected'
                ? [sample(me, { status: 'rejected', biz_doc_path: null, biz_doc_name: null, review_note: '사업자등록증 글씨가 흐려 번호를 확인하지 못했습니다' })]
                : []
          }
          onChanged={() => undefined}
          onDone={() => undefined}
        />,
      )
    );

  return (
    <>
      <div className="preview-bar" role="region" aria-label="미리보기 조작">
        <div className="preview-inner">
          <div className="preview-head">
            <p className="preview-title">새 사용자 화면 미리보기</p>
            <button type="button" className="tb-btn on-dark" onClick={onClose}>
              닫기
            </button>
          </div>
          <div className="seg seg-sm seg-dark" role="group" aria-label="볼 화면">
            {SCREENS.map((s) => (
              <button key={s.id} type="button" aria-pressed={s.id === screen} onClick={() => setScreen(s.id)}>
                {s.name}
              </button>
            ))}
          </div>
          <p className="preview-note">
            <b>{cur.who}</b>에게 보이는 화면입니다. {cur.what}
          </p>
        </div>
      </div>
      {body}
    </>
  );
}
