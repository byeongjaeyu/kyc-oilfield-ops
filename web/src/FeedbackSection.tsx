import { useCallback, useEffect, useState } from 'react';
import { DonateCard } from './Donate';
import { md } from './data';
import { supabase, type Profile } from './supabase';

export type FeedbackKind = 'bug' | 'idea' | 'etc';
export type FeedbackStatus = 'new' | 'in_progress' | 'done' | 'wontfix';

export interface Feedback {
  id: string;
  user_email: string;
  station_id: string | null;
  kind: FeedbackKind;
  body: string;
  page: string;
  user_agent: string;
  status: FeedbackStatus;
  reply: string;
  replied_at: string | null;
  created_at: string;
}

export const KIND_KO: Record<FeedbackKind, string> = { bug: '버그', idea: '기능 제안', etc: '기타' };
export const FB_STATUS_KO: Record<FeedbackStatus, string> = { new: '접수', in_progress: '처리 중', done: '반영함', wontfix: '보류' };

/** 회원이 사이트 관리자에게 보내는 버그·의견 + 받은 답변 */
export function FeedbackSection({
  me,
  stationId,
  page,
  embedded,
}: {
  me: Profile;
  stationId: string | null;
  page: string;
  embedded?: boolean;
}) {
  const [mine, setMine] = useState<Feedback[]>([]);
  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    const { data } = await supabase.from('feedback').select('*').eq('user_id', me.id).order('created_at', { ascending: false }).limit(30);
    setMine((data as Feedback[]) ?? []);
  }, [me.id]);
  useEffect(() => {
    reload();
  }, [reload]);

  const form = (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!body.trim()) return;
        setBusy(true);
        setError('');
        setMsg('');
        const { error } = await supabase.from('feedback').insert({
          kind,
          body: body.trim(),
          station_id: stationId,
          page,
          user_agent: navigator.userAgent.slice(0, 300),
        });
        setBusy(false);
        if (error) return setError(error.message);
        setBody('');
        setMsg('보냈습니다. 답변이 오면 아래 목록에 표시됩니다.');
        reload();
      }}
    >
      <div className="seg" role="radiogroup" aria-label="종류">
        {(Object.keys(KIND_KO) as FeedbackKind[]).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} aria-pressed={kind === k} onClick={() => setKind(k)}>
            {KIND_KO[k]}
          </button>
        ))}
      </div>
      <label>
        내용
        <textarea
          rows={5}
          required
          maxLength={5000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={kind === 'bug' ? '어느 화면에서 무엇을 눌렀더니 어떻게 됐는지 적어 주세요.' : '있었으면 하는 기능이나 불편한 점을 적어 주세요.'}
        />
      </label>
      <p className="fine">사이트 관리자(개발자)에게만 보입니다. 주유소 데이터는 함께 보내지 않습니다.</p>
      <div className="form-actions">
        <button type="submit" className="primary" disabled={busy || !body.trim()}>
          {busy ? '보내는 중…' : '보내기'}
        </button>
      </div>
      {msg && <p className="info-note">{msg}</p>}
      {error && (
        <p className="change-note" role="alert">
          {error}
        </p>
      )}
    </form>
  );

  const list = mine.length > 0 && (
    <>
      <h3 className="sub-head">보낸 의견</h3>
      <ul className="fb-list">
        {mine.map((f) => (
          <li key={f.id}>
            <p className="insp-meta">
              {KIND_KO[f.kind]}, {md(f.created_at)} <span className={`fb-status fb-${f.status}`}>{FB_STATUS_KO[f.status]}</span>
            </p>
            <p className="fb-body">{f.body}</p>
            {f.reply && (
              <p className="fb-reply">
                <b>답변</b> {f.reply}
              </p>
            )}
          </li>
        ))}
      </ul>
    </>
  );

  if (embedded) {
    return (
      <>
        {form}
        {list}
      </>
    );
  }
  return (
    <section className="block" aria-labelledby="fb-title">
      <header className="block-head">
        <h2 id="fb-title">의견·버그 보내기</h2>
        <p className="block-meta">사이트를 만든 개발자가 읽고 고칩니다</p>
      </header>
      {form}
      {list}
      <DonateCard />
    </section>
  );
}
