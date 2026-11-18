import { useEffect, useMemo, useState } from 'react';
import { ago, fullTime } from './AdminActivity';
import { Loading } from './Loading';
import { supabase } from './supabase';

interface Member {
  station_id: string;
  station_name: string;
  station_status: string;
  operation: 'self' | 'leased';
  is_demo: boolean;
  user_id: string;
  email: string;
  role: 'owner' | 'tenant';
  is_manager: boolean;
  joined_at: string;
  last_sign_in_at: string | null;
  last_request_at: string | null;
}
interface Pending {
  kind: 'invite' | 'application' | 'no_station';
  station_id: string | null;
  station_name: string | null;
  email: string;
  role: 'owner' | 'tenant' | null;
  is_manager: boolean;
  since: string;
  by_email: string;
  note: string;
}
interface Mail {
  at: string;
  email: string;
  kind: 'login_link' | 'signup_confirm' | 'invite' | 'email_change';
  logged_in_at: string | null;
  stations: string | null;
}

const MAIL_KO: Record<Mail['kind'], string> = { login_link: '로그인 링크', signup_confirm: '첫 가입 확인', invite: '초대', email_change: '이메일 변경' };
const PENDING_KO: Record<Pending['kind'], string> = { invite: '초대 받고 아직 안 들어옴', application: '주유소 등록 승인 대기', no_station: '가입했지만 주유소 없음' };
const roleKo = (r: string | null, op?: string) => (r === 'tenant' ? '임차인' : r === 'owner' ? (op === 'self' ? '운영자' : '임대인') : '');
const STATUS_KO: Record<string, string> = { approved: '운영 중', pending: '심사 중', rejected: '반려', suspended: '정지' };

/** 사이트 관리: 모든 주유소의 가입자 · 가입 대기 · 메일 발송 기록 */
export function AdminMembers() {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [mails, setMails] = useState<Mail[]>([]);
  const [error, setError] = useState('');
  const [station, setStation] = useState('');
  const [q, setQ] = useState('');
  const [view, setView] = useState<'members' | 'pending' | 'mail'>('members');

  useEffect(() => {
    Promise.all([supabase.rpc('admin_members'), supabase.rpc('admin_pending'), supabase.rpc('admin_mail_log', { days: 30 })]).then(([m, p, l]) => {
      const err = m.error ?? p.error ?? l.error;
      if (err) setError(err.message);
      setMembers((m.data as Member[]) ?? []);
      setPending((p.data as Pending[]) ?? []);
      setMails((l.data as Mail[]) ?? []);
    });
  }, []);

  const stations = useMemo(() => {
    const map = new Map<string, { name: string; status: string; demo: boolean }>();
    for (const m of members ?? []) if (!map.has(m.station_id)) map.set(m.station_id, { name: m.station_name, status: m.station_status, demo: m.is_demo });
    for (const p of pending) if (p.station_id && !map.has(p.station_id)) map.set(p.station_id, { name: p.station_name ?? '', status: 'pending', demo: false });
    return [...map.entries()].sort((a, b) => Number(a[1].demo) - Number(b[1].demo) || a[1].name.localeCompare(b[1].name));
  }, [members, pending]);

  const match = (email: string, sid: string | null, stationNames = '') =>
    (!station || sid === station || (!sid && stationNames.includes(stations.find(([id]) => id === station)?.[1].name ?? '\u0000'))) &&
    (!q.trim() || email.toLowerCase().includes(q.trim().toLowerCase()));

  if (!members) return <Loading />;

  const mShown = members.filter((m) => match(m.email, m.station_id));
  const pShown = pending.filter((p) => match(p.email, p.station_id));
  const lShown = mails.filter((l) => match(l.email, null, l.stations ?? ''));
  const people = new Set(members.map((m) => m.user_id)).size;
  const week = mails.filter((l) => Date.now() - Date.parse(l.at) < 7 * 86_400_000);
  const unused = week.filter((l) => !l.logged_in_at).length;

  // 주유소별로 묶기
  const groups = new Map<string, Member[]>();
  for (const m of mShown) groups.set(m.station_id, [...(groups.get(m.station_id) ?? []), m]);

  return (
    <>
      {error && (
        <p className="change-note" role="alert">
          {error}
        </p>
      )}

      <dl className="sim-out close-sum act-sum">
        <div>
          <dt>가입자</dt>
          <dd>
            <b>{people}명</b>
            <span className="sim-was">{stations.filter(([, s]) => s.status === 'approved').length}개 주유소</span>
          </dd>
        </div>
        <div>
          <dt>가입 대기</dt>
          <dd>
            <b>{pending.length}건</b>
            <span className="sim-was">승인 대기 {pending.filter((p) => p.kind === 'application').length}건</span>
          </dd>
        </div>
        <div>
          <dt>최근 7일 메일</dt>
          <dd>
            <b>{week.length}통</b>
            <span className="sim-was">{unused ? `${unused}통은 아직 로그인 안 함` : '모두 로그인함'}</span>
          </dd>
        </div>
      </dl>

      <div className="mem-filter">
        <select aria-label="주유소" value={station} onChange={(e) => setStation(e.target.value)}>
          <option value="">모든 주유소</option>
          {stations.map(([id, s]) => (
            <option key={id} value={id}>
              {s.name}
              {s.demo ? ' (데모)' : s.status !== 'approved' ? ` (${STATUS_KO[s.status] ?? s.status})` : ''}
            </option>
          ))}
        </select>
        <input type="search" placeholder="이메일 찾기" aria-label="이메일 찾기" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="seg" role="tablist" aria-label="보기">
        {(
          [
            ['members', `가입자 ${new Set(mShown.map((m) => m.user_id)).size}`],
            ['pending', `가입 대기 ${pShown.length}`],
            ['mail', `메일 기록 ${lShown.length}`],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={view === id} aria-pressed={view === id} onClick={() => setView(id)}>
            {label}
          </button>
        ))}
      </div>

      {view === 'members' &&
        (mShown.length === 0 ? (
          <p className="note">조건에 맞는 가입자가 없습니다.</p>
        ) : (
          [...groups.entries()].map(([sid, list]) => (
            <section key={sid} className="mem-group" aria-label={list[0].station_name}>
              <h4>
                {list[0].station_name}
                <span className="brand-name">
                  {list[0].is_demo ? '데모' : (STATUS_KO[list[0].station_status] ?? list[0].station_status)} · {list[0].operation === 'self' ? '직접 운영' : '임대 중'} ·{' '}
                  {new Set(list.map((m) => m.user_id)).size}명
                </span>
              </h4>
              <div className="table-scroll">
                <table className="price-table act-table">
                  <caption className="sr-only">{list[0].station_name} 가입자</caption>
                  <thead>
                    <tr>
                      <th scope="col">이메일</th>
                      <th scope="col">역할</th>
                      <th scope="col">가입</th>
                      <th scope="col">마지막 요청</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((m) => {
                      const last = m.last_request_at ?? m.last_sign_in_at;
                      return (
                        <tr key={`${m.user_id}:${m.role}`}>
                          <th scope="row">{m.email}</th>
                          <td>
                            {roleKo(m.role, m.operation)}
                            {m.is_manager && <span className="act-sub">관리자</span>}
                          </td>
                          <td title={fullTime(m.joined_at)}>{ago(m.joined_at)}</td>
                          <td title={fullTime(last)}>{last ? ago(last) : '없음'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ))
        ))}

      {view === 'pending' &&
        (pShown.length === 0 ? (
          <p className="note">기다리는 사람이 없습니다.</p>
        ) : (
          <div className="table-scroll">
            <table className="price-table act-table">
              <caption className="sr-only">가입 대기, 최근 순</caption>
              <thead>
                <tr>
                  <th scope="col">이메일</th>
                  <th scope="col">상태</th>
                  <th scope="col">주유소</th>
                  <th scope="col">언제부터</th>
                </tr>
              </thead>
              <tbody>
                {pShown.map((p, i) => (
                  <tr key={`${p.kind}:${p.email}:${p.station_id ?? i}`}>
                    <th scope="row">{p.email}</th>
                    <td>
                      {PENDING_KO[p.kind]}
                      <span className="act-sub">
                        {[p.kind === 'invite' && roleKo(p.role) + (p.is_manager ? '·관리자' : ''), p.by_email && `${p.by_email} 초대`, p.note].filter(Boolean).join(' · ')}
                      </span>
                    </td>
                    <td className="act-st">{p.station_name ?? '–'}</td>
                    <td title={fullTime(p.since)}>{ago(p.since)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {view === 'mail' && (
        <>
          {lShown.length === 0 ? (
            <p className="note">최근 30일에 보낸 메일이 없습니다.</p>
          ) : (
            <div className="table-scroll">
              <table className="price-table act-table">
                <caption className="sr-only">메일 발송 기록, 최근 30일, 최근 순</caption>
                <thead>
                  <tr>
                    <th scope="col">보낸 때</th>
                    <th scope="col">받는 사람</th>
                    <th scope="col">종류</th>
                    <th scope="col">그 뒤 로그인</th>
                  </tr>
                </thead>
                <tbody>
                  {lShown.map((l, i) => {
                    const stale = !l.logged_in_at && Date.now() - Date.parse(l.at) > 3_600_000;
                    return (
                      <tr key={`${l.at}:${l.email}:${i}`}>
                        <td title={fullTime(l.at)}>{ago(l.at)}</td>
                        <th scope="row">
                          {l.email}
                          {l.stations && <span className="act-sub">{l.stations}</span>}
                        </th>
                        <td>{MAIL_KO[l.kind]}</td>
                        <td>
                          {l.logged_in_at ? (
                            <span title={fullTime(l.logged_in_at)}>{Math.max(0, Math.round((Date.parse(l.logged_in_at) - Date.parse(l.at)) / 60_000))}분 뒤</span>
                          ) : (
                            <span className={`status-tag ${stale ? 'draft' : 'soft'}`}>{stale ? '안 누름' : '기다리는 중'}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="fine">
            Supabase가 메일을 보낸 순간을 기록합니다. 발송 한도에 걸려 아예 보내지 못한 요청과 스팸함으로 간 메일은 여기서 알 수 없습니다. 보낸 지 한 시간이
            지나도록 로그인이 없으면 &ldquo;안 누름&rdquo;으로 표시합니다.
          </p>
        </>
      )}
    </>
  );
}
