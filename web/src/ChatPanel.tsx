import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { isDemo, supabase, type Profile } from './supabase';

/** 자유게시판 — 화면 오른쪽. 로그인한 사장님 누구나, 대화명으로만 보임 */
interface Msg {
  id: number | string;
  user_id: string | null;
  nickname: string;
  is_admin: boolean;
  body: string;
  created_at: string;
}

const PAGE = 80;
const MAX = 500;
const NICK = /^[가-힣A-Za-z0-9_.-]{2,12}$/;

// ── 열림·안 읽은 수 (상단 바 버튼과 패널이 같이 씀) ──
const store = {
  open: (() => {
    try {
      return localStorage.getItem('chat:open') === '1';
    } catch {
      return false;
    }
  })(),
  unread: 0,
  subs: new Set<() => void>(),
};
const emit = () => store.subs.forEach((f) => f());
const subscribe = (f: () => void) => (store.subs.add(f), () => store.subs.delete(f));
export const setChatOpen = (v: boolean) => {
  store.open = v;
  if (v) store.unread = 0;
  try {
    localStorage.setItem('chat:open', v ? '1' : '0');
  } catch {
    /* 저장소 없음 */
  }
  emit();
};
const setUnread = (n: number) => {
  store.unread = n;
  emit();
};
export const useChatOpen = () => useSyncExternalStore(subscribe, () => store.open);
const useUnread = () => useSyncExternalStore(subscribe, () => store.unread);

/** 상단 바 버튼 */
export function ChatButton() {
  const open = useChatOpen();
  const unread = useUnread();
  return (
    <button
      type="button"
      className="tb-btn chat-btn"
      aria-pressed={open}
      aria-label={`자유게시판${unread ? `, 새 글 ${unread}개` : ''}`}
      onClick={() => setChatOpen(!open)}
    >
      <svg viewBox="0 0 20 20" aria-hidden width="18" height="18">
        <path fill="currentColor" d="M3 4.5A2.5 2.5 0 015.5 2h9A2.5 2.5 0 0117 4.5v7a2.5 2.5 0 01-2.5 2.5H9l-4 3.5V14h0A2 2 0 013 12V4.5z" />
      </svg>
      <span className="tb-btn-label">게시판</span>
      {unread > 0 && !open && <span className="chat-dot">{unread > 99 ? '99+' : unread}</span>}
    </button>
  );
}

const seenKey = (uid: string) => `chat:seen:${uid}`;
const getSeen = (uid: string) => {
  try {
    return localStorage.getItem(seenKey(uid)) ?? '';
  } catch {
    return '';
  }
};
const putSeen = (uid: string, at: string) => {
  try {
    localStorage.setItem(seenKey(uid), at);
  } catch {
    /* 저장소 없음 */
  }
};

function when(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const hm = d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  const day = (x: Date) => x.toDateString();
  if (day(d) === day(now)) return hm;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (day(d) === day(y)) return `어제 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** 패널 (로그인한 화면이면 늘 붙어 있고, 닫혀 있어도 새 글 수를 셈) */
export function ChatPanel({ me }: { me: Profile }) {
  const open = useChatOpen();
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [more, setMore] = useState(false);
  const [nick, setNick] = useState<string | null | undefined>(undefined);
  const [editNick, setEditNick] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const listRef = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const openRef = useRef(open);
  openRef.current = open;

  // 처음: 대화명, 최근 글, 안 읽은 수
  useEffect(() => {
    let off = false;
    supabase
      .from('chat_profiles')
      .select('nickname')
      .eq('user_id', me.id)
      .maybeSingle()
      .then(({ data }) => !off && setNick((data as { nickname: string } | null)?.nickname ?? null));
    supabase
      .from('chat_messages')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(PAGE)
      .then(({ data }) => {
        if (off) return;
        const list = ((data as Msg[]) ?? []).reverse();
        setMsgs(list);
        setMore(list.length === PAGE);
        const seen = getSeen(me.id);
        if (!openRef.current) setUnread(list.filter((m) => m.user_id !== me.id && (!seen || m.created_at > seen)).length);
        else if (list.length) putSeen(me.id, list[list.length - 1].created_at);
      });
    return () => {
      off = true;
    };
  }, [me.id]);

  // 실시간: 새 글·지운 글
  useEffect(() => {
    const ch = supabase
      .channel('chat-board')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, (p) => {
        const m = p.new as Msg;
        setMsgs((cur) => (cur && !cur.some((x) => x.id === m.id) ? [...cur, m] : cur));
        if (m.user_id !== me.id) {
          if (openRef.current) putSeen(me.id, m.created_at);
          else setUnread(store.unread + 1);
        }
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'chat_messages' }, (p) => {
        const id = (p.old as { id?: number }).id;
        setMsgs((cur) => cur?.filter((x) => x.id !== id) ?? cur);
      })
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [me.id]);

  // 열면 읽음 처리, 넓은 화면에서는 본문 옆에 붙임
  useEffect(() => {
    if (open && msgs?.length) putSeen(me.id, msgs[msgs.length - 1].created_at);
    document.body.classList.toggle('chat-open', open);
    return () => document.body.classList.remove('chat-open');
  }, [open, msgs, me.id]);

  // 상단 바(데모 띠 포함) 바로 아래에서 시작
  const [top, setTop] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => setTop(Math.max(0, Math.round(document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 61)));
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  // 맨 아래를 보고 있었으면 새 글에 따라 내려감
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs, open]);

  const older = useCallback(async () => {
    if (!msgs?.length) return;
    const el = listRef.current;
    const before = el?.scrollHeight ?? 0;
    const { data } = await supabase.from('chat_messages').select('*').lt('created_at', msgs[0].created_at).order('created_at', { ascending: false }).limit(PAGE);
    const list = ((data as Msg[]) ?? []).reverse();
    setMore(list.length === PAGE);
    stick.current = false;
    setMsgs((cur) => [...list, ...(cur ?? [])]);
    requestAnimationFrame(() => el && (el.scrollTop = el.scrollHeight - before));
  }, [msgs]);

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setErr('');
    const { data, error } = await supabase.from('chat_messages').insert({ body }).select().single();
    setBusy(false);
    if (error) return setErr(error.message);
    setText('');
    stick.current = true;
    const m = data as Msg;
    setMsgs((cur) => (cur && !cur.some((x) => x.id === m.id) ? [...cur, m] : cur));
  };

  const remove = async (m: Msg) => {
    if (!confirm(m.user_id === me.id ? '이 글을 지울까요?' : `${m.nickname}님의 글을 내릴까요? (운영자 권한)`)) return;
    const { error } = await supabase.from('chat_messages').delete().eq('id', m.id);
    if (error) return setErr(error.message);
    setMsgs((cur) => cur?.filter((x) => x.id !== m.id) ?? cur);
  };
  const report = async (m: Msg) => {
    if (!confirm(`${m.nickname}님의 글을 신고할까요? 세 명이 신고하면 자동으로 내려갑니다.`)) return;
    const { error } = await supabase.from('chat_reports').insert({ message_id: m.id });
    setNote(error ? (/duplicate/i.test(error.message) ? '이미 신고한 글입니다.' : error.message) : '신고했습니다. 세 명이 신고하면 자동으로 내려갑니다.');
    setTimeout(() => setNote(''), 4000);
  };

  if (!open) return null;
  return createPortal(
    <aside className="chat-panel" aria-labelledby="chat-title" style={{ '--chat-top': top != null ? `${top}px` : undefined } as React.CSSProperties}>
      <header className="chat-head">
        <div>
          <h2 id="chat-title">자유게시판</h2>
          <p>만땅을 쓰는 사장님들끼리 나누는 이야기</p>
        </div>
        <button type="button" className="link-btn" aria-label="게시판 닫기" onClick={() => setChatOpen(false)}>
          닫기
        </button>
      </header>

      {nick === undefined || msgs === null ? (
        <p className="chat-empty">불러오는 중…</p>
      ) : nick === null || editNick ? (
        <NickForm
          current={nick}
          onDone={(n) => {
            setNick(n);
            setEditNick(false);
          }}
          onCancel={nick ? () => setEditNick(false) : undefined}
        />
      ) : (
        <>
          <ol
            className="chat-list"
            ref={listRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
          >
            {more && (
              <li className="chat-more">
                <button type="button" className="link-btn" onClick={older}>
                  이전 글 더 보기
                </button>
              </li>
            )}
            {msgs.length === 0 && <li className="chat-empty">아직 글이 없습니다. 첫 인사를 남겨 보세요.</li>}
            {msgs.map((m) => {
              const mine = m.user_id === me.id;
              return (
                <li key={m.id} className={`chat-msg${mine ? ' is-mine' : ''}`}>
                  <p className="chat-meta">
                    <b>{m.nickname || '알 수 없음'}</b>
                    {m.is_admin && <span className="chat-admin">운영자</span>}
                    <time dateTime={m.created_at}>{when(m.created_at)}</time>
                    <span className="chat-acts">
                      {(mine || me.is_site_admin) && (
                        <button type="button" onClick={() => remove(m)}>
                          {mine ? '지우기' : '내리기'}
                        </button>
                      )}
                      {!mine && !isDemo() && (
                        <button type="button" onClick={() => report(m)}>
                          신고
                        </button>
                      )}
                    </span>
                  </p>
                  <p className="chat-body">{m.body}</p>
                </li>
              );
            })}
          </ol>

          <form
            className="chat-form"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            {(err || note) && (
              <p className={err ? 'chat-err' : 'chat-note'} role={err ? 'alert' : 'status'}>
                {err || note}
              </p>
            )}
            <textarea
              rows={2}
              maxLength={MAX}
              placeholder={`${nick} 이름으로 글 남기기`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // 컴퓨터에서는 Enter 로 보내고 Shift+Enter 로 줄바꿈, 휴대폰은 버튼으로
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && matchMedia('(pointer: fine)').matches) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <div className="chat-form-row">
              <button type="button" className="link-btn" onClick={() => setEditNick(true)}>
                대화명: {nick}
              </button>
              <span className="chat-count">
                {text.length}/{MAX}
              </span>
              <button type="submit" className="primary" disabled={busy || !text.trim()}>
                보내기
              </button>
            </div>
            <p className="chat-rule">상호·연락처·실명 같은 개인정보는 올리지 마세요. 욕설·광고는 운영자가 내립니다.</p>
          </form>
        </>
      )}
    </aside>,
    document.body,
  );
}

function NickForm({ current, onDone, onCancel }: { current: string | null; onDone: (n: string) => void; onCancel?: () => void }) {
  const [v, setV] = useState(current ?? '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = NICK.test(v.trim());
  return (
    <form
      className="chat-nick"
      onSubmit={async (e) => {
        e.preventDefault();
        const n = v.trim();
        if (!NICK.test(n)) return;
        setBusy(true);
        setErr('');
        const { data: u } = await supabase.auth.getUser();
        const { error } = await supabase.from('chat_profiles').upsert({ user_id: u.user?.id, nickname: n }, { onConflict: 'user_id' });
        setBusy(false);
        if (error) return setErr(/duplicate|unique/i.test(error.message) ? '이미 다른 분이 쓰는 대화명입니다.' : error.message);
        onDone(n);
      }}
    >
      <h3>{current ? '대화명 바꾸기' : '대화명 정하기'}</h3>
      <p className="fine">게시판에는 이메일이나 주유소 이름 없이 대화명만 보입니다. 2~12자, 한글·영문·숫자.</p>
      <input autoFocus value={v} maxLength={12} placeholder="예: 셀프사장, 경유왕" onChange={(e) => setV(e.target.value)} aria-label="대화명" />
      {err && <p className="chat-err">{err}</p>}
      <div className="form-actions">
        <button type="submit" className="primary" disabled={busy || !ok}>
          {current ? '바꾸기' : '시작하기'}
        </button>
        {onCancel && (
          <button type="button" className="more" onClick={onCancel}>
            취소
          </button>
        )}
      </div>
    </form>
  );
}
