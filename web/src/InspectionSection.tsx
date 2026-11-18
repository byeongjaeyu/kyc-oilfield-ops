import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { md } from './data';
import {
  addMonths,
  BUCKET,
  daysUntil,
  lastResult,
  todayKst,
  type Inspection,
  type InspectionResult,
  type Party,
  type Verdict,
} from './inspections';
import { supabase, type Profile } from './supabase';
import { Loading } from './Loading';

const MAX_FILE = 15 * 1024 * 1024;

function dLabel(due: string | null) {
  if (!due) return { text: '기한 없음', tone: 'none' as const };
  const d = daysUntil(due);
  if (d < 0) return { text: `${-d}일 지남`, tone: 'over' as const };
  if (d === 0) return { text: 'D-DAY', tone: 'over' as const };
  return { text: `D-${d}`, tone: d <= 7 ? ('near' as const) : d <= 30 ? ('soon' as const) : ('far' as const) };
}

/**
 * Supabase Storage 경로는 영문·숫자만 허용(한글 파일명은 Invalid key 오류)
 * → 경로는 임의 영문 이름 + 확장자, 원래 파일 이름은 DB 의 file_name 에 보관
 */
const storageName = (name: string) => {
  const ext = (name.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? 'bin').toLowerCase();
  return `${crypto.randomUUID()}.${ext}`;
};

export function InspectionSection({ me, stationId, canWrite }: { me: Profile; stationId: string; canWrite: boolean }) {
  const isOwner = canWrite;
  const [items, setItems] = useState<Inspection[] | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [recording, setRecording] = useState<string | null>(null);
  const [history, setHistory] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const { data, error } = await supabase
      .from('inspections')
      .select('*, inspection_results(*)')
      .eq('station_id', stationId)
      .order('due', { ascending: true, nullsFirst: false })
      .order('name');
    if (error) setError(error.message);
    else setItems(data as Inspection[]);
  }, [stationId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError('');
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

  const openFile = (r: InspectionResult) =>
    run('결과지 여는 중', async () => {
      const { data, error } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(r.file_path!, 120, { download: r.file_name ?? true });
      if (error) throw new Error(error.message);
      window.location.assign(data.signedUrl);
    });

  if (!items) {
    return (
      <section className="block">
        <header className="block-head">
          <h2>법정 검사</h2>
        </header>
        {error ? <p className="change-note">{error}</p> : <Loading />}
      </section>
    );
  }

  const next = items.find((i) => i.due);
  const missing = items.filter((i) => !i.due).length;

  return (
    <section className="block" aria-labelledby="insp-title">
      <header className="block-head">
        <h2 id="insp-title">법정 검사</h2>
        <p className="block-meta">{canWrite ? '기한·주기는 결과지나 통지서 기준으로' : '보기 + 결과지 올리기'}</p>
      </header>

      <p className="readout">
        {next ? (
          <>
            <b className="price-big">{dLabel(next.due).text}</b> 가장 가까운 기한은 {next.name}({md(next.due!)})입니다.
          </>
        ) : (
          <>아직 기한이 들어간 항목이 없습니다.{isOwner && ' 각 항목의 수정에서 다음 기한을 넣어 주세요.'}</>
        )}{' '}
        {next && missing > 0 && <>기한이 비어 있는 항목이 {missing}개 있습니다.</>}
      </p>

      <ol className="insp-list">
        {items.map((it) => {
          const d = dLabel(it.due);
          const last = lastResult(it);
          return (
            <li key={it.id} className={`insp tone-${d.tone}`}>
              <div className="insp-day" aria-hidden>
                {d.text}
              </div>
              <div className="insp-body">
                <h3 className="insp-name">
                  {it.name}
                  {it.party && <span className="brand-name">{it.party} 담당</span>}
                </h3>
                <p className="insp-meta">
                  <span className="sr-only">{d.text}, </span>
                  {it.due ? `기한 ${it.due.replaceAll('-', '.')}` : '기한 미입력'}
                  {it.cycle_months ? `, ${it.cycle_months}개월마다` : ''}
                  {it.agency ? `, ${it.agency}` : ''}
                </p>
                {last && (
                  <p className={`insp-last ${last.verdict === '부적합' ? 'bad' : ''}`}>
                    최근 결과 {md(last.done_on)} {last.verdict || '기록'}
                    {last.note && <> — {last.note}</>}
                    {last.file_path && (
                      <button type="button" className="link-btn" onClick={() => openFile(last)}>
                        결과지 받기
                      </button>
                    )}
                  </p>
                )}
                {it.note && <p className="insp-note">{it.note}</p>}

                <div className="form-actions">
                  <button type="button" className="more" onClick={() => setRecording(recording === it.id ? null : it.id)}>
                    결과 등록
                  </button>
                  {isOwner && (
                    <button type="button" className="more" onClick={() => setEditing(editing === it.id ? null : it.id)}>
                      수정
                    </button>
                  )}
                  {it.inspection_results.length > 0 && (
                    <button
                      type="button"
                      className="link-btn"
                      aria-expanded={history === it.id}
                      onClick={() => setHistory(history === it.id ? null : it.id)}
                    >
                      결과 기록 {it.inspection_results.length}건
                    </button>
                  )}
                </div>

                {history === it.id && (
                  <ul className="insp-history">
                    {[...it.inspection_results]
                      .sort((a, b) => b.done_on.localeCompare(a.done_on))
                      .map((r) => (
                        <li key={r.id}>
                          {r.done_on.replaceAll('-', '.')} {r.verdict || '기록'}
                          {r.note && <> — {r.note}</>}
                          {r.file_path && (
                            <button type="button" className="link-btn" onClick={() => openFile(r)}>
                              결과지
                            </button>
                          )}
                          {(isOwner || r.created_by === me.id) && (
                            <button
                              type="button"
                              className="link-btn danger-inline"
                              onClick={() => {
                                if (!confirm('이 결과 기록을 지울까요?')) return;
                                run('지우는 중', async () => {
                                  must(await supabase.from('inspection_results').delete().eq('id', r.id));
                                  if (r.file_path && isOwner) await supabase.storage.from(BUCKET).remove([r.file_path]);
                                });
                              }}
                            >
                              지우기
                            </button>
                          )}
                        </li>
                      ))}
                  </ul>
                )}

                {isOwner && editing === it.id && (
                  <EditForm
                    item={it}
                    busy={busy}
                    onCancel={() => setEditing(null)}
                    onDelete={() => {
                      if (!confirm(`"${it.name}" 항목을 지울까요? 등록한 결과 기록도 함께 지워집니다.`)) return;
                      run('삭제하는 중', async () => {
                        const paths = it.inspection_results.map((r) => r.file_path).filter((p): p is string => !!p);
                        if (paths.length) await supabase.storage.from(BUCKET).remove(paths);
                        must(await supabase.from('inspections').delete().eq('id', it.id));
                        setEditing(null);
                      });
                    }}
                    onSubmit={(patch) =>
                      run('저장하는 중', async () => {
                        must(await supabase.from('inspections').update(patch).eq('id', it.id));
                        setEditing(null);
                      })
                    }
                  />
                )}
                {recording === it.id && (
                  <ResultForm
                    item={it}
                    busy={busy}
                    onCancel={() => setRecording(null)}
                    onSubmit={(r, file) =>
                      run('결과 저장하는 중', async () => {
                        let fileFields = {};
                        if (file) {
                          const path = `${stationId}/${storageName(file.name)}`;
                          const up = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type || undefined });
                          if (up.error) throw new Error(up.error.message);
                          fileFields = { file_path: path, file_name: file.name, file_type: file.type, file_size: file.size };
                        }
                        must(await supabase.from('inspection_results').insert({ inspection_id: it.id, created_by: me.id, ...r, ...fileFields }));
                        setRecording(null);
                      })
                    }
                  />
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {isOwner && (
        <button
          type="button"
          className="more"
          disabled={!!busy}
          onClick={() =>
            run('추가하는 중', async () => {
              const created = must<{ id: string }>(await supabase.from('inspections').insert({ station_id: stationId, name: '새 항목' }).select('id').single());
              setEditing(created.id);
            })
          }
        >
          항목 추가
        </button>
      )}

      {busy && (
        <p className="note" role="status">
          {busy}…
        </p>
      )}
      {error && (
        <p className="change-note" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

type Patch = Pick<Inspection, 'name' | 'due' | 'cycle_months' | 'party' | 'agency' | 'note'>;

function EditForm({
  item,
  busy,
  onSubmit,
  onCancel,
  onDelete,
}: {
  item: Inspection;
  busy: string;
  onSubmit: (p: Patch) => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const [f, setF] = useState<Patch>({
    name: item.name,
    due: item.due,
    cycle_months: item.cycle_months,
    party: item.party,
    agency: item.agency,
    note: item.note,
  });
  const set = <K extends keyof Patch>(k: K, v: Patch[K]) => setF((x) => ({ ...x, [k]: v }));
  return (
    <form
      className="form boxed"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit({ ...f, name: f.name.trim() || item.name });
      }}
    >
      <label>
        이름
        <input value={f.name} onChange={(e) => set('name', e.target.value)} />
      </label>
      <div className="form-row">
        <label>
          다음 기한
          <input type="date" value={f.due ?? ''} onChange={(e) => set('due', e.target.value || null)} />
        </label>
        <label>
          주기 (개월)
          <input
            type="number"
            min={1}
            max={120}
            inputMode="numeric"
            value={f.cycle_months ?? ''}
            onChange={(e) => set('cycle_months', e.target.value ? Number(e.target.value) : null)}
          />
        </label>
        <label>
          담당
          <select value={f.party} onChange={(e) => set('party', e.target.value as Party)}>
            <option value="">미정</option>
            <option value="임차인">임차인</option>
            <option value="임대인">임대인</option>
          </select>
        </label>
      </div>
      <p className="field-hint">
        주기는 결과지나 관할 기관 통지서 기준으로 넣으세요. 결과가 등록되면 다음 기한이 그만큼 자동으로 밀립니다. 담당이 임차인인
        항목만 임차인 계정에 보입니다.
      </p>
      <label>
        검사기관 / 보험사
        <input value={f.agency} onChange={(e) => set('agency', e.target.value)} />
      </label>
      <label>
        메모
        <textarea rows={2} value={f.note} onChange={(e) => set('note', e.target.value)} />
      </label>
      <div className="form-actions">
        <button type="submit" className="primary" disabled={!!busy}>
          저장
        </button>
        <button type="button" className="more" onClick={onCancel}>
          취소
        </button>
        <button type="button" className="link-btn danger" disabled={!!busy} onClick={onDelete}>
          항목 삭제
        </button>
      </div>
    </form>
  );
}

function ResultForm({
  item,
  busy,
  onSubmit,
  onCancel,
}: {
  item: Inspection;
  busy: string;
  onSubmit: (r: { done_on: string; verdict: Verdict; note: string }, file: File | null) => void;
  onCancel: () => void;
}) {
  const [date, setDate] = useState(todayKst());
  const [verdict, setVerdict] = useState<Verdict>('적합');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const tooBig = !!file && file.size > MAX_FILE;
  const nextDue = item.cycle_months ? addMonths(date, item.cycle_months) : null;
  return (
    <form
      className="form boxed"
      onSubmit={(e) => {
        e.preventDefault();
        if (!tooBig) onSubmit({ done_on: date, verdict, note: note.trim() }, file);
      }}
    >
      <div className="form-row">
        <label>
          검사·갱신일
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </label>
        <label>
          결과
          <select value={verdict} onChange={(e) => setVerdict(e.target.value as Verdict)}>
            <option value="적합">적합</option>
            <option value="부적합">부적합</option>
            <option value="완료">완료 (보험 갱신 등)</option>
          </select>
        </label>
      </div>
      <label>
        결과지 (PDF·사진, 15MB 이하)
        <input type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      {tooBig && <p className="field-hint">파일이 15MB 를 넘습니다. 스캔 해상도를 낮춰 다시 올려 주세요.</p>}
      <label>
        메모
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="검사 기관, 지적 사항 등" />
      </label>
      <p className="field-hint">
        {nextDue
          ? `저장하면 다음 기한이 ${nextDue.replaceAll('-', '.')}(${item.cycle_months}개월 뒤)로 바뀝니다.`
          : '이 항목은 주기가 없어 다음 기한이 자동으로 바뀌지 않습니다.'}
      </p>
      <div className="form-actions">
        <button type="submit" className="primary" disabled={!!busy || tooBig}>
          결과 저장
        </button>
        <button type="button" className="more" onClick={onCancel}>
          취소
        </button>
      </div>
    </form>
  );
}
