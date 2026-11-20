import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { md } from './data';
import { daysUntil } from './inspections';
import { SUPABASE_URL, supabase, type Profile } from './supabase';
import { Loading } from './Loading';

const BUCKET = 'contract-files';
const MAX_FILE = 30 * 1024 * 1024;

interface ContractEvent {
  id: string;
  contract_id: string;
  kind: '계약 시작' | '만기' | '갱신 통지 마감' | '임대료 인상' | '기타';
  date: string;
  title: string;
  note: string;
  auto: boolean;
}

export type ContractKind = 'lease' | 'supply' | 'rental' | 'service' | 'etc';
export const KIND_KO: Record<ContractKind, string> = {
  lease: '임대차',
  supply: '정유사 공급',
  rental: '렌탈·리스',
  service: '유지보수·보험',
  etc: '기타',
};
/** 계약 종류에 따라 칸 이름을 바꿈 (임대차가 아니면 월세·원상복구 대신 요금·상대 업체) */
const L = (k: ContractKind | undefined) => {
  const lease = (k ?? 'lease') === 'lease';
  return {
    lease,
    party: lease ? '임차인' : '상대 업체',
    deposit: lease ? '보증금' : '보증금·담보',
    monthly: lease ? '월 임대료' : '월 요금',
    due: lease ? '매월 지급일' : '매월 결제일',
    increase: lease ? '임대료 인상' : '요금·단가 인상',
  };
};

interface Contract {
  id: string;
  kind?: ContractKind;
  title: string;
  tenant_name: string;
  start_date: string | null;
  end_date: string | null;
  deposit: number | null;
  monthly_rent: number | null;
  vat_included: boolean | null;
  rent_due_day: number | null;
  auto_renew: boolean | null;
  renewal_notice_days: number | null;
  increase_rate: number | null;
  increase_every_months: number | null;
  next_increase_date: string | null;
  increase_rule: string;
  restoration: string;
  restoration_items: string[];
  quotes: Record<string, string | string[]>;
  file_path: string | null;
  file_name: string | null;
  status: 'draft' | 'confirmed';
  note: string;
  contract_events: ContractEvent[];
}

type Editable = Omit<Contract, 'id' | 'file_path' | 'file_name' | 'status' | 'contract_events'>;
const EDIT_KEYS: Array<keyof Editable> = [
  'kind', 'title', 'tenant_name', 'start_date', 'end_date', 'deposit', 'monthly_rent', 'vat_included', 'rent_due_day', 'auto_renew',
  'renewal_notice_days', 'increase_rate', 'increase_every_months', 'next_increase_date', 'increase_rule', 'restoration',
  'restoration_items', 'quotes', 'note',
];

/**
 * Supabase Storage 경로는 영문·숫자만 허용(한글 파일명은 Invalid key 오류)
 * → 경로는 임의 영문 이름 + 확장자, 원래 파일 이름은 DB 의 file_name 에 보관
 */
const storageName = (name: string) => {
  const ext = (name.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? 'bin').toLowerCase();
  return `${crypto.randomUUID()}.${ext}`;
};
const manWon = (won: number | null) => {
  if (won == null) return '-';
  if (won >= 100_000_000) return `${(won / 100_000_000).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}억원`;
  if (won >= 10_000) return `${(won / 10_000).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}만원`;
  return `${won.toLocaleString('ko-KR')}원`;
};
const dot = (d: string | null) => (d ? d.replaceAll('-', '.') : '미입력');

function dTag(date: string) {
  const d = daysUntil(date);
  const tone = d < 0 ? 'past' : d <= 30 ? 'near' : d <= 90 ? 'soon' : 'far';
  return { text: d < 0 ? `${-d}일 지남` : d === 0 ? 'D-DAY' : `D-${d}`, tone, d };
}

export function ContractSection({ me, stationId, canWrite, selfOperated = false }: { me: Profile; stationId: string; canWrite: boolean; selfOperated?: boolean }) {
  const [contracts, setContracts] = useState<Contract[] | null>(null);
  const [feeds, setFeeds] = useState<Array<{ token: string; created_at: string }>>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);

  const reload = useCallback(async () => {
    const [c, f] = await Promise.all([
      supabase.from('contracts').select('*, contract_events(*)').eq('station_id', stationId).order('created_at', { ascending: false }),
      supabase.from('calendar_feeds').select('token, created_at').eq('station_id', stationId).order('created_at'),
    ]);
    if (c.error) setError(c.error.message);
    else setContracts(c.data as Contract[]);
    setFeeds(f.data ?? []);
  }, [stationId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await fn();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const must = <T,>(r: { error: { message: string } | null; data?: T | null }) => {
    if (r.error) throw new Error(r.error.message);
    return r.data as T;
  };

  /** 계약서 올리기 → 초안 만들기 → AI 추출 → 검토 화면 */
  const upload = (file: File) =>
    run('계약서 올리는 중', async () => {
      if (file.size > MAX_FILE) throw new Error('파일이 30MB 를 넘습니다.');
      const path = `${stationId}/${storageName(file.name)}`;
      const up = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type || undefined });
      if (up.error) throw new Error(up.error.message);
      const created = must<{ id: string }>(
        await supabase
          .from('contracts')
          .insert({ station_id: stationId, kind: selfOperated ? 'etc' : 'lease', title: file.name.replace(/\.[^.]+$/, ''), file_path: path, file_name: file.name })
          .select('id')
          .single(),
      );
      setEditing(created.id);

      setBusy('AI(Gemini)가 계약서를 읽는 중 (30초~1분)');
      const { data, error } = await supabase.functions.invoke('extract-contract', { body: { path } });
      if (error) {
        let msg = error.message;
        try {
          const body = await (error as { context?: Response }).context?.json();
          msg = body?.message ?? body?.error ?? msg;
        } catch {
          /* 본문 없음 */
        }
        setNotice(`AI로 읽지 못해 직접 입력해야 합니다. (${msg})`);
        return;
      }
      const f = (data as { fields: Record<string, unknown> }).fields ?? {};
      const patch: Record<string, unknown> = {};
      for (const k of EDIT_KEYS) {
        if (k === 'quotes' || k === 'note') continue;
        if (f[k] !== undefined && f[k] !== null) patch[k] = f[k];
      }
      if (patch.kind && !Object.keys(KIND_KO).includes(String(patch.kind))) delete patch.kind;
      patch.quotes = { ...((f.quotes as object) ?? {}), _uncertain: (f.uncertain as string[]) ?? [] };
      if (f.notes) patch.note = String(f.notes);
      must(await supabase.from('contracts').update(patch).eq('id', created.id));
      setNotice('AI가 뽑은 내용입니다. 원문 인용과 대조해 확인한 뒤 "확정하고 일정 만들기"를 눌러 주세요. 노란 칸은 AI가 확신하지 못한 항목입니다.');
    });

  if (!contracts) {
    return (
      <section className="block">
        <header className="block-head">
          <h2>계약 일정</h2>
        </header>
        {error ? <p className="change-note">{error}</p> : <Loading />}
      </section>
    );
  }

  const confirmed = contracts.filter((c) => c.status === 'confirmed');
  const upcoming = confirmed
    .flatMap((c) => c.contract_events)
    .filter((e) => daysUntil(e.date) >= -30)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 8);
  const feedUrl = feeds[0] ? `${SUPABASE_URL}/functions/v1/calendar-ics?token=${feeds[0].token}` : '';

  return (
    <section className="block" aria-labelledby="contract-title">
      <header className="block-head">
        <h2 id="contract-title">계약 일정</h2>
        <p className="block-meta">{canWrite ? '계약서를 올리고 확인해서 확정하면 일정이 생깁니다' : '보기 전용'}</p>
      </header>

      {upcoming.length > 0 ? (
        <>
          <p className="readout">
            <b className="price-big">{dTag(upcoming[0].date).text}</b> 다음 일정은 {dot(upcoming[0].date)} {upcoming[0].title}입니다.
          </p>
          <ol className="timeline">
            {upcoming.map((e) => {
              const t = dTag(e.date);
              return (
                <li key={e.id} className={`tl tone-${t.tone}`}>
                  <span className="tl-day">{t.text}</span>
                  <span className="tl-date">{dot(e.date)}</span>
                  <span className="tl-title">
                    {e.title}
                    {e.note && <span className="brand-name">{e.note}</span>}
                  </span>
                </li>
              );
            })}
          </ol>
        </>
      ) : (
        <p className="readout">
          아직 확정한 계약이 없습니다. 임대차, 정유사 공급계약, 세차기·단말기 렌탈, 유지보수·보험처럼 기한이 있는 계약서를 올리면 만기·갱신 통지 마감·인상일이 여기에 생기고 미리 알려 드립니다.
        </p>
      )}

      {canWrite && (
      <div className="upload-row">
        <label className="primary file-btn">
          계약서 올리기 (PDF·사진)
          <input
            type="file"
            accept="application/pdf,image/jpeg,image/png"
            disabled={!!busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) upload(f);
            }}
          />
        </label>
        <button
          type="button"
          className="more"
          disabled={!!busy}
          onClick={() =>
            run('추가하는 중', async () => {
              const created = must<{ id: string }>(await supabase.from('contracts').insert({ station_id: stationId, kind: selfOperated ? 'etc' : 'lease', title: selfOperated ? '' : '주유소 임대차 계약' }).select('id').single());
              setEditing(created.id);
            })
          }
        >
          직접 입력
        </button>
      </div>
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

      <ul className="contract-list">
        {contracts.map((c) => (
          <li key={c.id} className="contract">
            <div className="contract-head">
              <h3 className="insp-name">
                {c.title || '제목 없음'}
                <span className="kind-tag">{KIND_KO[c.kind ?? 'lease']}</span>
                <span className={`status-tag ${c.status}`}>{c.status === 'confirmed' ? '확정' : '검토 전'}</span>
              </h3>
              <p className="insp-meta">
                {c.tenant_name && `${c.tenant_name}, `}
                {dot(c.start_date)} ~ {dot(c.end_date)}
                {c.end_date && `, 만기 ${dTag(c.end_date).text}`}
              </p>
              {(c.deposit != null || c.monthly_rent != null) && (
                <p className="insp-meta">
                  {[c.deposit != null && `${L(c.kind).deposit} ${manWon(c.deposit)}`, c.monthly_rent != null && `월 ${manWon(c.monthly_rent)}`].filter(Boolean).join(', ')}
                  {c.monthly_rent != null && c.vat_included != null && (c.vat_included ? ' (부가세 포함)' : ' (부가세 별도)')}
                  {c.rent_due_day && `, 매월 ${c.rent_due_day}일`}
                </p>
              )}
            </div>
            <div className="form-actions">
              {canWrite && (
                <button type="button" className="more" onClick={() => setEditing(editing === c.id ? null : c.id)}>
                  {c.status === 'draft' ? '검토하기' : '수정'}
                </button>
              )}
              {c.file_path && (
                <button
                  type="button"
                  className="link-btn"
                  onClick={() =>
                    run('계약서 여는 중', async () => {
                      const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(c.file_path!, 300);
                      if (error) throw new Error(error.message);
                      window.open(data.signedUrl, '_blank', 'noopener');
                    })
                  }
                >
                  계약서 원본 보기
                </button>
              )}
            </div>
            {canWrite && editing === c.id && (
              <ContractForm
                contract={c}
                busy={busy}
                onCancel={() => setEditing(null)}
                onDelete={() => {
                  if (!confirm(`"${c.title}" 계약과 일정을 모두 지울까요? 계약서 파일도 지워집니다.`)) return;
                  run('삭제하는 중', async () => {
                    if (c.file_path) await supabase.storage.from(BUCKET).remove([c.file_path]);
                    must(await supabase.from('contracts').delete().eq('id', c.id));
                    setEditing(null);
                  });
                }}
                onSave={(patch, status) =>
                  run(status === 'confirmed' ? '일정 만드는 중' : '저장하는 중', async () => {
                    must(await supabase.from('contracts').update({ ...patch, status }).eq('id', c.id));
                    setEditing(null);
                    if (status === 'confirmed') setNotice('확정했습니다. 만기·갱신 통지 마감·인상일이 일정에 들어갔습니다.');
                  })
                }
                onAddEvent={(ev) =>
                  run('일정 추가하는 중', async () => {
                    must(await supabase.from('contract_events').insert({ ...ev, contract_id: c.id, kind: '기타', auto: false }));
                  })
                }
                onDeleteEvent={(id) =>
                  run('일정 지우는 중', async () => {
                    must(await supabase.from('contract_events').delete().eq('id', id));
                  })
                }
              />
            )}
          </li>
        ))}
      </ul>

      {canWrite && <h3 className="sub-head">캘린더에 넣기</h3>}
      {!canWrite ? null : feedUrl ? (
        <>
          <p className="fine">
            아래 주소를 구글 캘린더에 구독으로 추가하면 확정한 계약 일정과 법정 검사 기한이 자동으로 들어갑니다. 이 주소를 아는 사람은 일정을 볼
            수 있으니 다른 사람에게 보내지 마세요.
          </p>
          <div className="copy-row">
            <input readOnly value={feedUrl} aria-label="캘린더 구독 주소" onFocus={(e) => e.target.select()} />
            <button
              type="button"
              className="primary"
              onClick={async () => {
                await navigator.clipboard.writeText(feedUrl);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? '복사됨' : '주소 복사'}
            </button>
          </div>
          <ol className="steps">
            <li>
              PC에서{' '}
              <a href="https://calendar.google.com/calendar/u/0/r/settings/addbyurl" target="_blank" rel="noreferrer noopener">
                구글 캘린더 → URL로 추가
              </a>
              를 엽니다.
            </li>
            <li>복사한 주소를 붙여 넣고 "캘린더 추가"를 누릅니다. 휴대폰 캘린더 앱에도 같은 계정이면 함께 보입니다.</li>
            <li>구글이 몇 시간마다 다시 읽어 가므로, 여기서 바꾼 일정은 반나절 안에 캘린더에 반영됩니다.</li>
          </ol>
          <button
            type="button"
            className="link-btn danger-inline"
            onClick={() => {
              if (!confirm('구독 주소를 새로 만들까요? 지금 주소로 구독한 캘린더는 더 이상 갱신되지 않습니다.')) return;
              run('주소 바꾸는 중', async () => {
                must(await supabase.from('calendar_feeds').delete().eq('station_id', stationId));
                must(await supabase.from('calendar_feeds').insert({ station_id: stationId, created_by: me.id }));
              });
            }}
          >
            주소가 새어 나갔다면: 새 주소로 바꾸기
          </button>
        </>
      ) : (
        <>
          <p className="fine">구글 캘린더 등에서 구독할 수 있는 비공개 주소를 만듭니다.</p>
          <button
            type="button"
            className="more"
            disabled={!!busy}
            onClick={() =>
              run('주소 만드는 중', async () => {
                must(await supabase.from('calendar_feeds').insert({ station_id: stationId, created_by: me.id }));
              })
            }
          >
            캘린더 구독 주소 만들기
          </button>
        </>
      )}
    </section>
  );
}

// ── 검토·수정 폼 ───────────────────────────────────────────────────
function ContractForm({
  contract,
  busy,
  onSave,
  onCancel,
  onDelete,
  onAddEvent,
  onDeleteEvent,
}: {
  contract: Contract;
  busy: string;
  onSave: (patch: Partial<Editable>, status: 'draft' | 'confirmed') => void;
  onCancel: () => void;
  onDelete: () => void;
  onAddEvent: (ev: { date: string; title: string; note: string }) => void;
  onDeleteEvent: (id: string) => void;
}) {
  const [f, setF] = useState<Editable>(() => Object.fromEntries(EDIT_KEYS.map((k) => [k, contract[k]])) as Editable);
  const [ev, setEv] = useState({ date: '', title: '', note: '' });
  const set = <K extends keyof Editable>(k: K, v: Editable[K]) => setF((x) => ({ ...x, [k]: v }));
  const uncertain = new Set((contract.quotes?._uncertain as string[] | undefined) ?? []);
  const quote = (k: string) => {
    const q = contract.quotes?.[k];
    return typeof q === 'string' ? q : undefined;
  };

  const Field = ({ k, label, children, wide }: { k: keyof Editable; label: string; children: ReactNode; wide?: boolean }) => (
    <div className={`cf-field ${uncertain.has(k) ? 'uncertain' : ''} ${wide ? 'wide' : ''}`}>
      <label>
        {label}
        {children}
      </label>
      {quote(k) && <blockquote className="quote">{quote(k)}</blockquote>}
    </div>
  );
  const num = (v: string) => (v === '' ? null : Number(v.replace(/[^\d.]/g, '')));
  const bool = (v: string) => (v === '' ? null : v === 'true');

  return (
    <form
      className="form boxed contract-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(f, 'confirmed');
      }}
    >
      <fieldset>
        <legend>기본</legend>
        <div className="cf-grid">
          {Field({
            k: 'kind',
            label: '계약 종류',
            children: (
              <select value={f.kind ?? 'lease'} onChange={(e) => set('kind', e.target.value as ContractKind)}>
                {(Object.keys(KIND_KO) as ContractKind[]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_KO[k]}
                  </option>
                ))}
              </select>
            ),
          })}
          {Field({ k: 'title', label: '계약 이름', children: <input value={f.title} onChange={(e) => set('title', e.target.value)} /> })}
          {Field({ k: 'tenant_name', label: L(f.kind).party, children: <input value={f.tenant_name} onChange={(e) => set('tenant_name', e.target.value)} /> })}
          {Field({ k: 'start_date', label: '계약 시작일', children: <input type="date" value={f.start_date ?? ''} onChange={(e) => set('start_date', e.target.value || null)} /> })}
          {Field({ k: 'end_date', label: '만기일', children: <input type="date" value={f.end_date ?? ''} onChange={(e) => set('end_date', e.target.value || null)} /> })}
        </div>
      </fieldset>

      <fieldset>
        <legend>금액</legend>
        <div className="cf-grid">
          {Field({
            k: 'deposit',
            label: `${L(f.kind).deposit} (원)${f.deposit ? ` — ${manWon(f.deposit)}` : ''}`,
            children: <input inputMode="numeric" value={f.deposit ?? ''} onChange={(e) => set('deposit', num(e.target.value))} />,
          })}
          {Field({
            k: 'monthly_rent',
            label: `${L(f.kind).monthly} (원)${f.monthly_rent ? ` — ${manWon(f.monthly_rent)}` : ''}`,
            children: <input inputMode="numeric" value={f.monthly_rent ?? ''} onChange={(e) => set('monthly_rent', num(e.target.value))} />,
          })}
          {Field({
            k: 'vat_included',
            label: '부가세',
            children: (
              <select value={f.vat_included == null ? '' : String(f.vat_included)} onChange={(e) => set('vat_included', bool(e.target.value))}>
                <option value="">모름</option>
                <option value="false">별도</option>
                <option value="true">포함</option>
              </select>
            ),
          })}
          {Field({
            k: 'rent_due_day',
            label: L(f.kind).due,
            children: <input type="number" min={1} max={31} value={f.rent_due_day ?? ''} onChange={(e) => set('rent_due_day', num(e.target.value))} />,
          })}
        </div>
      </fieldset>

      <fieldset>
        <legend>갱신</legend>
        <div className="cf-grid">
          {Field({
            k: 'auto_renew',
            label: '자동 갱신',
            children: (
              <select value={f.auto_renew == null ? '' : String(f.auto_renew)} onChange={(e) => set('auto_renew', bool(e.target.value))}>
                <option value="">모름</option>
                <option value="true">자동 갱신</option>
                <option value="false">자동 갱신 아님</option>
              </select>
            ),
          })}
          {Field({
            k: 'renewal_notice_days',
            label: '만기 며칠 전까지 통지',
            children: (
              <input type="number" min={0} max={730} value={f.renewal_notice_days ?? ''} onChange={(e) => set('renewal_notice_days', num(e.target.value))} />
            ),
          })}
        </div>
      </fieldset>

      <fieldset>
        <legend>{L(f.kind).increase}</legend>
        <div className="cf-grid">
          {Field({ k: 'increase_rate', label: '인상률 (%)', children: <input inputMode="decimal" value={f.increase_rate ?? ''} onChange={(e) => set('increase_rate', num(e.target.value))} /> })}
          {Field({
            k: 'increase_every_months',
            label: '인상 주기 (개월)',
            children: <input type="number" min={1} max={120} value={f.increase_every_months ?? ''} onChange={(e) => set('increase_every_months', num(e.target.value))} />,
          })}
          {Field({
            k: 'next_increase_date',
            label: '다음 인상일',
            children: <input type="date" value={f.next_increase_date ?? ''} onChange={(e) => set('next_increase_date', e.target.value || null)} />,
          })}
          {Field({ k: 'increase_rule', label: '인상 조건', wide: true, children: <input value={f.increase_rule} onChange={(e) => set('increase_rule', e.target.value)} /> })}
        </div>
      </fieldset>

      {L(f.kind).lease && (
      <fieldset>
        <legend>원상복구</legend>
        {Field({ k: 'restoration', label: '원상복구 조항 요약', wide: true, children: <textarea rows={2} value={f.restoration} onChange={(e) => set('restoration', e.target.value)} /> })}
        {Field({
          k: 'restoration_items',
          label: '범위 (쉼표로 구분)',
          wide: true,
          children: (
            <input
              value={f.restoration_items.join(', ')}
              onChange={(e) => set('restoration_items', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
              placeholder="토양정화, 지하탱크 철거, 캐노피 철거"
            />
          ),
        })}
      </fieldset>
      )}

      {Field({ k: 'note', label: '특이 조항·메모', wide: true, children: <textarea rows={3} value={f.note} onChange={(e) => set('note', e.target.value)} /> })}

      <div className="form-actions">
        <button type="submit" className="primary" disabled={!!busy}>
          확정하고 일정 만들기
        </button>
        <button type="button" className="more" disabled={!!busy} onClick={() => onSave(f, 'draft')}>
          검토 전으로 저장
        </button>
        <button type="button" className="more" onClick={onCancel}>
          닫기
        </button>
        <button type="button" className="link-btn danger" disabled={!!busy} onClick={onDelete}>
          계약 삭제
        </button>
      </div>

      {contract.status === 'confirmed' && (
        <fieldset>
          <legend>이 계약의 일정</legend>
          <ul className="insp-history">
            {[...contract.contract_events]
              .sort((a, b) => a.date.localeCompare(b.date))
              .map((e) => (
                <li key={e.id}>
                  {dot(e.date)} {e.title}
                  {e.note && ` — ${e.note}`}
                  {e.auto ? (
                    <span className="brand-name">자동</span>
                  ) : (
                    <button type="button" className="link-btn danger-inline" onClick={() => onDeleteEvent(e.id)}>
                      지우기
                    </button>
                  )}
                </li>
              ))}
          </ul>
          <p className="field-hint">자동 일정은 위 항목을 고치고 다시 확정하면 새로 계산됩니다. 따로 챙길 날짜는 아래에서 추가하세요.</p>
          <div className="cf-grid">
            <label>
              날짜
              <input type="date" value={ev.date} onChange={(e) => setEv({ ...ev, date: e.target.value })} />
            </label>
            <label>
              일정
              <input value={ev.title} onChange={(e) => setEv({ ...ev, title: e.target.value })} placeholder="보증보험 갱신" />
            </label>
          </div>
          <button
            type="button"
            className="more"
            disabled={!ev.date || !ev.title.trim() || !!busy}
            onClick={() => {
              onAddEvent({ date: ev.date, title: ev.title.trim(), note: ev.note });
              setEv({ date: '', title: '', note: '' });
            }}
          >
            일정 추가
          </button>
        </fieldset>
      )}
    </form>
  );
}
