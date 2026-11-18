import { useState } from 'react';
import { startDemo, supabase } from './supabase';

const FEATURES: Array<[string, string]> = [
  ['가격 비교', '반경 5km 경쟁 주유소의 휘발유·경유 가격을 4시간마다 모아 우리 순위와 가격을 바꿨을 때의 마진을 보여 줍니다.'],
  ['유류 장부', '매입 단가로 L당 마진을 보고, 탱크 재고로 며칠 치가 남았는지와 발주할 때를 알려 줍니다. 일 마감과 카드 입금도 맞춰 봅니다.'],
  ['소모품', '요소수·불스원샷 같은 소모품을 바코드나 카운터 화면으로 기록하고, 떨어지면 거래처별 주문서를 만듭니다.'],
  ['법정 검사', '토양오염도·누출·소방 점검과 보험 만기를 기한 전에 알리고 결과지를 보관합니다.'],
  ['업계 소식·부지 가치', '정책·규제 소식을 주마다 요약하고, 주변 토지 실거래가를 정리합니다.'],
  ['임대 중이라면', '계약서에서 만기·인상일을 뽑아 일정으로 만들고, 임대료 입금을 맞춰 봅니다. 임대인과 임차인이 장부를 나눠 볼 수 있습니다.'],
];

/** 로그인 전 첫 화면 — 주유소 캐노피 아래 로그인 */
export function Landing({ preview = false }: { preview?: boolean }) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'login' | 'apply'>('login');
  /** 로그인 방법: 비밀번호, 또는 메일 링크 (처음이거나 비밀번호를 잊었을 때) */
  const [how, setHow] = useState<'password' | 'link'>('password');
  const [password, setPassword] = useState('');
  const byPassword = mode === 'login' && how === 'password';

  return (
    <div className="landing">
      <header className="canopy">
        <div className="canopy-inner">
          <p className="canopy-name">만땅</p>
          <p className="canopy-sub">
            주유소 운영 장부 <span className="beta-tag">베타</span>
          </p>
        </div>
      </header>

      <div className="landing-body">
        <section className="landing-intro" aria-labelledby="intro-title">
          <h1 id="intro-title">가격, 마진, 재고, 기한을 한 화면에서</h1>
          <p className="readout">
            주변 주유소 가격과 우리 마진, 기름·소모품 재고, 법정 검사 기한을 매일 챙겨 드립니다. 놓치면 안 되는 날짜와 떨어진 재고는 텔레그램으로 먼저
            알려 드립니다. 임대 중인 주유소라면 임대인과 임차인이 장부를 나눠 볼 수도 있습니다.
          </p>
          <div className="demo-cta">
            <button type="button" className="primary" onClick={() => !preview && startDemo()}>
              로그인 없이 둘러보기
            </button>
            <span>예시 주유소의 예시 데이터로 모든 메뉴를 눌러 볼 수 있습니다. 바꾼 내용은 저장되지 않습니다.</span>
          </div>
          <dl className="feature-list">
            {FEATURES.map(([name, body]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{body}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="login-card" aria-labelledby="login-title">
          <div className="seg login-mode" role="tablist" aria-label="무엇을 할지">
            <button type="button" role="tab" aria-selected={mode === 'login'} aria-pressed={mode === 'login'} onClick={() => setMode('login')}>
              로그인
            </button>
            <button type="button" role="tab" aria-selected={mode === 'apply'} aria-pressed={mode === 'apply'} onClick={() => setMode('apply')}>
              새 주유소 등록
            </button>
          </div>

          <h2 id="login-title">{mode === 'login' ? '로그인' : '새 주유소 등록 신청'}</h2>
          {mode === 'apply' && (
            <>
              <p className="readout">아직 이 사이트에 없는 주유소라면 아래 순서로 신청하세요. 신청은 임대인·임차인·직접 운영하는 사장님 누구나 할 수 있습니다.</p>
              <ol className="apply-steps">
                <li className="on">
                  <b>이메일 인증</b>
                  <span>아래에 이메일을 넣고 받은 링크를 누릅니다. 들어간 뒤 비밀번호를 만들면 다음부터는 이메일과 비밀번호로 로그인합니다.</span>
                </li>
                <li>
                  <b>주유소와 사업자등록증</b>
                  <span>링크를 누르면 바로 신청서가 열립니다. 오피넷에서 주유소를 고르고 사업자등록증 사진을 올립니다.</span>
                </li>
                <li>
                  <b>사이트 관리자 확인</b>
                  <span>사업자등록증을 확인하고 승인하면, 신청한 분이 그 주유소의 관리자가 됩니다.</span>
                </li>
              </ol>
            </>
          )}

          {byPassword ? (
            <form
              className="form"
              onSubmit={async (e) => {
                e.preventDefault();
                if (preview) return;
                setState('sending');
                setError('');
                const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
                setState('idle');
                if (!error) return;
                setError(
                  /invalid login credentials/i.test(error.message)
                    ? '이메일 또는 비밀번호가 맞지 않습니다. 비밀번호를 만든 적이 없거나 잊었다면 아래에서 이메일 링크로 로그인하세요.'
                    : /email not confirmed/i.test(error.message)
                      ? '아직 이메일 인증을 하지 않았습니다. 아래에서 이메일 링크를 받아 인증해 주세요.'
                      : /rate|too many/i.test(error.message)
                        ? '시도가 너무 많습니다. 잠시 뒤 다시 해 주세요.'
                        : error.message,
                );
              }}
            >
              <label>
                이메일
                <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
              </label>
              <label>
                비밀번호
                <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              </label>
              <button type="submit" className="primary" disabled={state === 'sending'}>
                {state === 'sending' ? '로그인하는 중…' : '로그인'}
              </button>
              {error && (
                <p className="change-note" role="alert">
                  {error}
                </p>
              )}
              <p className="login-alt">
                <span>처음이거나 비밀번호를 잊었나요?</span>
                <button type="button" className="link-btn" onClick={() => (setHow('link'), setError(''), setState('idle'))}>
                  이메일로 로그인 링크 받기
                </button>
              </p>
            </form>
          ) : state === 'sent' ? (
            <>
              <p className="readout">
                <b>{email}</b> 로 {mode === 'apply' ? '인증' : '로그인'} 링크를 보냈습니다. 메일의 링크를 누르면 이 사이트로 돌아와{' '}
                {mode === 'apply' ? '신청서가 바로 열립니다' : '바로 열립니다'}.
              </p>
              <p className="fine">
                메일이 안 오면 스팸함을 확인하고, 몇 분 뒤 다시 보내 보세요. 들어간 뒤 비밀번호를 만들거나 계정 메뉴의 <b>비밀번호 바꾸기</b>로 새로 정하면 다음부터는 메일 없이 로그인합니다.
              </p>
              <button type="button" className="more" onClick={() => setState('idle')}>
                다른 이메일로
              </button>
            </>
          ) : (
            <form
              className="form"
              onSubmit={async (e) => {
                e.preventDefault();
                if (preview) return setState('sent'); // 미리보기: 메일은 보내지 않고 보낸 뒤 화면만
                setState('sending');
                setError('');
                try {
                  if (mode === 'apply') localStorage.setItem('intent:apply', '1');
                  else localStorage.removeItem('intent:apply');
                } catch {
                  /* 저장소 못 쓰는 브라우저: 로그인 뒤 계정 메뉴에서 신청 */
                }
                const { error } = await supabase.auth.signInWithOtp({
                  email: email.trim(),
                  options: { emailRedirectTo: window.location.origin + import.meta.env.BASE_URL },
                });
                if (!error) return setState('sent');
                setState('idle');
                setError(/rate|seconds/i.test(error.message) ? '방금 보냈습니다. 잠시 뒤 다시 시도해 주세요.' : error.message);
              }}
            >
              <label>
                이메일
                <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
              </label>
              <button type="submit" className="primary" disabled={state === 'sending'}>
                {state === 'sending' ? '보내는 중…' : mode === 'apply' ? '인증 링크 받고 신청 시작' : '로그인 링크 받기'}
              </button>
              {mode === 'login' && <p className="fine">받은 메일의 링크를 누르면 로그인됩니다. 들어간 뒤 비밀번호를 만들어 두면 다음부터는 메일이 필요 없습니다.</p>}
              {error && (
                <p className="change-note" role="alert">
                  {error}
                </p>
              )}
              {mode === 'login' && (
                <p className="login-alt">
                  <span>비밀번호가 있나요?</span>
                  <button type="button" className="link-btn" onClick={() => (setHow('password'), setError(''))}>
                    비밀번호로 로그인
                  </button>
                </p>
              )}
            </form>
          )}

          {mode === 'login' ? (
            <div className="login-hint">
              <p>
                <b>처음 쓰는 주유소인가요?</b>
                <span>사이트 관리자의 확인을 받아 주유소를 등록해야 합니다.</span>
              </p>
              <button type="button" className="more" onClick={() => (setMode('apply'), setState('idle'), setError(''))}>
                새 주유소 등록 신청
              </button>
            </div>
          ) : (
            <p className="fine login-foot">
              이미 등록된 주유소에 들어가려면 신청하지 말고, 그 주유소 관리자에게 이 이메일로 초대해 달라고 하세요. 초대받은 뒤 로그인하면 바로 들어갑니다.
            </p>
          )}
        </section>
      </div>
      <footer className="landing-foot">
        <p>
          개인이 무료로 운영하는 베타 서비스입니다. 가격·추천가·마진 계산은 공공 데이터와 입력값으로 낸 참고값이니 중요한 결정은 직접 확인해 주세요. 가입하거나 로그인하면{' '}
          <a href="#terms">이용약관</a>과 <a href="#privacy">개인정보처리방침</a>에 동의하는 것으로 봅니다.
        </p>
        <p className="landing-src">주유소 가격: 한국석유공사 오피넷 · 토지 실거래가: 국토교통부</p>
      </footer>
    </div>
  );
}
