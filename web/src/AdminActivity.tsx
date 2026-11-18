import { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase';
import { Loading } from './Loading';

interface Row {
  user_id: string;
  email: string;
  is_site_admin: boolean;
  signed_up_at: string;
  last_sign_in_at: string | null;
  last_at: string | null;
  active_days: number;
  visits: number;
  device: 'mobile' | 'desktop' | null;
  last_station: string | null;
  stations: string | null;
}
interface Day {
  day: string;
  users: number;
  visits: number;
}

const PERIOD = 30;

/** "3분 전", "어제 14:05", "11.02" */
export function ago(iso: string | null) {
  if (!iso) return '';
  const t = Date.parse(iso);
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  if (m < 60 * 24) return `${Math.round(m / 60)}시간 전`;
  const d = new Date(t);
  const hm = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' });
  if (m < 60 * 48) return `어제 ${hm}`;
  return d.toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit', timeZone: 'Asia/Seoul' }).replace(/\s/g, '').replace(/\.$/, '');
}
export const fullTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '');
const mdOf = (day: string) => `${Number(day.slice(5, 7))}.${Number(day.slice(8, 10))}`;

/** 사이트 관리: 접속 기록 — 누가 언제 들어왔는지만 (주유소 데이터·IP 없음) */
export function AdminActivity() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [days, setDays] = useState<Day[]>([]);
  const [error, setError] = useState('');
  const [hideMe, setHideMe] = useState(true);

  useEffect(() => {
    Promise.all([supabase.rpc('admin_recent_activity', { days: PERIOD }), supabase.rpc('admin_daily_active', { days: PERIOD })]).then(([r, d]) => {
      if (r.error || d.error) setError((r.error ?? d.error)!.message);
      setRows((r.data as Row[]) ?? []);
      setDays((d.data as Day[]) ?? []);
    });
  }, []);

  const shown = (rows ?? []).filter((r) => !(hideMe && r.is_site_admin));
  const today = days[days.length - 1]?.users ?? 0;
  const week = useMemo(() => {
    const since = Date.now() - 7 * 86_400_000;
    return (rows ?? []).filter((r) => !r.is_site_admin && r.last_at && Date.parse(r.last_at) >= since).length;
  }, [rows]);
  const month = (rows ?? []).filter((r) => !r.is_site_admin && r.active_days > 0).length;
  const total = (rows ?? []).filter((r) => !r.is_site_admin).length;
  const peak = Math.max(1, ...days.map((d) => d.users));

  if (!rows) return <Loading />;

  return (
    <>
      {error && (
        <p className="change-note" role="alert">
          {error}
        </p>
      )}
      <p className="readout">
        로그인한 사람이 서버에 마지막으로 요청한 시각을 1분 단위로 기록합니다. 주유소 데이터, IP, 기기 정보는 남기지 않고 휴대폰/PC 구분만 봅니다. 기록은 11월 17일부터 쌓입니다.
      </p>

      <dl className="sim-out close-sum act-sum">
        <div>
          <dt>오늘 접속</dt>
          <dd>
            <b>{today}명</b>
          </dd>
        </div>
        <div>
          <dt>최근 7일</dt>
          <dd>
            <b>{week}명</b>
          </dd>
        </div>
        <div>
          <dt>최근 {PERIOD}일</dt>
          <dd>
            <b>{month}명</b>
            <span className="sim-was">가입 {total}명 중</span>
          </dd>
        </div>
      </dl>

      <h3 className="sub-head">날짜별 접속한 사람</h3>
      <div className="dau" role="img" aria-label={`최근 ${PERIOD}일 날짜별 접속자 수. 가장 많은 날 ${peak}명, 오늘 ${today}명`}>
        <div className="dau-plot">
          {days.map((d, i) => (
            <div className="dau-col" key={d.day} tabIndex={0} aria-label={`${mdOf(d.day)} ${d.users}명`}>
              <span className="dau-bar" style={{ height: d.users ? `${(d.users / peak) * 100}%` : '0' }} />
              <span className="dau-tip">
                {mdOf(d.day)} · {d.users}명{d.visits > d.users ? `, ${d.visits}회` : ''}
              </span>
              {(i === 0 || i === days.length - 1 || d.day.endsWith('-01')) && <span className="dau-x">{i === days.length - 1 ? '오늘' : mdOf(d.day)}</span>}
            </div>
          ))}
        </div>
        <span className="dau-y">{peak}명</span>
      </div>
      <table className="sr-only">
        <caption>날짜별 접속자 수</caption>
        <tbody>
          {days.map((d) => (
            <tr key={d.day}>
              <th scope="row">{d.day}</th>
              <td>{d.users}명</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="sub-head">사람별 마지막 요청</h3>
      <label className="check-inline">
        <input type="checkbox" checked={hideMe} onChange={(e) => setHideMe(e.target.checked)} /> 사이트 관리자 계정 빼고 보기
      </label>
      {shown.length === 0 ? (
        <p className="note">아직 기록이 없습니다.</p>
      ) : (
        <div className="table-scroll">
          <table className="price-table act-table">
            <caption className="sr-only">사람별 마지막 요청, 최근 순</caption>
            <thead>
              <tr>
                <th scope="col">이메일</th>
                <th scope="col">마지막 요청</th>
                <th scope="col" className="num">
                  {PERIOD}일 중
                </th>
                <th scope="col">소속</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const lastAt = r.last_at ?? r.last_sign_in_at;
                const stale = !lastAt || Date.now() - Date.parse(lastAt) > 14 * 86_400_000;
                return (
                  <tr key={r.user_id} className={stale ? 'stale' : ''}>
                    <th scope="row">
                      {r.email}
                      {r.is_site_admin && <span className="status-tag soft">관리자</span>}
                    </th>
                    <td title={fullTime(lastAt)}>
                      {lastAt ? ago(lastAt) : '요청 없음'}
                      <span className="act-sub">
                        {r.last_at ? [r.device === 'mobile' ? '휴대폰' : 'PC', r.last_station].filter(Boolean).join(' · ') : r.last_sign_in_at ? '로그인 기록' : `가입 ${ago(r.signed_up_at)}`}
                      </span>
                    </td>
                    <td className="num">
                      {r.active_days ? `${r.active_days}일` : '–'}
                      {r.visits > r.active_days && <span className="act-sub">{r.visits}회</span>}
                    </td>
                    <td className="act-st">{r.stations ?? <span className="act-sub">주유소 없음</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="fine">2주 넘게 요청이 없는 사람은 흐리게 표시합니다. 마지막 요청에 손가락이나 마우스를 올리면 정확한 시각이 나옵니다. 아직 기록이 없는 사람은 마지막 로그인 시각을 대신 보여 줍니다.</p>
    </>
  );
}
