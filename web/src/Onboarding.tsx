import { useEffect, useRef, useState } from 'react';
import { md } from './data';
import { FeedbackSection } from './FeedbackSection';
import { bizNoFmt, ROLE_KO, STATUS_KO, supabase, type Profile, type Role, type Station } from './supabase';

const BUCKET = 'biz-docs';
const MAX_FILE = 10 * 1024 * 1024;

interface Found {
  id: string;
  name: string;
  brand: string;
  address: string;
  jibun: string;
  x: number | null;
  y: number | null;
  taken: boolean;
}

const fileName = (name: string) => {
  const ext = (name.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? 'bin').toLowerCase();
  return `${crypto.randomUUID()}.${ext}`;
};
/** 지번 주소에서 법정동 (예: "광주 북구 운암동 123-4" → "운암동") */
const dongOf = (jibun: string) => jibun.split(/\s+/).find((t) => /(동|가|리)$/.test(t) && !/^\d/.test(t)) ?? '';

/** 주유소가 없는 회원: 등록 신청, 신청 현황 */
export function Onboarding({
  me,
  applications,
  hasStations,
  onChanged,
  onDone,
  preview = false,
}: {
  me: Profile;
  applications: Station[];
  hasStations: boolean;
  onChanged: () => Promise<void> | void;
  onDone: () => void;
  /** 사이트 관리자 미리보기: 눌러도 저장·전송하지 않음 */
  preview?: boolean;
}) {
  const [applying, setApplying] = useState(applications.length === 0);
  const [feedback, setFeedback] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const [notice, setNotice] = useState('');
  const run = async (label: string, fn: () => Promise<void>) => {
    if (preview) return setNotice(`미리보기라 실제로 처리하지 않았습니다 (${label.replace(/하는 중$/, '')}).`);
    setBusy(label);
    setError('');
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="block" aria-labelledby="ob-title">
      <header className="block-head">
        <h2 id="ob-title">{hasStations ? '주유소 추가 등록' : '주유소 등록'}</h2>
        <p className="block-meta">사이트 관리자가 사업자등록을 확인한 뒤 열어 드립니다</p>
      </header>

      {!hasStations && (
        <p className="readout">
          아직 들어갈 수 있는 주유소가 없습니다. 이미 등록된 주유소라면 그 주유소 관리자에게 <b>{me.email}</b> 로 초대해 달라고 하세요. 처음
          등록하는 주유소라면 아래에서 신청하세요.
        </p>
      )}

      {applications.length > 0 && (
        <ul className="app-list">
          {applications.map((a) => (
            <li key={a.id} className={`app app-${a.status}`}>
              <div>
                <p className="insp-name">
                  {a.name} <span className={`status-tag ${a.status === 'rejected' ? 'draft' : ''}`}>{STATUS_KO[a.status]}</span>
                </p>
                <p className="insp-meta">
                  {a.address}, {a.operation === 'self' ? '직접 운영' : ROLE_KO[a.applicant_role]}으로 신청, {md(a.created_at)}
                </p>
                {a.status === 'pending' && <p className="fine">확인이 끝나면 이 화면이 그 주유소 대시보드로 바뀝니다. 보통 하루 안에 처리됩니다.</p>}
                {a.status === 'rejected' && (
                  <p className="change-note">
                    반려 사유: {a.review_note || '사유 없음'}. 고친 뒤 다시 신청할 수 있습니다.
                  </p>
                )}
                {a.status === 'suspended' && <p className="change-note">이용이 중지된 주유소입니다. 사이트 관리자에게 문의하세요.</p>}
                {!a.biz_doc_path && a.status !== 'suspended' && (
                  <BizDocUpload station={a} busy={busy} preview={preview} onUploaded={() => onChanged()} onError={setError} onPreview={setNotice} />
                )}
              </div>
              {(a.status === 'pending' || a.status === 'rejected') && (
                <div className="form-actions">
                  {a.status === 'rejected' && (
                    <button
                      type="button"
                      className="primary"
                      disabled={!!busy}
                      onClick={() =>
                        run('다시 신청하는 중', async () => {
                          const { error } = await supabase.from('stations').update({ status: 'pending' }).eq('id', a.id);
                          if (error) throw new Error(error.message);
                        })
                      }
                    >
                      다시 신청
                    </button>
                  )}
                  <button
                    type="button"
                    className="link-btn danger-inline"
                    onClick={() => {
                      if (!confirm(`${a.name} 등록 신청을 취소할까요?`)) return;
                      run('신청 취소하는 중', async () => {
                        if (a.biz_doc_path) await supabase.storage.from(BUCKET).remove([a.biz_doc_path]);
                        const { error } = await supabase.from('stations').delete().eq('id', a.id);
                        if (error) throw new Error(error.message);
                      });
                    }}
                  >
                    신청 취소
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {busy && (
        <p className="note" role="status">
          {busy}…
        </p>
      )}
      {notice && <p className="info-note">{notice}</p>}
      {error && (
        <p className="change-note" role="alert">
          {error}
        </p>
      )}

      {applying ? (
        <ApplyForm
          busy={busy}
          onCancel={applications.length || hasStations ? () => (hasStations ? onDone() : setApplying(false)) : undefined}
          onSubmit={(draft, file) =>
            run('신청하는 중', async () => {
              const { data, error } = await supabase.from('stations').insert(draft).select('id').single();
              if (error) {
                throw new Error(
                  /stations_opinet_unique|duplicate/.test(error.message)
                    ? '이미 등록됐거나 신청 중인 주유소입니다. 그 주유소 관리자에게 초대를 요청하세요.'
                    : error.message,
                );
              }
              const path = `${data.id}/${fileName(file.name)}`;
              const up = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type || undefined });
              if (up.error) throw new Error(`신청은 접수됐지만 사업자등록증을 올리지 못했습니다 (${up.error.message}). 아래 신청 목록에서 다시 올려 주세요.`);
              await supabase.from('stations').update({ biz_doc_path: path, biz_doc_name: file.name }).eq('id', data.id);
              setApplying(false);
            })
          }
        />
      ) : (
        <button type="button" className="more" onClick={() => setApplying(true)}>
          다른 주유소 신청하기
        </button>
      )}

      <h3 className="sub-head">문의</h3>
      {feedback && !preview ? (
        <FeedbackSection me={me} stationId={null} page="주유소 등록" embedded />
      ) : (
        <button type="button" className="link-btn" onClick={() => (preview ? setNotice('미리보기라 의견 쓰는 칸을 열지 않았습니다. 실제로는 여기서 사이트 관리자에게 글을 보냅니다.') : setFeedback(true))}>
          사이트 관리자에게 질문·의견 보내기
        </button>
      )}
    </section>
  );
}

function BizDocUpload({
  station,
  busy,
  preview,
  onUploaded,
  onError,
  onPreview,
}: {
  station: Station;
  busy: string;
  preview: boolean;
  onUploaded: () => void;
  onError: (m: string) => void;
  onPreview: (m: string) => void;
}) {
  return (
    <label className="more file-btn">
      사업자등록증 올리기
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
        disabled={!!busy}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          if (preview) return onPreview(`미리보기라 ${f.name} 을(를) 올리지 않았습니다.`);
          if (f.size > MAX_FILE) return onError('파일이 10MB 를 넘습니다.');
          const path = `${station.id}/${fileName(f.name)}`;
          const up = await supabase.storage.from(BUCKET).upload(path, f, { contentType: f.type || undefined });
          if (up.error) return onError(up.error.message);
          const { error } = await supabase.from('stations').update({ biz_doc_path: path, biz_doc_name: f.name }).eq('id', station.id);
          if (error) return onError(error.message);
          onUploaded();
        }}
      />
    </label>
  );
}

function ApplyForm({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: string;
  onCancel?: () => void;
  onSubmit: (draft: Partial<Station> & Record<string, unknown>, file: File) => void;
}) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Found[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchMsg, setSearchMsg] = useState('');
  const [picked, setPicked] = useState<Found | null>(null);
  const [manual, setManual] = useState(false);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [role, setRole] = useState<Role | 'self'>('self');
  const [bizNo, setBizNo] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [formError, setFormError] = useState('');

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const seq = useRef(0);
  const cache = useRef(new Map<string, Found[]>());

  // 두 글자 이상 치면 잠깐 멈춘 뒤 오피넷에서 찾아 드롭다운으로
  useEffect(() => {
    const term = q.trim();
    if (picked && term === picked.name) return;
    setSearchMsg('');
    if (term.length < 2) {
      setFound(null);
      setOpen(false);
      return;
    }
    const hit = cache.current.get(term);
    if (hit) {
      setFound(hit);
      setOpen(true);
      setActive(-1);
      return;
    }
    const my = ++seq.current;
    const t = window.setTimeout(async () => {
      setSearching(true);
      const { data, error } = await supabase.functions.invoke(`opinet-search?q=${encodeURIComponent(term)}`, { method: 'GET' });
      if (my !== seq.current) return; // 그 사이 더 쳤으면 버림
      setSearching(false);
      if (error) {
        let msg = error.message;
        try {
          const body = await (error as { context?: Response }).context?.json();
          msg = body?.message ?? body?.error ?? msg;
          if (body?.error === 'NO_KEY' || body?.error === 'LIMIT') setManual(true);
        } catch {
          /* 본문 없음 */
        }
        setFound(null);
        setOpen(false);
        return setSearchMsg(msg);
      }
      const list = (data?.stations ?? []) as Found[];
      cache.current.set(term, list);
      setFound(list);
      setOpen(true);
      setActive(-1);
    }, 350);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const choose = (f: Found) => {
    if (f.taken) return;
    setPicked(f);
    setQ(f.name);
    setOpen(false);
  };

  const digits = bizNo.replace(/\D/g, '');
  const [agree, setAgree] = useState(false);
  const ready = (manual ? name.trim() && address.trim() : picked && !picked.taken) && digits.length === 10 && file && agree;

  return (
    <form
      className="form boxed apply-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || !file) return setFormError('주유소, 사업자등록번호 10자리, 사업자등록증을 모두 넣고 개인정보 수집에 동의해 주세요.');
        if (file.size > MAX_FILE) return setFormError('사업자등록증 파일이 10MB 를 넘습니다.');
        setFormError('');
        const base = { applicant_role: role === 'self' ? 'owner' : role, operation: (role === 'self' ? 'self' : 'leased') as Station['operation'], biz_no: digits };
        onSubmit(
          manual || !picked
            ? { ...base, name: name.trim(), address: address.trim() }
            : {
                ...base,
                name: picked.name,
                address: picked.address || picked.jibun,
                jibun_address: picked.jibun,
                opinet_id: picked.id,
                brand: picked.brand,
                katec_x: picked.x,
                katec_y: picked.y,
                dong: dongOf(picked.jibun),
              },
          file,
        );
      }}
    >
      <fieldset>
        <legend>주유소</legend>
        {!manual ? (
          <>
            <div className="combo">
              <input
                role="combobox"
                aria-label="주유소 이름"
                aria-expanded={open}
                aria-controls="station-options"
                aria-autocomplete="list"
                aria-activedescendant={active >= 0 ? `opt-${active}` : undefined}
                autoComplete="off"
                placeholder="간판 이름 두 글자 이상 (예: 한빛)"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  if (picked) setPicked(null);
                }}
                onFocus={() => found && !picked && setOpen(true)}
                onBlur={() => window.setTimeout(() => setOpen(false), 150)}
                onKeyDown={(e) => {
                  if (!open || !found?.length) return;
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setActive((a) => Math.min(a + 1, found.length - 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setActive((a) => Math.max(a - 1, 0));
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    if (active >= 0) choose(found[active]);
                  } else if (e.key === 'Escape') setOpen(false);
                }}
              />
              {searching && <span className="combo-spin" aria-label="찾는 중" />}
              {open && found && (
                <ul className="combo-list" id="station-options" role="listbox" aria-label="오피넷 검색 결과">
                  {found.length === 0 ? (
                    <li className="combo-empty">오피넷에서 찾지 못했습니다. 간판 이름 일부만 넣어 보세요.</li>
                  ) : (
                    found.map((f, i) => (
                      <li
                        key={f.id}
                        id={`opt-${i}`}
                        role="option"
                        aria-selected={i === active}
                        aria-disabled={f.taken}
                        className={`${i === active ? 'active' : ''} ${f.taken ? 'taken' : ''}`}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          choose(f);
                        }}
                        onMouseEnter={() => setActive(i)}
                      >
                        <span className="combo-name">
                          {f.name} <span className="brand-name">{f.brand}</span>
                        </span>
                        <span className="combo-addr">{f.taken ? '이미 등록됨 · 그 주유소 관리자에게 초대를 요청하세요' : f.address || f.jibun}</span>
                      </li>
                    ))
                  )}
                </ul>
              )}
            </div>
            {searchMsg && <p className="fine">{searchMsg}</p>}
            {picked && (
              <p className="picked">
                <span>
                  <b>{picked.name}</b> <span className="brand-name">{picked.brand}</span>
                </span>
                <span className="combo-addr">{picked.address || picked.jibun}</span>
              </p>
            )}
            <button type="button" className="link-btn" onClick={() => setManual(true)}>
              오피넷에 없으면 직접 입력
            </button>
          </>
        ) : (
          <>
            <div className="cf-grid">
              <label className="cf-field">
                <span>주유소 이름</span>
                <input required value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="cf-field wide">
                <span>주소</span>
                <input required value={address} onChange={(e) => setAddress(e.target.value)} />
              </label>
            </div>
            <p className="fine">직접 입력하면 가격 비교는 사이트 관리자가 오피넷과 연결한 뒤부터 보입니다.</p>
            <button type="button" className="link-btn" onClick={() => setManual(false)}>
              오피넷에서 찾기로 돌아가기
            </button>
          </>
        )}
      </fieldset>

      <fieldset>
        <legend>임대 중인 주유소인가요?</legend>
        <div className="seg" role="radiogroup" aria-label="임대 여부">
          <button type="button" role="radio" aria-checked={role === 'self'} aria-pressed={role === 'self'} onClick={() => setRole('self')}>
            아니요, 직접 운영
          </button>
          <button type="button" role="radio" aria-checked={role !== 'self'} aria-pressed={role !== 'self'} onClick={() => role === 'self' && setRole('tenant')}>
            네, 임대 중
          </button>
        </div>
        {role !== 'self' && (
          <div className="seg seg-sub" role="radiogroup" aria-label="임대에서 내 쪽">
            <button type="button" role="radio" aria-checked={role === 'tenant'} aria-pressed={role === 'tenant'} onClick={() => setRole('tenant')}>
              빌려서 운영 (임차인)
            </button>
            <button type="button" role="radio" aria-checked={role === 'owner'} aria-pressed={role === 'owner'} onClick={() => setRole('owner')}>
              빌려 줌 (임대인)
            </button>
          </div>
        )}
        <p className="fine">
          {role === 'self'
            ? '신청한 분이 이 주유소의 관리자가 됩니다. 직원이나 가족을 초대해 같이 쓸 수 있고, 나중에 임대하게 되면 주유소 설정에서 바꿀 수 있습니다.'
            : '임대 중이면 계약 일정·임대료 입금 메뉴가 더 생기고, 상대방(임대인 또는 임차인)을 초대해 같은 장부를 나눠 볼 수 있습니다. 매입가·마진 같은 운영 장부는 임차인이 공유할 때만 임대인에게 보입니다.'}
        </p>
      </fieldset>

      <fieldset>
        <legend>사업자 확인</legend>
        <div className="cf-grid">
          <label className="cf-field">
            <span>사업자등록번호</span>
            <input inputMode="numeric" placeholder="000-00-00000" value={digits.length === 10 ? bizNoFmt(digits) : bizNo} onChange={(e) => setBizNo(e.target.value)} />
            <span className="field-hint">{role === 'owner' ? '임대사업자' : '주유소를 운영하는 사업자'} 번호</span>
          </label>
          <label className="cf-field">
            <span>사업자등록증 (사진 또는 PDF, 10MB 이하)</span>
            <input type="file" accept="image/jpeg,image/png,image/webp,image/heic,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
        </div>
        <p className="fine">사업자등록증은 등록 확인에만 쓰고, 신청한 분과 사이트 관리자만 볼 수 있습니다. 심사가 끝나고 30일 뒤 자동으로 지웁니다.</p>
      </fieldset>

      <label className="agree">
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
        <span>
          주유소 정보·사업자등록번호·사업자등록증을 등록 심사에 쓰는 데 동의합니다. (
          <a href="#privacy" target="_blank" rel="noreferrer">
            개인정보처리방침
          </a>
          ,{' '}
          <a href="#terms" target="_blank" rel="noreferrer">
            이용약관
          </a>
          )
        </span>
      </label>

      {formError && (
        <p className="change-note" role="alert">
          {formError}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="primary" disabled={!!busy || !ready}>
          등록 신청
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
