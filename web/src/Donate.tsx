import { useEffect, useState } from 'react';
import { supabase } from './supabase';

export interface SiteConfig {
  donate_url: string;
  donate_note: string;
  contact_email: string;
}

let cache: Promise<SiteConfig | null> | null = null;
/** 사이트 설정 (한 번만 불러옴) */
export function loadSiteConfig(fresh = false) {
  if (!cache || fresh)
    cache = Promise.resolve(supabase.from('site_config').select('donate_url,donate_note,contact_email').maybeSingle()).then(({ data }) => (data as SiteConfig) ?? null);
  return cache;
}
export function useSiteConfig() {
  const [c, setC] = useState<SiteConfig | null>(null);
  useEffect(() => {
    loadSiteConfig().then(setC);
  }, []);
  return c;
}

/** 의견 보내기 화면 아래 커피 후원 카드. 링크가 없으면 아무것도 안 그림 */
export function DonateCard() {
  const c = useSiteConfig();
  if (!c?.donate_url) return null;
  return (
    <aside className="donate" aria-labelledby="donate-title">
      <span className="donate-cup" aria-hidden>
        ☕
      </span>
      <div>
        <h3 id="donate-title">개발자에게 커피 한 잔</h3>
        <p>{c.donate_note || '이 사이트는 개발자 한 명이 무료로 만들고 고칩니다. 쓸 만했다면 커피 한 잔으로 응원해 주세요. 후원과 상관없이 모든 기능은 똑같이 쓸 수 있습니다.'}</p>
      </div>
      <a className="primary" href={c.donate_url} target="_blank" rel="noopener noreferrer">
        커피 후원하기
      </a>
    </aside>
  );
}

/** 사이트 관리 화면: 후원 링크 설정 */
export function DonateSettings({ onSaved }: { onSaved: (m: string) => void }) {
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [contact, setContact] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    loadSiteConfig(true).then((c) => {
      setUrl(c?.donate_url ?? '');
      setNote(c?.donate_note ?? '');
      setContact(c?.contact_email ?? '');
    });
  }, []);
  const mailOk = contact.trim() === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.trim());
  const ok = (url === '' || /^https:\/\/\S{4,300}$/.test(url.trim())) && mailOk;
  return (
    <form
      className="form boxed"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ok) return;
        setBusy(true);
        setErr('');
        const { error } = await supabase.from('site_config').update({ donate_url: url.trim(), donate_note: note.trim(), contact_email: contact.trim() }).eq('id', true);
        setBusy(false);
        if (error) return setErr(error.message);
        await loadSiteConfig(true);
        onSaved('저장했습니다.');
      }}
    >
      <div className="cf-grid">
        <label className="cf-field wide">
          <span>후원 링크 (https 로 시작)</span>
          <input type="url" placeholder="예: 토스 송금 링크, 카카오페이 송금 코드 링크" value={url} onChange={(e) => setUrl(e.target.value)} />
          <span className="field-hint">비워 두면 후원 버튼이 어디에도 나오지 않습니다.</span>
        </label>
        <label className="cf-field wide">
          <span>안내 문구 (선택)</span>
          <input maxLength={200} placeholder="비우면 기본 문구" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <label className="cf-field wide">
          <span>운영자 연락 이메일</span>
          <input type="email" placeholder="개인정보처리방침·이용약관의 문의처" value={contact} onChange={(e) => setContact(e.target.value)} />
          <span className="field-hint">개인정보처리방침의 보호책임자 연락처로 공개됩니다. 비우면 "의견·버그 보내기"로 안내합니다. 개인 메일 대신 이 사이트용 메일을 권합니다.</span>
        </label>
      </div>
      {!ok && <p className="change-note">{mailOk ? 'https:// 로 시작하는 주소를 넣어 주세요.' : '이메일 주소 형식을 확인해 주세요.'}</p>}
      {err && <p className="change-note">{err}</p>}
      <div className="form-actions">
        <button type="submit" className="primary" disabled={busy || !ok}>
          저장
        </button>
        {url.trim() && ok && (
          <a className="more" href={url.trim()} target="_blank" rel="noopener noreferrer">
            링크 열어 보기
          </a>
        )}
      </div>
    </form>
  );
}
