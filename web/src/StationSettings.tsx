import { useCallback, useEffect, useState } from 'react';
import { md } from './data';
import { AREA_KO, ROLE_KO, supabase, type Area, type Profile, type Role, type Station } from './supabase';

interface Member {
  user_id: string;
  role: Role;
  is_manager: boolean;
  created_at: string;
}
interface Invite {
  email: string;
  role: Role;
  is_manager: boolean;
  created_at: string;
}
interface PermRow {
  role: Role;
  area: Area;
  can_read: boolean;
  can_write: boolean;
}

const AREAS = Object.keys(AREA_KO) as Area[];

/** 주유소 관리자 전용 — 주유소 정보, 회원·초대, 역할별 권한 */
export function StationSettings({ me, station, onChanged }: { me: Profile; station: Station; onChanged: () => void }) {
  const sid = station.id;
  const [members, setMembers] = useState<Member[]>([]);
  const [people, setPeople] = useState<Map<string, Profile>>(new Map());
  const [invites, setInvites] = useState<Invite[]>([]);
  const [perms, setPerms] = useState<PermRow[]>([]);
  const [email, setEmail] = useState('');
  const self = station.operation === 'self';
  /** 직접 운영이면 임대인 대신 '운영자' */
  const RK = (r: Role) => (self && r === 'owner' ? '운영자' : ROLE_KO[r]);
  const [role, setRole] = useState<Role>(station.applicant_role === 'tenant' || self ? 'owner' : 'tenant');
  const [asManager, setAsManager] = useState(false);
  const [name, setName] = useState(station.name);
  const [chat, setChat] = useState(station.telegram_chat_id);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    const [m, i, p] = await Promise.all([
      supabase.from('station_members').select('user_id,role,is_manager,created_at').eq('station_id', sid).order('created_at'),
      supabase.from('station_invites').select('email,role,is_manager,created_at').eq('station_id', sid).order('created_at'),
      supabase.from('station_permissions').select('role,area,can_read,can_write').eq('station_id', sid),
    ]);
    const ms = (m.data as Member[]) ?? [];
    setMembers(ms);
    setInvites((i.data as Invite[]) ?? []);
    setPerms((p.data as PermRow[]) ?? []);
    const ids = [...new Set(ms.map((x) => x.user_id))];
    if (ids.length) {
      const { data } = await supabase.from('profiles').select('id,email,name,is_site_admin').in('id', ids);
      setPeople(new Map(((data as Profile[]) ?? []).map((x) => [x.id, x])));
    }
    if (m.error || i.error || p.error) setError((m.error ?? i.error ?? p.error)!.message);
  }, [sid]);

  useEffect(() => {
    reload();
  }, [reload]);

  const act = async (fn: () => PromiseLike<{ error: { message: string } | null }>, done: string) => {
    setError('');
    setMsg('');
    const { error } = await fn();
    if (error) setError(error.message);
    else setMsg(done);
    await reload();
  };

  const managers = members.filter((m) => m.is_manager);
  const who = (uid: string) => people.get(uid)?.email ?? '알 수 없음';

  return (
    <section className="block" aria-labelledby="st-title">
      <header className="block-head">
        <h2 id="st-title">주유소 설정</h2>
        <p className="block-meta">관리자만 보입니다. 관리자는 모든 메뉴를 보고 고칠 수 있습니다</p>
      </header>

      {msg && <p className="info-note">{msg}</p>}
      {error && (
        <p className="change-note" role="alert">
          {error}
        </p>
      )}

      <h3 className="sub-head">회원</h3>
      <div className="table-scroll">
        <table className="price-table member-table">
          <thead>
            <tr>
              <th scope="col">이메일</th>
              <th scope="col">역할</th>
              <th scope="col">관리자</th>
              <th scope="col">
                <span className="sr-only">내보내기</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const self = m.user_id === me.id;
              const lastManager = m.is_manager && managers.length === 1;
              return (
                <tr key={`${m.user_id}-${m.role}`}>
                  <th scope="row">
                    {who(m.user_id)}
                    {self && <span className="brand-name">나</span>}
                  </th>
                  <td>{RK(m.role)}</td>
                  <td>
                    <input
                      type="checkbox"
                      checked={m.is_manager}
                      disabled={lastManager}
                      title={lastManager ? '관리자가 한 명 이상 있어야 합니다' : undefined}
                      aria-label={`${who(m.user_id)} 관리자`}
                      onChange={(e) =>
                        act(
                          () =>
                            supabase
                              .from('station_members')
                              .update({ is_manager: e.target.checked })
                              .eq('station_id', sid)
                              .eq('user_id', m.user_id)
                              .eq('role', m.role),
                          `${who(m.user_id)} 을(를) ${e.target.checked ? '관리자로 지정했습니다' : '관리자에서 뺐습니다'}.`,
                        ).then(() => self && !e.target.checked && onChanged())
                      }
                    />
                  </td>
                  <td>
                    {!lastManager && (
                      <button
                        type="button"
                        className="link-btn danger-inline"
                        onClick={() => {
                          if (!confirm(self ? '이 주유소에서 나갈까요? 다시 들어오려면 초대를 받아야 합니다.' : `${who(m.user_id)} 을(를) 내보낼까요?`)) return;
                          act(
                            () => supabase.from('station_members').delete().eq('station_id', sid).eq('user_id', m.user_id).eq('role', m.role),
                            self ? '주유소에서 나왔습니다.' : '내보냈습니다.',
                          ).then(() => self && onChanged());
                        }}
                      >
                        {self ? '나가기' : '내보내기'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3 className="sub-head">초대</h3>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          const em = email.trim().toLowerCase();
          if (!em) return;
          act(
            () => supabase.from('station_invites').upsert({ station_id: sid, email: em, role, is_manager: asManager }, { ignoreDuplicates: false }),
            `${em} 을(를) ${RK(role)}${self && role === 'owner' ? '로' : '으로'} 초대했습니다. 이미 가입한 분이면 바로 회원 목록에 들어가고, 아니면 이 이메일로 로그인하는 순간 들어옵니다.`,
          ).then(() => {
            setEmail('');
            setAsManager(false);
          });
        }}
      >
        <div className="form-row">
          <label>
            이메일
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>
            역할
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="owner">{self ? '소유자 (같이 운영)' : '임대인'}</option>
              {!self && <option value="tenant">임차인</option>}
            </select>
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={asManager} onChange={(e) => setAsManager(e.target.checked)} /> 관리자로 (회원·권한을 같이 관리)
        </label>
        <div className="form-actions">
          <button type="submit" className="primary">
            초대
          </button>
        </div>
        <p className="fine">초대 메일은 따로 가지 않습니다. 초대한 분에게 이 사이트 주소와 이메일로 로그인하라고 알려 주세요.</p>
      </form>
      {invites.length > 0 && (
        <ul className="tx-list">
          {invites.map((i) => (
            <li key={`${i.email}-${i.role}`}>
              <span className="tx-main">
                {i.email} <span className="brand-name">{RK(i.role)}{i.is_manager ? ', 관리자' : ''}, {md(i.created_at)} 초대, 아직 로그인 전</span>
              </span>
              <button
                type="button"
                className="link-btn danger-inline"
                onClick={() =>
                  act(
                    () => supabase.from('station_invites').delete().eq('station_id', sid).eq('email', i.email).eq('role', i.role),
                    '초대를 취소했습니다.',
                  )
                }
              >
                초대 취소
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3 className="sub-head">역할별 권한</h3>
      <p className="fine">관리자가 아닌 회원이 볼 수 있는 메뉴입니다. 수정을 켜면 보기도 켜집니다.</p>
      <div className="table-scroll">
        <table className="price-table perm-table">
          <thead>
            <tr>
              <th scope="col">메뉴</th>
              {(['owner', 'tenant'] as Role[]).map((r) => (
                <th key={r} scope="col" colSpan={2}>
                  {RK(r)}
                </th>
              ))}
            </tr>
            <tr>
              <th scope="col">
                <span className="sr-only">메뉴</span>
              </th>
              <th scope="col">보기</th>
              <th scope="col">수정</th>
              <th scope="col">보기</th>
              <th scope="col">수정</th>
            </tr>
          </thead>
          <tbody>
            {AREAS.map((a) => (
              <tr key={a}>
                <th scope="row">{AREA_KO[a]}</th>
                {(['owner', 'tenant'] as Role[]).map((r) => {
                  const p = perms.find((x) => x.role === r && x.area === a);
                  if (a === 'fuel' && r === 'owner' && !self)
                    return (
                      <td key="owner-fuel" colSpan={2} className="fine">
                        {p?.can_read ? '임차인이 공유 중' : '임차인이 공유할 때만'}
                      </td>
                    );
                  const set = (patch: Partial<PermRow>, done: string) =>
                    act(() => supabase.from('station_permissions').update(patch).eq('station_id', sid).eq('role', r).eq('area', a), done);
                  return [
                    <td key={`${r}-r`}>
                      <input
                        type="checkbox"
                        checked={!!p?.can_read}
                        aria-label={`${RK(r)} ${AREA_KO[a]} 보기`}
                        onChange={(e) =>
                          set(
                            e.target.checked ? { can_read: true } : { can_read: false, can_write: false },
                            `${RK(r)} ${AREA_KO[a]} 보기를 ${e.target.checked ? '켰' : '껐'}습니다.`,
                          )
                        }
                      />
                    </td>,
                    <td key={`${r}-w`}>
                      <input
                        type="checkbox"
                        checked={!!p?.can_write}
                        aria-label={`${RK(r)} ${AREA_KO[a]} 수정`}
                        onChange={(e) =>
                          set(
                            e.target.checked ? { can_read: true, can_write: true } : { can_write: false },
                            `${RK(r)} ${AREA_KO[a]} 수정을 ${e.target.checked ? '켰' : '껐'}습니다.`,
                          )
                        }
                      />
                    </td>,
                  ];
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="sub-head">임대 중인가요?</h3>
      <OperationForm station={station} hasTenant={members.some((m) => m.role === 'tenant' && !members.some((o) => o.user_id === m.user_id && o.role === 'owner'))} act={act} onChanged={onChanged} />

      <h3 className="sub-head">주유소 정보·알림</h3>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          act(
            () => supabase.from('stations').update({ name: name.trim() || station.name, telegram_chat_id: chat.trim() }).eq('id', sid),
            '저장했습니다.',
          ).then(onChanged);
        }}
      >
        <div className="cf-grid">
          <label className="cf-field">
            <span>주유소 이름 (간판에 표시)</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="cf-field">
            <span>텔레그램 채팅 ID</span>
            <input inputMode="numeric" value={chat} placeholder="예: 123456789" onChange={(e) => setChat(e.target.value)} />
            <span className="field-hint">
              기한·미납·가격 알림을 받을 곳입니다. 텔레그램에서 알림 봇에게 아무 말이나 보낸 뒤 @userinfobot 에게서 받은 숫자 ID 를 넣으세요. 봇 이름은 의견 보내기로 물어보세요.
            </span>
          </label>
        </div>
        <p className="fine">
          주소 {station.address || '미입력'}
          {station.opinet_id ? `, 오피넷 ${station.opinet_id}` : ', 오피넷 미연결'}
          {station.lawd_cd ? `, 실거래가 지역코드 ${station.lawd_cd}` : ', 실거래가 지역코드 미입력'}. 바꿔야 하면 의견 보내기로 알려 주세요.
        </p>
        <div className="form-actions">
          <button type="submit" className="primary" disabled={name.trim() === station.name && chat.trim() === station.telegram_chat_id}>
            저장
          </button>
        </div>
      </form>
    </section>
  );
}

function OperationForm({
  station,
  hasTenant,
  act,
  onChanged,
}: {
  station: Station;
  hasTenant: boolean;
  act: (fn: () => PromiseLike<{ error: { message: string } | null }>, done: string) => Promise<void>;
  onChanged: () => void;
}) {
  const [op, setOp] = useState(station.operation);
  const changed = op !== station.operation;
  const blocked = op === 'self' && hasTenant;
  return (
    <div className="form">
      <div className="seg" role="radiogroup" aria-label="운영 형태">
        <button type="button" role="radio" aria-checked={op === 'self'} aria-pressed={op === 'self'} onClick={() => setOp('self')}>
          직접 운영
        </button>
        <button type="button" role="radio" aria-checked={op === 'leased'} aria-pressed={op === 'leased'} onClick={() => setOp('leased')}>
          임대 중
        </button>
      </div>
      <p className="fine">
        {op === 'self'
          ? '직접 운영하는 주유소입니다. 임대 중이면 "임대 중"으로 바꾸세요. 계약 일정·임대료 입금 메뉴가 생기고 임대인·임차인을 나눠 초대할 수 있습니다.'
          : '임대 중인 주유소입니다. 계약 일정·입금 확인 메뉴가 있고, 유류 장부는 임차인의 영업 정보라 임차인이 공유를 켜야 임대인도 봅니다. 임대인이 관리자여도 스스로 켤 수 없습니다.'}
      </p>
      {changed && op === 'leased' && <p className="info-note">임대로 바꾸면 지금까지 쓴 유류 장부 기록은 앞으로 들어올 임차인이 보게 되고, 소유자는 임차인이 공유를 켜기 전까지 보지 못합니다.</p>}
      {blocked && <p className="change-note">임차인 회원이 있어 직접 운영으로 바꿀 수 없습니다. 임차인을 먼저 내보내세요.</p>}
      {changed && (
        <div className="form-actions">
          <button
            type="button"
            className="primary"
            disabled={blocked}
            onClick={() =>
              act(() => supabase.from('stations').update({ operation: op }).eq('id', station.id), `운영 형태를 ${op === 'self' ? '직접 운영' : '임대'}으로 바꿨습니다.`).then(onChanged)
            }
          >
            운영 형태 저장
          </button>
          <button type="button" className="more" onClick={() => setOp(station.operation)}>
            취소
          </button>
        </div>
      )}
    </div>
  );
}
