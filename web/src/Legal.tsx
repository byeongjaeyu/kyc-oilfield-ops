import { useSiteConfig } from './Donate';

export type LegalKind = 'privacy' | 'terms';
export const LEGAL_DATE = '2026년 11월 18일';

/** 개인정보처리방침·이용약관 (#privacy, #terms). 로그인 없이도 열림 */
export function LegalPage({ kind, onBack }: { kind: LegalKind; onBack: () => void }) {
  const site = useSiteConfig();
  const contact = site?.contact_email ? (
    <a href={`mailto:${site.contact_email}`}>{site.contact_email}</a>
  ) : (
    '로그인 뒤 계정 메뉴의 "의견·버그 보내기"'
  );
  return (
    <div className="legal">
      <header className="legal-head">
        <button type="button" className="link-btn" onClick={onBack}>
          ‹ 돌아가기
        </button>
        <nav aria-label="문서">
          <a href="#privacy" aria-current={kind === 'privacy' ? 'page' : undefined}>
            개인정보처리방침
          </a>
          <a href="#terms" aria-current={kind === 'terms' ? 'page' : undefined}>
            이용약관
          </a>
        </nav>
      </header>
      <article className="legal-body">{kind === 'privacy' ? <Privacy contact={contact} /> : <Terms contact={contact} />}</article>
    </div>
  );
}

function Privacy({ contact }: { contact: React.ReactNode }) {
  return (
    <>
      <h1>개인정보처리방침</h1>
      <p className="legal-meta">시행일 {LEGAL_DATE}</p>
      <p>
        만땅(이하 "서비스")은 개인이 운영하는 주유소 운영 장부 서비스입니다. 서비스를 쓰는 데 꼭 필요한 정보만 받고, 광고나 다른 목적으로 쓰거나 팔지 않습니다.
      </p>

      <h2>1. 받는 정보와 쓰는 곳</h2>
      <table>
        <thead>
          <tr>
            <th>언제</th>
            <th>받는 정보</th>
            <th>쓰는 곳</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>가입·로그인</td>
            <td>이메일, 비밀번호(암호화해 저장, 운영자도 볼 수 없음), 이름(선택)</td>
            <td>본인 확인, 로그인, 초대·알림 메일</td>
          </tr>
          <tr>
            <td>주유소 등록 신청</td>
            <td>주유소 이름·주소·오피넷 번호, 사업자등록번호, 사업자등록증 사본</td>
            <td>실제 주유소 운영자인지 확인 (심사)</td>
          </tr>
          <tr>
            <td>서비스 이용</td>
            <td>직접 넣은 장부 내용 (매입·마감·재고·거래처·계약·입금 내역, 검사 결과지 등)</td>
            <td>장부 기능 제공, 같은 주유소 구성원과 권한에 따른 공유</td>
          </tr>
          <tr>
            <td>자동으로</td>
            <td>마지막 요청 시각, 기기 종류(휴대폰·PC), 로그인·메일 발송 기록</td>
            <td>부정 이용 방지, 장애 확인</td>
          </tr>
        </tbody>
      </table>

      <h2>2. 보관 기간</h2>
      <ul>
        <li>계정과 장부 내용: 탈퇴(삭제 요청)할 때까지. 요청하면 지체 없이 지웁니다.</li>
        <li>사업자등록증 사본: 심사가 끝나고 30일이 지나면 자동으로 지웁니다.</li>
        <li>주유소가 삭제되면 그 주유소의 장부 내용도 같이 지워집니다.</li>
      </ul>

      <h2>3. 다른 곳에 주는 경우</h2>
      <p>
        제3자에게 팔거나 넘기지 않습니다. 같은 주유소의 구성원(예: 임대인과 임차인)은 그 주유소 관리자가 정한 권한만큼 서로의 장부를 봅니다. 법령에 따라 수사기관 등이 요구하는 경우는 예외입니다.
      </p>

      <h2>4. 처리를 맡기는 곳 (국외 이전 포함)</h2>
      <table>
        <thead>
          <tr>
            <th>업체</th>
            <th>맡기는 일</th>
            <th>위치</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Supabase</td>
            <td>계정·장부·파일 저장, 로그인 메일 발송</td>
            <td>미국(오리건)</td>
          </tr>
          <tr>
            <td>GitHub</td>
            <td>웹 화면 호스팅, 가격·시세 자동 수집 실행</td>
            <td>미국</td>
          </tr>
          <tr>
            <td>Google (Gemini API)</td>
            <td>바코드 상품명 찾기, 계약서에서 만기·인상 조건 읽기 (그 기능을 누를 때만 해당 바코드·계약서 파일 전송), 업계 소식 요약(공개 기사만)</td>
            <td>미국</td>
          </tr>
          <tr>
            <td>Telegram</td>
            <td>알림 메시지 전송 (주유소에서 알림을 켠 경우만)</td>
            <td>해외</td>
          </tr>
        </tbody>
      </table>
      <p>전송은 모두 암호화된 연결(HTTPS)로 이뤄지며, 서비스를 쓰는 동안 보관됩니다.</p>

      <h2>5. 공공 데이터</h2>
      <p>주변 주유소 가격은 한국석유공사 오피넷, 토지 실거래가는 국토교통부 공공데이터를 씁니다. 이 정보는 개인정보가 아닌 공개 정보입니다.</p>

      <h2>6. 지키는 방법</h2>
      <ul>
        <li>주유소마다 데이터를 나눠, 권한이 있는 사람만 볼 수 있게 데이터베이스에서 막습니다.</li>
        <li>파일은 공개 주소 없이 비공개 저장소에 두고, 권한 있는 사람에게만 잠깐 열리는 주소를 줍니다.</li>
        <li>관리용 키는 서버에만 두고 화면 코드에는 넣지 않습니다.</li>
        <li>광고·추적 쿠키를 쓰지 않습니다. 로그인 유지를 위해 브라우저 저장소만 씁니다.</li>
      </ul>

      <h2>7. 이용자의 권리</h2>
      <p>
        내 정보를 보거나 고치거나 지우거나 처리를 멈춰 달라고 언제든 요청할 수 있습니다. 장부 내용은 화면에서 직접 고치고 지울 수 있고, 계정 삭제(탈퇴)는 아래 연락처로 요청하면 처리합니다.
      </p>

      <h2>8. 개인정보 보호책임자·연락처</h2>
      <p>책임자: 서비스 운영자(개인). 연락: {contact}</p>
      <p>
        개인정보 침해 신고·상담은 개인정보침해신고센터(국번 없이 118, privacy.kisa.or.kr), 개인정보분쟁조정위원회(1833-6972, kopico.go.kr)에도 할 수 있습니다.
      </p>

      <h2>9. 바뀌면</h2>
      <p>이 방침을 바꾸면 시행 7일 전에 서비스 화면에 알립니다.</p>
    </>
  );
}

function Terms({ contact }: { contact: React.ReactNode }) {
  return (
    <>
      <h1>이용약관</h1>
      <p className="legal-meta">시행일 {LEGAL_DATE}</p>

      <h2>1. 서비스</h2>
      <p>
        만땅은 주유소 운영자를 위한 장부·알림 서비스로, 개인이 운영하는 <b>베타(시험) 서비스</b>입니다. 지금은 무료이며, 유료로 바꾸게 되면 미리 알리고 동의를 받은 사람에게만 요금을 받습니다.
      </p>

      <h2>2. 가입과 주유소 등록</h2>
      <ul>
        <li>이메일 인증으로 가입하고, 주유소는 사업자등록증 확인을 거쳐 등록됩니다.</li>
        <li>다른 사람 명의나 실제로 운영하지 않는 주유소로 신청하면 안 됩니다. 확인되면 등록을 취소합니다.</li>
        <li>계정과 비밀번호 관리는 본인 책임입니다.</li>
      </ul>

      <h2>3. 정보는 참고용입니다</h2>
      <ul>
        <li>주변 가격, 추천 판매가, 마진·순이익 계산, 재고 예측, 법정 검사 기한, 업계 소식 요약은 공공 데이터와 입력값을 바탕으로 자동 계산한 <b>참고 정보</b>입니다.</li>
        <li>가격 결정, 세금 신고, 법정 검사, 계약 같은 판단은 이용자가 직접 확인하고 책임집니다. 서비스는 계산 결과에 따른 손해를 책임지지 않습니다.</li>
        <li>공공 데이터가 늦거나 틀릴 수 있습니다.</li>
      </ul>

      <h2>4. 데이터</h2>
      <ul>
        <li>입력한 장부 내용의 권리는 이용자에게 있습니다. 운영자는 서비스 제공과 장애 확인 외에는 보지 않습니다.</li>
        <li>베타 서비스라 오류로 데이터가 사라질 수 있으니, 중요한 기록은 따로 보관해 주세요.</li>
      </ul>

      <h2>5. 하면 안 되는 것</h2>
      <ul>
        <li>남의 계정이나 주유소 데이터에 접근하려는 시도</li>
        <li>자동 프로그램으로 대량 요청을 보내거나 서비스를 방해하는 행위</li>
        <li>허위 서류 제출, 불법적인 목적의 이용</li>
      </ul>
      <p>이런 경우 경고 없이 이용을 막을 수 있습니다. 서버 비용 때문에 검색·AI 기능에는 하루 사용 한도가 있습니다.</p>

      <h2>6. 바뀌거나 멈출 때</h2>
      <p>기능은 바뀔 수 있고, 운영상 서비스를 멈출 수도 있습니다. 서비스를 끝낼 때는 30일 전에 알리고, 그동안 데이터를 받아 갈 수 있게 돕습니다.</p>

      <h2>7. 문의</h2>
      <p>{contact}</p>
    </>
  );
}
