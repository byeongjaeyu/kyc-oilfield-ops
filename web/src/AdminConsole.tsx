import { useCallback, useEffect, useState } from 'react';
import { AdminActivity } from './AdminActivity';
import { AdminMembers } from './AdminMembers';
import { DonateSettings } from './Donate';
import { md } from './data';
import { FB_STATUS_KO, KIND_KO, type Feedback, type FeedbackStatus } from './FeedbackSection';
import { bizNoFmt, ROLE_KO, STATUS_KO, supabase, type Profile, type Station } from './supabase';

type Pane = 'apps' | 'stations' | 'members' | 'activity' | 'feedback' | 'site';

/**
 * 사이트 관리자(개발자) 화면 — 등록 신청 심사, 주유소 목록(회원 수만), 의견·버그함
 * 주유소의 데이터(계약·입금·검사 등)는 여기서 볼 수 없다. 버그는 데모 주유소에서 재현한다.
 */
export function AdminConsole({ me: _me, onChanged }: { me: Profile; onChanged: () => void }) {
  const [pane, setPane] = useState<Pane>('apps');
  const [stations, setStations] = useState<Station[]>([]);
  const [counts, setCounts] = useState<Map<string, { members: number; managers: number }>>(new Map());
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    const [s, c, f] = await Promise.all([
      supabase.from('stations').select('*').order('created_at', { ascending: false }),
      supabase.rpc('admin_station_overview'),
      supabase.from('feedback').select('*').order('created_at', { ascending: false }).limit(200),
    ]);
    setStations((s.data as Station[]) ?? []);
    setCounts(new Map(((c.data as Array<{ station_id: string; members: number; managers: number }>) ?? []).map((x) => [x.station_id, x])));
    setFeedback((f.data as Feedback[]) ?? []);
    if (s.error || f.error) setError((s.error ?? f.error)!.message);
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);

  const run = async (label: string, fn: () => Promise<void>, done: string) => {
    setBusy(label);
    setError('');
    setMsg('');
    try {
      await fn();
      setMsg(done);
      await reload();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const update = async (id: string, patch: Record<string, unknown>) => {
    const { error } = await supabase.from('stations').update(patch).eq('id', id);
    if (error) throw new Error(error.message);
  };

  const pending = stations.filter((s) => s.status === 'pending');
  const others = stations.filter((s) => s.status !== 'pending');
  const newFb = feedback.filter((f) => f.status === 'new').length;
  const stationName = (id: string | null) => (id ? stations.find((s) => s.id === id)?.name ?? '삭제된 주유소' : '주유소 없음');

  return (
    <section className="block" aria-labelledby="admin-title">
      <header className="block-head">
        <h2 id="admin-title">사이트 관리</h2>
        <div className="seg" role="group" aria-label="화면">
          <button type="button" aria-pressed={pane === 'apps'} onClick={() => setPane('apps')}>
            등록 신청 {pending.length > 0 && <b className="count">{pending.length}</b>}
          </button>
          <button type="button" aria-pressed={pane === 'stations'} onClick={() => setPane('stations')}>
            주유소 {stations.length}
          </button>
          <button type="button" aria-pressed={pane === 'members'} onClick={() => setPane('members')}>
            회원·메일
          </button>
          <button type="button" aria-pressed={pane === 'activity'} onClick={() => setPane('activity')}>
            접속
          </button>
          <button type="button" aria-pressed={pane === 'feedback'} onClick={() => setPane('feedback')}>
            의견·버그 {newFb > 0 && <b className="count">{newFb}</b>}
          </button>
          <button type="button" aria-pressed={pane === 'site'} onClick={() => setPane('site')}>
            후원·연락처
          </button>
        </div>
      </header>
      <p className="fine">
        사이트 관리자는 주유소 등록을 승인하고 의견에 답합니다. 각 주유소의 계약·입금·검사 기록은 그 주유소 회원만 볼 수 있어 여기에 나오지 않습니다.
        버그는 데모 주유소에서 재현해 고치세요.
      </p>

      {busy && (
        <p className="note" role="status">
          {busy}…
        </p>
      )}
      {msg && <p className="info-note">{msg}</p>}
      {error && (
        <p className="change-note" role="alert">
          {error}
        </p>
      )}

      {pane === 'members' && <AdminMembers />}

      {pane === 'activity' && <AdminActivity />}

      {pane === 'site' && (
        <>
          <h3 className="sub-head">커피 후원 링크와 운영자 연락처</h3>
          <p className="readout">링크를 넣으면 모든 사용자의 계정 메뉴와 의견 보내기 화면 아래에 후원 버튼이 나옵니다. 돈은 이 사이트를 거치지 않고 링크한 송금 서비스로 바로 갑니다.</p>
          <DonateSettings onSaved={setMsg} />
        </>
      )}

      {pane === 'apps' && (
        <>
          {pending.length === 0 && <p className="readout">새 등록 신청이 없습니다.</p>}
          <ul className="app-list">
            {pending.map((s) => (
              <Application
                key={s.id}
                s={s}
                busy={busy}
                onApprove={(patch) => run('승인하는 중', () => update(s.id, { ...patch, status: 'approved' }), `${s.name} 을(를) 승인했습니다. 신청자가 관리자가 됐습니다.`)}
                onReject={(note) => run('반려하는 중', () => update(s.id, { status: 'rejected', review_note: note }), `${s.name} 신청을 반려했습니다.`)}
              />
            ))}
          </ul>
        </>
      )}

      {pane === 'stations' && (
        <div className="table-scroll">
          <table className="price-table admin-table">
            <thead>
              <tr>
                <th scope="col">주유소</th>
                <th scope="col">상태</th>
                <th scope="col">회원</th>
                <th scope="col">연결</th>
                <th scope="col">신청</th>
                <th scope="col">
                  <span className="sr-only">조치</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {others.map((s) => {
                const c = counts.get(s.id);
                return (
                  <tr key={s.id}>
                    <th scope="row">
                      {s.name}
                      {s.is_demo && <span className="brand-name">데모</span>}
                      <span className="brand-name">{s.address}</span>
                    </th>
                    <td>{STATUS_KO[s.status]}</td>
                    <td className="num-l">{c ? `${c.members}명 (관리자 ${c.managers})` : '0명'}</td>
                    <td className="num-l">
                      {s.opinet_id ? '오피넷' : <span className="alert-text">오피넷 없음</span>}, {s.lawd_cd ? `지역 ${s.lawd_cd}` : <span className="alert-text">지역코드 없음</span>}
                    </td>
                    <td className="num-l">
                      {s.applicant_email || '-'}
                      <span className="brand-name">{md(s.created_at)}</span>
                    </td>
                    <td>
                      {s.status === 'approved' && !s.is_demo && (
                        <button
                          type="button"
                          className="link-btn danger-inline"
                          onClick={() => {
                            if (!confirm(`${s.name} 이용을 중지할까요? 회원들이 이 주유소에 들어갈 수 없게 됩니다 (데이터는 남음).`)) return;
                            run('중지하는 중', () => update(s.id, { status: 'suspended' }), '이용을 중지했습니다.');
                          }}
                        >
                          이용 중지
                        </button>
                      )}
                      {(s.status === 'suspended' || s.status === 'rejected') && (
                        <button type="button" className="link-btn" onClick={() => run('다시 여는 중', () => update(s.id, { status: 'approved' }), '다시 열었습니다.')}>
                          {s.status === 'rejected' ? '승인으로 바꾸기' : '다시 열기'}
                        </button>
                      )}
                      <LinkEditor s={s} busy={busy} onSave={(patch) => run('저장하는 중', () => update(s.id, patch), '연결 정보를 저장했습니다.')} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {pane === 'feedback' && (
        <>
          {feedback.length === 0 && <p className="readout">받은 의견이 없습니다.</p>}
          <ul className="fb-list admin">
            {feedback.map((f) => (
              <FeedbackItem
                key={f.id}
                f={f}
                station={stationName(f.station_id)}
                busy={busy}
                onSave={(patch) =>
                  run('저장하는 중', async () => {
                    const { error } = await supabase.from('feedback').update(patch).eq('id', f.id);
                    if (error) throw new Error(error.message);
                  }, '저장했습니다.')
                }
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** 지번 주소에서 법정동 (예: "광주 북구 운암동 123-4" → "운암동") */
const dongOf = (jibun: string) => jibun.split(/\s+/).find((t) => /(동|가|리)$/.test(t) && !/^\d/.test(t)) ?? '';

function Application({
  s,
  busy,
  onApprove,
  onReject,
}: {
  s: Station;
  busy: string;
  onApprove: (patch: Record<string, unknown>) => void;
  onReject: (note: string) => void;
}) {
  const [lawd, setLawd] = useState(s.lawd_cd ?? '');
  const [dong, setDong] = useState(s.dong || dongOf(s.jibun_address));
  const [opinet, setOpinet] = useState(s.opinet_id ?? '');
  const [note, setNote] = useState('');

  const openDoc = async () => {
    if (!s.biz_doc_path) return;
    const { data, error } = await supabase.storage.from('biz-docs').createSignedUrl(s.biz_doc_path, 300);
    if (error) return alert(error.message);
    window.open(data.signedUrl, '_blank', 'noopener');
  };

  return (
    <li className="app">
      <div>
        <p className="insp-name">{s.name}</p>
        <p className="insp-meta">
          {s.address}
          {s.jibun_address && s.jibun_address !== s.address && ` (${s.jibun_address})`}
        </p>
        <dl className="app-facts">
          <div>
            <dt>신청자</dt>
            <dd>
              {s.applicant_email}, {s.operation === 'self' ? '직접 운영' : ROLE_KO[s.applicant_role]}
            </dd>
          </div>
          <div>
            <dt>사업자등록번호</dt>
            <dd>{s.biz_no ? bizNoFmt(s.biz_no) : '없음'}</dd>
          </div>
          <div>
            <dt>사업자등록증</dt>
            <dd>
              {s.biz_doc_path ? (
                <button type="button" className="link-btn" onClick={openDoc}>
                  {s.biz_doc_name ?? '파일'} 보기
                </button>
              ) : (
                <span className="alert-text">아직 안 올림</span>
              )}
            </dd>
          </div>
          <div>
            <dt>신청일</dt>
            <dd>{md(s.created_at)}</dd>
          </div>
        </dl>
        <p className="fine">
          등록증의 상호·번호가 신청 내용과 맞는지, 국세청 홈택스 사업자 상태 조회에서 계속사업자인지 확인하세요.{' '}
          <a href="https://hometax.go.kr" target="_blank" rel="noreferrer noopener">
            홈택스
          </a>
        </p>
        <div className="cf-grid">
          <label className="cf-field">
            <span>오피넷 ID</span>
            <input value={opinet} onChange={(e) => setOpinet(e.target.value.trim())} placeholder="A0000000" />
          </label>
          <label className="cf-field">
            <span>실거래가 지역코드 (5자리)</span>
            <input inputMode="numeric" maxLength={5} value={lawd} onChange={(e) => setLawd(e.target.value.replace(/\D/g, ''))} placeholder="예: 12330" />
            <span className="field-hint">
              법정동코드 앞 5자리.{' '}
              <a href="https://www.code.go.kr/stdcode/regCodeL.do" target="_blank" rel="noreferrer noopener">
                행정표준코드 조회
              </a>
            </span>
          </label>
          <label className="cf-field">
            <span>법정동</span>
            <input value={dong} onChange={(e) => setDong(e.target.value.trim())} placeholder="예: 운암동" />
          </label>
        </div>
        <label className="cf-field wide">
          <span>반려 사유 (반려할 때만)</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="예: 사업자등록증 사진이 흐려 번호를 읽을 수 없습니다" />
        </label>
      </div>
      <div className="form-actions">
        <button
          type="button"
          className="primary"
          disabled={!!busy}
          onClick={() =>
            onApprove({
              opinet_id: opinet || null,
              lawd_cd: /^\d{5}$/.test(lawd) ? lawd : null,
              dong,
              nearby_dongs: dong ? [dong] : [],
            })
          }
        >
          승인
        </button>
        <button
          type="button"
          className="more"
          disabled={!!busy || !note.trim()}
          title={!note.trim() ? '반려 사유를 먼저 적어 주세요' : undefined}
          onClick={() => onReject(note.trim())}
        >
          반려
        </button>
      </div>
    </li>
  );
}

function LinkEditor({ s, busy, onSave }: { s: Station; busy: string; onSave: (patch: Record<string, unknown>) => void }) {
  const [open, setOpen] = useState(false);
  const [opinet, setOpinet] = useState(s.opinet_id ?? '');
  const [lawd, setLawd] = useState(s.lawd_cd ?? '');
  const [dong, setDong] = useState(s.dong);
  if (!open)
    return (
      <button type="button" className="link-btn" onClick={() => setOpen(true)}>
        연결 정보
      </button>
    );
  return (
    <form
      className="inline-edit"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ opinet_id: opinet || null, lawd_cd: /^\d{5}$/.test(lawd) ? lawd : null, dong, ...(opinet !== s.opinet_id ? { katec_x: null, katec_y: null } : {}) });
        setOpen(false);
      }}
    >
      <input aria-label="오피넷 ID" value={opinet} onChange={(e) => setOpinet(e.target.value.trim())} placeholder="오피넷 ID" />
      <input aria-label="실거래가 지역코드" value={lawd} maxLength={5} onChange={(e) => setLawd(e.target.value.replace(/\D/g, ''))} placeholder="지역코드" />
      <input aria-label="법정동" value={dong} onChange={(e) => setDong(e.target.value.trim())} placeholder="법정동" />
      <button type="submit" className="more" disabled={!!busy}>
        저장
      </button>
    </form>
  );
}

function FeedbackItem({ f, station, busy, onSave }: { f: Feedback; station: string; busy: string; onSave: (p: Partial<Feedback>) => void }) {
  const [reply, setReply] = useState(f.reply);
  const [status, setStatus] = useState<FeedbackStatus>(f.status);
  return (
    <li className={`fb-${f.status}`}>
      <p className="insp-meta">
        <b>{KIND_KO[f.kind]}</b>, {station}, {f.user_email}, {md(f.created_at)}
        {f.page && `, ${f.page}`}
      </p>
      <p className="fb-body">{f.body}</p>
      {f.user_agent && <p className="fine">{f.user_agent}</p>}
      <div className="fb-answer">
        <label>
          <span className="sr-only">답변</span>
          <textarea rows={2} value={reply} placeholder="답변 (보낸 분에게 보임)" onChange={(e) => setReply(e.target.value)} />
        </label>
        <select aria-label="처리 상태" value={status} onChange={(e) => setStatus(e.target.value as FeedbackStatus)}>
          {(Object.keys(FB_STATUS_KO) as FeedbackStatus[]).map((k) => (
            <option key={k} value={k}>
              {FB_STATUS_KO[k]}
            </option>
          ))}
        </select>
        <button type="button" className="more" disabled={!!busy || (reply === f.reply && status === f.status)} onClick={() => onSave({ reply, status })}>
          저장
        </button>
      </div>
    </li>
  );
}
