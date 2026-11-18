import { useCallback, useEffect, useState } from 'react';
import { md } from './data';
import { todayKst } from './fuel';
import { cadenceText, currentPeriod, WEEKDAY_KO, type Routine } from './routines';
import { supabase } from './supabase';

const PRESETS: Array<{ title: string; cadence: Routine['cadence']; due_day?: number; note: string }> = [
  { title: '석유 수급상황 주간보고', cadence: 'weekly', note: '한국석유관리원에 지난주 입·출하 내역 보고. 마감 요일은 석유관리원 안내에 맞춰 고르세요' },
  { title: '카드 매출 입금 확인', cadence: 'weekly', note: '일 마감 표에서 카드 입금 적기' },
  { title: '원천세·4대보험 납부', cadence: 'monthly', due_day: 10, note: '직원이 있을 때' },
  { title: '임대료 보내기', cadence: 'monthly', note: '계약서의 지급일에 맞춰 고르세요' },
  { title: '직원 급여 지급', cadence: 'monthly', note: '' },
];

/** 유류 장부 4) 반복 할 일 */
export function FuelRoutines({ sid, canWrite, onError }: { sid: string; canWrite: boolean; onError: (m: string) => void }) {
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [manage, setManage] = useState(false);
  const [busy, setBusy] = useState(false);
  const today = todayKst();

  const reload = useCallback(async () => {
    const [r, c] = await Promise.all([
      supabase.from('routines').select('id,title,cadence,due_day,note,active').eq('station_id', sid).eq('active', true).order('cadence', { ascending: false }).order('due_day'),
      supabase.from('routine_checks').select('routine_id,period').eq('station_id', sid).gte('done_at', new Date(Date.now() - 40 * 86_400_000).toISOString()),
    ]);
    if (r.error) onError(r.error.message);
    setRoutines((r.data as Routine[]) ?? []);
    setDone(new Set(((c.data ?? []) as Array<{ routine_id: string; period: string }>).map((x) => `${x.routine_id}|${x.period}`)));
  }, [sid, onError]);
  useEffect(() => {
    reload();
  }, [reload]);

  const act = async (fn: () => PromiseLike<{ error: { message: string } | null }>) => {
    setBusy(true);
    onError('');
    const { error } = await fn();
    setBusy(false);
    if (error) onError(error.message);
    await reload();
  };

  if (!routines) return null;
  const rows = routines
    .map((r) => ({ r, ...currentPeriod(r, today) }))
    .map((x) => ({ ...x, checked: done.has(`${x.r.id}|${x.period}`) }))
    .sort((a, b) => Number(a.checked) - Number(b.checked) || a.daysLeft - b.daysLeft);
  const open = rows.filter((x) => !x.checked);

  return (
    <>
      <h3 className="sub-head">이번 주·이번 달 할 일</h3>
      {routines.length === 0 ? (
        <p className="note">매주·매달 돌아오는 신고와 납부를 등록해 두면, 기한이 오기 전에 여기와 텔레그램으로 알려 드립니다.</p>
      ) : (
        <ul className="routine-list">
          {rows.map(({ r, period, due, daysLeft, checked }) => (
            <li key={r.id} className={checked ? 'done' : daysLeft < 0 ? 'late' : daysLeft <= 1 ? 'soon' : ''}>
              <label>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!canWrite || busy}
                  onChange={(e) =>
                    act(() =>
                      e.target.checked
                        ? supabase.from('routine_checks').insert({ routine_id: r.id, period, station_id: sid })
                        : supabase.from('routine_checks').delete().eq('routine_id', r.id).eq('period', period),
                    )
                  }
                />
                <span>
                  <b>{r.title}</b>
                  <span className="routine-meta">
                    {cadenceText(r)}, 이번 기한 {md(due)}
                    {r.note && ` · ${r.note}`}
                  </span>
                </span>
              </label>
              <span className={`status-tag ${checked ? '' : daysLeft < 0 ? 'late' : daysLeft <= 1 ? 'draft' : 'soft'}`}>
                {checked ? '했음' : daysLeft < 0 ? `${-daysLeft}일 지남` : daysLeft === 0 ? '오늘까지' : `D-${daysLeft}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {routines.length > 0 && open.length === 0 && <p className="fine">이번 주기의 할 일을 모두 했습니다.</p>}

      {canWrite &&
        (manage ? (
          <ManageRoutines
            routines={routines}
            busy={busy}
            onClose={() => setManage(false)}
            onAdd={(row) => act(() => supabase.from('routines').insert({ ...row, station_id: sid }))}
            onRemove={(id) => act(() => supabase.from('routines').delete().eq('id', id))}
          />
        ) : (
          <button type="button" className="more" onClick={() => setManage(true)}>
            할 일 추가·정리
          </button>
        ))}
    </>
  );
}

function ManageRoutines({
  routines,
  busy,
  onClose,
  onAdd,
  onRemove,
}: {
  routines: Routine[];
  busy: boolean;
  onClose: () => void;
  onAdd: (row: { title: string; cadence: Routine['cadence']; due_day: number; note: string }) => void;
  onRemove: (id: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [cadence, setCadence] = useState<Routine['cadence']>('weekly');
  const [day, setDay] = useState('');
  const [note, setNote] = useState('');
  const d = Number(day);
  const ok = title.trim() && day !== '' && (cadence === 'weekly' ? d >= 0 && d <= 6 : d >= 1 && d <= 31);
  const left = PRESETS.filter((p) => !routines.some((r) => r.title === p.title));
  return (
    <div className="form boxed">
      {left.length > 0 && (
        <>
          <p className="fine">자주 쓰는 할 일을 누르면 아래 칸에 채워집니다. 기한 요일·날짜를 확인하고 추가하세요.</p>
          <div className="chip-row">
            {left.map((p) => (
              <button
                key={p.title}
                type="button"
                className="more"
                onClick={() => {
                  setTitle(p.title);
                  setCadence(p.cadence);
                  setDay(p.due_day != null ? String(p.due_day) : '');
                  setNote(p.note);
                }}
              >
                {p.title}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="cf-grid">
        <label className="cf-field wide">
          <span>할 일</span>
          <input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="cf-field">
          <span>주기</span>
          <select
            value={cadence}
            onChange={(e) => {
              setCadence(e.target.value as Routine['cadence']);
              setDay('');
            }}
          >
            <option value="weekly">매주</option>
            <option value="monthly">매달</option>
          </select>
        </label>
        <label className="cf-field">
          <span>{cadence === 'weekly' ? '마감 요일' : '마감일'}</span>
          <select value={day} onChange={(e) => setDay(e.target.value)}>
            <option value="">고르기</option>
            {cadence === 'weekly'
              ? [1, 2, 3, 4, 5, 6, 0].map((w) => (
                  <option key={w} value={w}>
                    {WEEKDAY_KO[w]}요일
                  </option>
                ))
              : Array.from({ length: 31 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}일
                  </option>
                ))}
          </select>
        </label>
        <label className="cf-field wide">
          <span>메모 (선택)</span>
          <input value={note} maxLength={120} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      <div className="form-actions">
        <button
          type="button"
          className="primary"
          disabled={busy || !ok}
          onClick={() => {
            onAdd({ title: title.trim(), cadence, due_day: d, note: note.trim() });
            setTitle('');
            setDay('');
            setNote('');
          }}
        >
          추가
        </button>
        <button type="button" className="more" onClick={onClose}>
          닫기
        </button>
      </div>
      {routines.length > 0 && (
        <ul className="routine-manage">
          {routines.map((r) => (
            <li key={r.id}>
              <span>
                {r.title} <span className="brand-name">{cadenceText(r)}</span>
              </span>
              <button
                type="button"
                className="link-btn danger-inline"
                disabled={busy}
                onClick={() => confirm(`"${r.title}"을(를) 지울까요? 체크 기록도 같이 지워집니다.`) && onRemove(r.id)}
              >
                지우기
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
