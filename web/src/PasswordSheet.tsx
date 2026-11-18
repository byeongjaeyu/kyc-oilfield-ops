import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { isDemo, supabase } from './supabase';

const MIN = 8;
const laterKey = (uid: string) => `pw:later:${uid}`;

/** 비밀번호를 만든 적이 있는지 (만들 때 user_metadata.has_password 를 같이 남김) */
export function useHasPassword() {
  const [state, setState] = useState<{ uid: string; email: string; has: boolean } | null>(null);
  useEffect(() => {
    const read = (u: { id: string; email?: string; user_metadata?: Record<string, unknown> } | null | undefined) =>
      setState(u ? { uid: u.id, email: u.email ?? '', has: !!u.user_metadata?.has_password } : null);
    supabase.auth.getSession().then(({ data }) => read(data.session?.user));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => read(s?.user));
    return () => data.subscription.unsubscribe();
  }, []);
  return state;
}

/**
 * 이메일 링크로 들어온 사람에게 비밀번호 만들기를 권함 (화면 아래 카드, 안내 투어보다 아래)
 * open 이 true 면 계정 메뉴에서 연 것: 비밀번호가 있어도 바꾸기로 보임
 */
export function PasswordSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pw = useHasPassword();
  const [later, setLater] = useState(false);
  /** 한 번 띄운 카드는 저장한 뒤 '만들었습니다' 안내까지 닫지 않음 */
  const [active, setActive] = useState(false);
  const prompt = !!pw && !pw.has && !later;
  useEffect(() => {
    if (prompt || open) setActive(true);
  }, [prompt, open]);
  useEffect(() => {
    if (!pw) return;
    try {
      setLater(sessionStorage.getItem(laterKey(pw.uid)) === '1');
    } catch {
      /* 저장소 없음 */
    }
  }, [pw]);
  if (!pw || isDemo()) return null;
  if (!open && !prompt && !active) return null;

  const dismiss = () => {
    if (!open) {
      try {
        sessionStorage.setItem(laterKey(pw.uid), '1');
      } catch {
        /* 저장소 없음 */
      }
      setLater(true);
    }
    setActive(false);
    onClose();
  };
  return createPortal(
    <section className="pw-sheet" role="dialog" aria-modal="false" aria-labelledby="pw-title">
      <PasswordForm email={pw.email} change={pw.has} onDone={dismiss} onLater={dismiss} />
    </section>,
    document.body,
  );
}

function PasswordForm({ email, change: changeAtOpen, onDone, onLater }: { email: string; change: boolean; onDone: () => void; onLater: () => void }) {
  // 저장하면 has_password 가 바로 켜지므로 연 순간의 값으로 문구를 고정
  const [change] = useState(changeAtOpen);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const short = a.length > 0 && a.length < MIN;
  const differ = b.length > 0 && a !== b;

  if (done) {
    return (
      <div className="pw-done">
        <h2 id="pw-title">{change ? '비밀번호를 바꿨습니다' : '비밀번호를 만들었습니다'}</h2>
        <p className="fine">다음부터는 로그인 화면에 이메일과 이 비밀번호를 넣으면 바로 들어옵니다. 메일을 기다릴 필요가 없습니다.</p>
        <button type="button" className="primary" onClick={onDone}>
          확인
        </button>
      </div>
    );
  }
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (a.length < MIN || a !== b) return;
        setBusy(true);
        setError('');
        const { error } = await supabase.auth.updateUser({ password: a, data: { has_password: true } });
        setBusy(false);
        if (!error) return setDone(true);
        setError(
          /different from the old/i.test(error.message)
            ? '지금 쓰는 비밀번호와 같습니다. 다른 비밀번호를 넣어 주세요.'
            : /weak|pwned|leaked/i.test(error.message)
              ? '너무 쉬운 비밀번호입니다. 다른 사이트에서 쓰지 않는 더 긴 비밀번호로 해 주세요.'
              : /reauth/i.test(error.message)
                ? '보안을 위해 이메일 링크로 다시 로그인한 뒤 바꿔 주세요.'
                : error.message,
        );
      }}
    >
      <h2 id="pw-title">{change ? '비밀번호 바꾸기' : '비밀번호를 만들어 두세요'}</h2>
      {!change && <p className="fine">다음부터 메일 링크를 기다리지 않고 이메일과 비밀번호로 바로 로그인합니다.</p>}
      {/* 비밀번호 관리자가 어느 계정 비밀번호인지 알도록 */}
      <input type="email" autoComplete="username" value={email} readOnly hidden />
      <label className="cf-field">
        <span>새 비밀번호 ({MIN}자 이상)</span>
        <span className="pw-input">
          <input type={show ? 'text' : 'password'} autoComplete="new-password" required minLength={MIN} value={a} onChange={(e) => setA(e.target.value)} aria-invalid={short} />
          <button type="button" className="link-btn" onClick={() => setShow(!show)} aria-pressed={show}>
            {show ? '숨기기' : '보기'}
          </button>
        </span>
      </label>
      <label className="cf-field">
        <span>한 번 더</span>
        <input type={show ? 'text' : 'password'} autoComplete="new-password" required value={b} onChange={(e) => setB(e.target.value)} aria-invalid={differ} />
      </label>
      {(short || differ) && <p className="fine alert-text">{short ? `${MIN}자 이상으로 만들어 주세요.` : '두 비밀번호가 다릅니다.'}</p>}
      {error && (
        <p className="change-note" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="primary" disabled={busy || a.length < MIN || a !== b}>
          {busy ? '저장하는 중…' : change ? '비밀번호 바꾸기' : '비밀번호 만들기'}
        </button>
        <button type="button" className="link-btn" onClick={onLater}>
          {change ? '닫기' : '나중에'}
        </button>
      </div>
    </form>
  );
}
