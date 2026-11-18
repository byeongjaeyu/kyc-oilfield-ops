import { useState } from 'react';
import { md, won } from './data';
import { FUEL_KO, FUELS, todayKst, type FuelKind } from './fuel';
import { supabase } from './supabase';

export interface Close {
  close_on: string;
  gasoline_l: number | null;
  diesel_l: number | null;
  premium_l: number | null;
  kerosene_l: number | null;
  card_sales: number;
  cash_sales: number;
  other_sales: number;
  card_deposit: number | null;
  note: string;
}

const num = (v: number | string | null | undefined) => Number(v ?? 0);
const lit = (c: Close, f: FuelKind) => c[`${f}_l` as keyof Close] as number | null;
const DAY = 86_400_000;
/** 카드 매출은 보통 영업일 2~3일 뒤 들어옴. 주말을 넉넉히 잡아 5일 지나면 확인하라고 알림 */
const DEPOSIT_LATE_DAYS = 5;
const daysAgo = (date: string) => Math.floor((Date.parse(`${todayKst()}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / DAY);

/** 유류 장부 3) 일 마감 */
export function FuelClose({
  sid,
  canWrite,
  closes,
  fuels,
  feePct,
  margins,
  onChanged,
  onError,
  onNotice,
}: {
  sid: string;
  canWrite: boolean;
  closes: Close[];
  /** 적을 유종 (탱크를 등록한 유종, 없으면 휘발유·경유) */
  fuels: FuelKind[];
  feePct: number;
  /** 지금 L당 마진 (이번 달 추정에 씀) */
  margins: Partial<Record<FuelKind, number>>;
  onChanged: () => Promise<void>;
  onError: (m: string) => void;
  onNotice: (m: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deposit, setDeposit] = useState<{ date: string; value: string } | null>(null);

  const act = async (fn: () => PromiseLike<{ error: { message: string } | null }>, done: string) => {
    setBusy(true);
    onError('');
    const { error } = await fn();
    setBusy(false);
    if (error) return onError(error.message);
    onNotice(done);
    setEditing(null);
    setDeposit(null);
    await onChanged();
  };

  const today = todayKst();
  const month = today.slice(0, 7);
  const thisMonth = closes.filter((c) => c.close_on.startsWith(month));
  const sumL = (f: FuelKind) => thisMonth.reduce((s, c) => s + num(lit(c, f)), 0);
  const totalL = fuels.reduce((s, f) => s + sumL(f), 0);
  const revenue = thisMonth.reduce((s, c) => s + num(c.card_sales) + num(c.cash_sales) + num(c.other_sales), 0);
  const marginFuels = fuels.filter((f) => margins[f] != null && sumL(f) > 0);
  const marginSum = marginFuels.reduce((s, f) => s + sumL(f) * margins[f]!, 0);
  const expected = (c: Close) => Math.round(num(c.card_sales) * (1 - feePct / 100));
  const waiting = closes.filter((c) => num(c.card_sales) > 0 && c.card_deposit == null);
  const late = waiting.filter((c) => daysAgo(c.close_on) >= DEPOSIT_LATE_DAYS);
  const todayDone = closes.some((c) => c.close_on === today);

  return (
    <>
      <h3 className="sub-head">일 마감</h3>
      {thisMonth.length > 0 && (
        <dl className="sim-out close-sum">
          <div>
            <dt>이번 달 판매량 ({thisMonth.length}일 마감)</dt>
            <dd>
              <b>{Math.round(totalL).toLocaleString('ko-KR')}L</b>
              <span className="sim-was">하루 평균 {Math.round(totalL / thisMonth.length).toLocaleString('ko-KR')}L</span>
            </dd>
          </div>
          <div>
            <dt>이번 달 매출</dt>
            <dd>
              <b>{won(revenue)}</b>
            </dd>
          </div>
          {marginFuels.length > 0 && (
            <div>
              <dt>유류 마진 추정</dt>
              <dd>
                <b className={marginSum < 0 ? 'alert-text' : ''}>{won(Math.round(marginSum))}</b>
                <span className="sim-was">판매량 × 지금 L당 마진 ({marginFuels.map((f) => FUEL_KO[f]).join('·')})</span>
              </dd>
            </div>
          )}
        </dl>
      )}
      {late.length > 0 && (
        <p className="change-note">
          카드 매출이 들어왔는지 확인하지 않은 날이 {late.length}일 있습니다 ({late.slice(0, 4).map((c) => md(c.close_on)).join(', ')}
          {late.length > 4 ? ' 등' : ''}). 통장에서 카드사 입금을 확인하고 아래 표에 적어 주세요.
        </p>
      )}

      {canWrite &&
        (editing ? (
          <CloseForm
            key={editing}
            date={editing}
            fuels={fuels}
            initial={closes.find((c) => c.close_on === editing)}
            busy={busy}
            onCancel={() => setEditing(null)}
            onSave={(row) => act(() => supabase.from('daily_closes').upsert({ ...row, station_id: sid }), `${md(row.close_on)} 마감을 저장했습니다.`)}
          />
        ) : (
          <div className="sup-actions">
            <button type="button" className="primary" onClick={() => setEditing(today)}>
              {todayDone ? '오늘 마감 고치기' : '오늘 마감 넣기'}
            </button>
            <label className="date-pick">
              <span>다른 날</span>
              <input type="date" max={today} onChange={(e) => e.target.value && setEditing(e.target.value)} />
            </label>
          </div>
        ))}

      {closes.length === 0 ? (
        <p className="note">하루 영업이 끝나면 유종별 판매량과 카드·현금 매출을 넣으세요. 판매량은 재고 추정과 발주 시점 계산에도 쓰입니다.</p>
      ) : (
        <div className="table-scroll">
          <table className="price-table nowrap">
            <caption className="sr-only">일 마감 기록, 최근 순</caption>
            <thead>
              <tr>
                <th scope="col">날짜</th>
                {fuels.map((f) => (
                  <th scope="col" className="num" key={f}>
                    {FUEL_KO[f]}
                  </th>
                ))}
                <th scope="col" className="num">카드</th>
                <th scope="col" className="num">현금·기타</th>
                <th scope="col">카드 입금</th>
              </tr>
            </thead>
            <tbody>
              {closes.slice(0, 21).map((c) => {
                const exp = expected(c);
                const diff = c.card_deposit == null ? null : num(c.card_deposit) - exp;
                return (
                  <tr key={c.close_on}>
                    <th scope="row">
                      {canWrite ? (
                        <button type="button" className="link-btn" onClick={() => setEditing(c.close_on)}>
                          {md(c.close_on)}
                        </button>
                      ) : (
                        md(c.close_on)
                      )}
                    </th>
                    {fuels.map((f) => (
                      <td className="num" key={f}>
                        {lit(c, f) == null ? '' : `${num(lit(c, f)).toLocaleString('ko-KR')}L`}
                      </td>
                    ))}
                    <td className="num">{num(c.card_sales).toLocaleString('ko-KR')}</td>
                    <td className="num">{(num(c.cash_sales) + num(c.other_sales)).toLocaleString('ko-KR')}</td>
                    <td>
                      {num(c.card_sales) === 0 ? (
                        ''
                      ) : deposit?.date === c.close_on ? (
                        <span className="copy-row deposit-row">
                          <input
                            inputMode="numeric"
                            aria-label={`${md(c.close_on)} 카드 입금액`}
                            value={deposit.value}
                            onChange={(e) => setDeposit({ date: c.close_on, value: e.target.value.replace(/\D/g, '') })}
                          />
                          <button
                            type="button"
                            className="primary"
                            disabled={busy || deposit.value === ''}
                            onClick={() =>
                              act(
                                () => supabase.from('daily_closes').update({ card_deposit: Number(deposit.value) }).eq('station_id', sid).eq('close_on', c.close_on),
                                `${md(c.close_on)} 카드 입금을 기록했습니다.`,
                              )
                            }
                          >
                            저장
                          </button>
                        </span>
                      ) : c.card_deposit == null ? (
                        canWrite ? (
                          <button type="button" className="link-btn" onClick={() => setDeposit({ date: c.close_on, value: String(exp) })}>
                            {daysAgo(c.close_on) >= DEPOSIT_LATE_DAYS ? '확인 필요' : '입금 적기'}
                          </button>
                        ) : (
                          '확인 전'
                        )
                      ) : Math.abs(diff!) <= Math.max(100, exp * 0.002) ? (
                        <span className="status-tag">맞음</span>
                      ) : (
                        <span className="status-tag draft" title={`예상 ${won(exp)}, 입금 ${won(num(c.card_deposit))}`}>
                          {diff! > 0 ? '+' : '−'}
                          {Math.abs(diff!).toLocaleString('ko-KR')}원
                        </span>
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
        카드 입금 예상액은 카드 매출에서 수수료 {feePct}%를 뺀 값입니다. 실제 입금이 예상과 0.2% 넘게 다르면 차액을 표시합니다. 날짜를 누르면 그날 마감을 고칠
        수 있습니다.
      </p>
    </>
  );
}

function CloseForm({
  date,
  fuels,
  initial,
  busy,
  onCancel,
  onSave,
}: {
  date: string;
  fuels: FuelKind[];
  initial?: Close;
  busy: boolean;
  onCancel: () => void;
  onSave: (row: Record<string, unknown> & { close_on: string }) => void;
}) {
  const s = (v: number | null | undefined) => (v == null ? '' : String(num(v)));
  const [l, setL] = useState<Record<FuelKind, string>>(
    () => Object.fromEntries(FUELS.map((f) => [f, s(initial ? lit(initial, f) : null)])) as Record<FuelKind, string>,
  );
  const [card, setCard] = useState(s(initial?.card_sales));
  const [cash, setCash] = useState(s(initial?.cash_sales));
  const [other, setOther] = useState(s(initial?.other_sales));
  const [note, setNote] = useState(initial?.note ?? '');
  const any = fuels.some((f) => l[f] !== '') || card !== '' || cash !== '';
  const digits = (v: string) => v.replace(/\D/g, '');
  return (
    <form
      className="form boxed"
      onSubmit={(e) => {
        e.preventDefault();
        if (!any) return;
        onSave({
          close_on: date,
          ...Object.fromEntries(FUELS.map((f) => [`${f}_l`, l[f] === '' ? null : Number(l[f])])),
          card_sales: Number(card) || 0,
          cash_sales: Number(cash) || 0,
          other_sales: Number(other) || 0,
          note: note.trim(),
        });
      }}
    >
      <p className="insp-name">{md(date)} 마감</p>
      <fieldset>
        <legend>판매량 (L)</legend>
        <div className="cf-grid">
          {fuels.map((f) => (
            <label className="cf-field" key={f}>
              <span>{FUEL_KO[f]}</span>
              <input inputMode="decimal" value={l[f]} onChange={(e) => setL({ ...l, [f]: e.target.value.replace(/[^\d.]/g, '') })} />
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>매출 (원)</legend>
        <div className="cf-grid">
          <label className="cf-field">
            <span>카드</span>
            <input inputMode="numeric" value={card} onChange={(e) => setCard(digits(e.target.value))} />
          </label>
          <label className="cf-field">
            <span>현금</span>
            <input inputMode="numeric" value={cash} onChange={(e) => setCash(digits(e.target.value))} />
          </label>
          <label className="cf-field">
            <span>외상·상품권 등</span>
            <input inputMode="numeric" value={other} onChange={(e) => setOther(digits(e.target.value))} />
          </label>
          <label className="cf-field wide">
            <span>메모 (선택)</span>
            <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
      </fieldset>
      <div className="form-actions">
        <button type="submit" className="primary" disabled={busy || !any}>
          마감 저장
        </button>
        <button type="button" className="more" onClick={onCancel}>
          취소
        </button>
      </div>
    </form>
  );
}
