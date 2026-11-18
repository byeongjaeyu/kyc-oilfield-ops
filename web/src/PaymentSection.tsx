import { useCallback, useEffect, useMemo, useState } from 'react';
import { dedupeKey, parseBankSms, parseStatement, payerMatches, type ParsedTx } from '../../supabase/functions/bank-notify/bankParse';
import { daysUntil, todayKst } from './inspections';
import { SUPABASE_URL, supabase, type Profile } from './supabase';
import { Loading } from './Loading';

type Status = '초과' | '완납' | '부분' | '미납' | '예정';

interface Charge {
  id: string;
  contract_id: string;
  contract_title: string;
  period: string; // YYYY-MM
  due_date: string;
  expected_amount: number;
  manual: boolean;
  note: string;
  paid_amount: number;
  payment_count: number;
  last_paid_at: string | null;
  status: Status;
}

interface Tx {
  id: string;
  occurred_at: string;
  amount: number;
  payer: string;
  memo: string;
  source: 'excel' | 'sms' | 'manual';
  charge_id: string | null;
}

interface PayContract {
  id: string;
  title: string;
  tenant_name: string;
  payer_names: string[];
  payments_tracked_from: string | null;
}

const SOURCE_KO: Record<Tx['source'], string> = { excel: '통장 내역', sms: '입금 문자', manual: '직접 입력' };

const won = (n: number) => `${n.toLocaleString('ko-KR')}원`;
const dot = (d: string) => d.slice(0, 10).replaceAll('-', '.');
const kstDate = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
const kstTime = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3_600_000).toISOString().slice(11, 16);
const monthKo = (period: string) => `${period.slice(0, 4)}년 ${Number(period.slice(5))}월`;

/** 상태 → 표시 문구와 색 (색만으로 구분하지 않도록 항상 글자와 함께) */
function badge(c: Charge, today = todayKst()) {
  const d = daysUntil(c.due_date, today);
  const left = c.expected_amount - c.paid_amount;
  switch (c.status) {
    case '완납':
      return { text: '완납', tone: 'far' };
    case '초과':
      return { text: '초과 입금', tone: 'soon' };
    case '부분':
      return d < 0 ? { text: `${won(left)} 미납`, tone: 'near' } : { text: '일부 입금', tone: 'soon' };
    case '미납':
      return { text: `미납 ${-d}일`, tone: 'over' };
    default:
      return { text: d === 0 ? '오늘 납기' : `D-${d}`, tone: 'none' };
  }
}

const overdue = (c: Charge, today = todayKst()) =>
  (c.status === '미납' || c.status === '부분') && c.due_date < today;

export function PaymentSection({
  me,
  stationId,
  canWrite,
  canEditContracts,
}: {
  me: Profile;
  stationId: string;
  canWrite: boolean;
  canEditContracts: boolean;
}) {
  const [charges, setCharges] = useState<Charge[] | null>(null);
  const [txs, setTxs] = useState<Tx[]>([]);
  const [contracts, setContracts] = useState<PayContract[]>([]);
  const [hook, setHook] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ file: string; columns: Record<string, string>; rows: Array<ParsedTx & { pick: boolean; match: boolean }> } | null>(null);
  const [showOthers, setShowOthers] = useState(false);

  const reload = useCallback(async () => {
    const [c, t, k] = await Promise.all([
      supabase.from('rent_charge_status').select('*').eq('station_id', stationId).order('due_date'),
      supabase
        .from('bank_transactions')
        .select('id,occurred_at,amount,payer,memo,source,charge_id')
        .eq('station_id', stationId)
        .order('occurred_at', { ascending: false })
        .limit(200),
      supabase
        .from('contracts')
        .select('id,title,tenant_name,payer_names,payments_tracked_from')
        .eq('station_id', stationId)
        .eq('status', 'confirmed')
        .order('start_date'),
    ]);
    if (c.error) setError(c.error.message);
    setCharges((c.data as Charge[]) ?? []);
    setTxs((t.data as Tx[]) ?? []);
    setContracts((k.data as PayContract[]) ?? []);
    if (canWrite) {
      const h = await supabase
        .from('bank_webhooks')
        .select('token')
        .eq('station_id', stationId)
        .order('created_at', { ascending: false })
        .limit(1);
      setHook(h.data?.[0]?.token ?? null);
    }
  }, [canWrite, stationId]);

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

  const today = todayKst();
  const payerNames = useMemo(() => contracts.flatMap((c) => [c.tenant_name, ...(c.payer_names ?? [])]).filter(Boolean), [contracts]);
  const chargeById = useMemo(() => new Map((charges ?? []).map((c) => [c.id, c])), [charges]);
  const multi = new Set((charges ?? []).map((c) => c.contract_id)).size > 1;

  if (!charges) return <Loading />;

  const late = charges.filter((c) => overdue(c, today));
  const lateSum = late.reduce((s, c) => s + c.expected_amount - c.paid_amount, 0);
  const next = charges.find((c) => c.due_date >= today && c.status !== '완납' && c.status !== '초과');
  const thisMonth = today.slice(0, 7);
  const lo = new Date(`${thisMonth}-01`);
  lo.setMonth(lo.getMonth() - 6);
  const hi = new Date(`${thisMonth}-01`);
  hi.setMonth(hi.getMonth() + 2);
  const inWindow = (p: string) => p >= lo.toISOString().slice(0, 7) && p <= hi.toISOString().slice(0, 7);
  const shown = showAll ? charges : charges.filter((c) => inWindow(c.period) || overdue(c, today));
  const unmatched = txs.filter((t) => !t.charge_id);
  const linkable = charges.filter((c) => c.status !== '완납' && c.status !== '초과' && c.due_date <= addDays(today, 60));

  /** 통장 내역 파일 → 미리 보기 */
  const readFile = (file: File) =>
    run('통장 내역 읽는 중', async () => {
      const XLSX = await import('xlsx');
      const buf = new Uint8Array(await file.arrayBuffer());
      // CSV·HTML 형식 xls 는 글자 인코딩(UTF-8 / EUC-KR)을 직접 판별해서 읽는다
      const isText = /\.csv$/i.test(file.name) || buf[0] === 0x3c || (buf[0] === 0xef && buf[1] === 0xbb);
      let wb;
      if (isText) {
        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
        } catch {
          text = new TextDecoder('euc-kr').decode(buf);
        }
        wb = XLSX.read(text, { type: 'string', raw: true });
      } else {
        wb = XLSX.read(buf, { type: 'array', cellDates: true });
      }
      for (const name of wb.SheetNames) {
        const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: true, defval: '' });
        const r = parseStatement(rows);
        if (r.headerRow < 0) continue;
        if (!r.txs.length) throw new Error('입금 내역이 한 건도 없습니다. 조회 기간을 확인해 주세요.');
        setShowOthers(false);
        setPreview({
          file: file.name,
          columns: r.columns,
          rows: r.txs.map((t) => {
            const match = payerMatches(t.payer, payerNames);
            return { ...t, match, pick: match };
          }),
        });
        return;
      }
      throw new Error('거래일자와 입금액 칸을 찾지 못했습니다. 은행 사이트에서 "거래내역 조회 → 엑셀 저장"으로 받은 파일인지 확인해 주세요.');
    });

  const saveTxs = (rows: ParsedTx[], source: Tx['source']) =>
    run('입금 기록 저장하는 중', async () => {
      if (!rows.length) throw new Error('저장할 입금이 없습니다.');
      const data = must<Array<{ id: string; charge_id: string | null }>>(
        await supabase
          .from('bank_transactions')
          .upsert(
            rows.map((t) => ({ ...t, station_id: stationId, source, dedupe_key: dedupeKey(t) })),
            { onConflict: 'station_id,dedupe_key', ignoreDuplicates: true },
          )
          .select('id,charge_id'),
      );
      const linked = data.filter((d) => d.charge_id).length;
      const dup = rows.length - data.length;
      setPreview(null);
      setNotice(
        `${data.length}건 저장, 그중 ${linked}건은 해당 월 임대료와 연결했습니다.` +
          (dup ? ` ${dup}건은 이미 있는 입금이라 건너뛰었습니다.` : '') +
          (data.length - linked ? ' 연결하지 못한 입금은 아래 "확인할 입금"에서 월을 골라 주세요.' : ''),
      );
    });

  return (
    <section className="block" aria-labelledby="pay-h">
      <header className="block-head">
        <h2 id="pay-h">입금 확인</h2>
        <p className="block-meta">계약서의 임대료·지급일·인상 조항으로 매월 받을 금액을 계산하고, 들어온 입금과 맞춰 봅니다</p>
      </header>

      {charges.length === 0 ? (
        <p className="readout">
          확정한 계약이 없어서 받을 임대료를 계산하지 못했습니다. 계약 일정 탭에서 계약서를 확정하면 (월 임대료와 매월 지급일이 있어야 함) 여기에 월별
          청구가 생깁니다.
        </p>
      ) : late.length > 0 ? (
        <p className="readout">
          <b className="price-big alert-text">미납 {won(lateSum)}</b> 납기일이 지났는데 다 들어오지 않은 달이 {late.length}개 있습니다 (
          {late.map((c) => monthKo(c.period)).join(', ')}).
        </p>
      ) : next ? (
        <p className="readout">
          <b className="price-big">{badge(next, today).text}</b> 밀린 임대료는 없습니다. 다음은 {monthKo(next.period)}분 {won(next.expected_amount - next.paid_amount)}, 납기{' '}
          {dot(next.due_date)}입니다.
        </p>
      ) : (
        <p className="readout">계약 기간의 임대료를 모두 받았습니다.</p>
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

      {charges.length > 0 && (
        <>
          <div className="table-scroll">
            <table className="price-table pay-table">
              <caption className="sr-only">월별 임대료 입금 현황</caption>
              <thead>
                <tr>
                  <th scope="col">월</th>
                  <th scope="col" className="col-due">납기일</th>
                  <th scope="col" className="num">받을 금액</th>
                  <th scope="col" className="num col-paid">들어온 금액</th>
                  <th scope="col">상태</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => {
                  const b = badge(c, today);
                  const isOpen = open === c.id;
                  return (
                    <ChargeRows
                      key={c.id}
                      c={c}
                      b={b}
                      multi={multi}
                      isOpen={isOpen}
                      current={c.period === thisMonth}
                      onToggle={() => setOpen(isOpen ? null : c.id)}
                      txs={txs.filter((t) => t.charge_id === c.id)}
                      tenant={contracts.find((k) => k.id === c.contract_id)?.tenant_name ?? ''}
                      canWrite={canWrite}
                      busy={busy}
                      onAmount={(amt) =>
                        run('금액 고치는 중', async () => {
                          must(await supabase.from('rent_charges').update({ expected_amount: amt, manual: true, note: '직접 고친 금액' }).eq('id', c.id));
                        })
                      }
                      onUnlink={(id) =>
                        run('연결 푸는 중', async () => {
                          must(await supabase.from('bank_transactions').update({ charge_id: null }).eq('id', id));
                        })
                      }
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
          {charges.length > shown.length || showAll ? (
            <button type="button" className="link-btn" onClick={() => setShowAll(!showAll)} aria-expanded={showAll}>
              {showAll ? '최근 몇 달만 보기' : `계약 기간 전체 ${charges.length}개월 보기`}
            </button>
          ) : null}
          <p className="fine">
            인상 조항은 계약서대로 계산한 추정치입니다. 실제 받기로 한 금액이 다르면 해당 월을 눌러 금액을 고치세요. 고친 금액은 자동 계산이 덮어쓰지
            않습니다.
          </p>
        </>
      )}

      {/* ── 연결 안 된 입금 ── */}
      {unmatched.length > 0 && (
        <>
          <h3 className="sub-head">확인할 입금 {unmatched.length}건</h3>
          <p className="fine">계약 입금자와 이름은 맞지만 어느 달 임대료인지 정하지 못한 입금입니다. 맞는 달을 골라 주세요.</p>
          <ul className="tx-list">
            {unmatched.map((t) => (
              <li key={t.id}>
                <span className="tx-main">
                  {dot(kstDate(t.occurred_at))} <b>{won(t.amount)}</b> {t.payer || '입금자 없음'}
                  <span className="brand-name">{SOURCE_KO[t.source]}</span>
                </span>
                {canWrite && (
                  <span className="tx-actions">
                    <select
                      aria-label={`${won(t.amount)} 입금을 연결할 달`}
                      defaultValue=""
                      disabled={!!busy}
                      onChange={(e) => {
                        const id = e.target.value;
                        if (!id) return;
                        run('연결하는 중', async () => {
                          must(await supabase.from('bank_transactions').update({ charge_id: id }).eq('id', t.id));
                        });
                      }}
                    >
                      <option value="">달 고르기</option>
                      {linkable.map((c) => (
                        <option key={c.id} value={c.id}>
                          {multi ? `${c.contract_title} ` : ''}
                          {monthKo(c.period)} (남은 {won(c.expected_amount - c.paid_amount)})
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="link-btn danger-inline"
                      onClick={() => {
                        if (!confirm(`${dot(kstDate(t.occurred_at))} ${won(t.amount)} 입금 기록을 지울까요?`)) return;
                        run('지우는 중', async () => {
                          must(await supabase.from('bank_transactions').delete().eq('id', t.id));
                        });
                      }}
                    >
                      임대료가 아님, 지우기
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {/* ── 입금 넣기 ── */}
      {canWrite && charges.length > 0 && (
        <>
          <h3 className="sub-head">통장 내역 올리기</h3>
          <p className="fine">
            인터넷뱅킹의 거래내역 조회에서 엑셀(또는 CSV)로 저장한 파일을 올리세요. 파일은 이 브라우저에서만 읽고, 계약 입금자({payerNames.join(', ') || '미설정'}
            )와 이름이 맞는 입금만 저장합니다. 이미 저장한 입금은 다시 올려도 한 번만 들어갑니다.
          </p>
          <div className="upload-row">
            <label className="primary file-btn">
              통장 내역 파일 고르기
              <input
                type="file"
                accept=".xls,.xlsx,.csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
                disabled={!!busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) readFile(f);
                }}
              />
            </label>
          </div>

          {preview && (
            <div className="form boxed">
              <p className="fine">
                {preview.file}: 입금 {preview.rows.length}건 중 계약 입금자와 맞는 입금 {preview.rows.filter((r) => r.match).length}건. 읽은 칸은{' '}
                {Object.values(preview.columns).join(', ')}입니다.
              </p>
              <PreviewTable
                rows={preview.rows.filter((r) => r.match)}
                empty="계약 입금자와 이름이 맞는 입금이 없습니다. 입금자 이름이 다르게 찍힌다면 아래 목록에서 골라 저장하고, 계약별 입금자 이름에도 추가해 두세요."
                onPick={(r, v) => setPreview({ ...preview, rows: preview.rows.map((x) => (x === r ? { ...x, pick: v } : x)) })}
              />
              {preview.rows.some((r) => !r.match) && (
                <>
                  <button type="button" className="link-btn" aria-expanded={showOthers} onClick={() => setShowOthers(!showOthers)}>
                    {showOthers ? '다른 입금 숨기기' : `이름이 다른 입금 ${preview.rows.filter((r) => !r.match).length}건도 보기 (기본은 저장 안 함)`}
                  </button>
                  {showOthers && (
                    <PreviewTable
                      rows={preview.rows.filter((r) => !r.match)}
                      empty=""
                      onPick={(r, v) => setPreview({ ...preview, rows: preview.rows.map((x) => (x === r ? { ...x, pick: v } : x)) })}
                    />
                  )}
                </>
              )}
              <div className="form-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={!!busy || !preview.rows.some((r) => r.pick)}
                  onClick={() => saveTxs(preview.rows.filter((r) => r.pick).map(({ pick: _p, match: _m, ...t }) => t), 'excel')}
                >
                  {preview.rows.filter((r) => r.pick).length}건 저장
                </button>
                <button type="button" className="more" onClick={() => setPreview(null)}>
                  취소
                </button>
              </div>
            </div>
          )}

          <ManualAdd busy={busy} onAdd={(t) => saveTxs([t], 'manual')} />
        </>
      )}

      {/* ── 최근 입금 ── */}
      {txs.some((t) => t.charge_id) && (
        <>
          <h3 className="sub-head">최근 입금 기록</h3>
          <ul className="tx-list">
            {txs
              .filter((t) => t.charge_id)
              .slice(0, 12)
              .map((t) => {
                const c = chargeById.get(t.charge_id!);
                return (
                  <li key={t.id}>
                    <span className="tx-main">
                      {dot(kstDate(t.occurred_at))} {kstTime(t.occurred_at) !== '00:00' && kstTime(t.occurred_at)} <b>{won(t.amount)}</b> {t.payer}
                      <span className="brand-name">
                        {c ? `${monthKo(c.period)}분` : ''}, {SOURCE_KO[t.source]}
                      </span>
                    </span>
                  </li>
                );
              })}
          </ul>
        </>
      )}

      {/* ── 계약별 설정 ── */}
      {canEditContracts && contracts.length > 0 && (
        <>
          <h3 className="sub-head">계약별 입금 설정</h3>
          {contracts.map((k) => (
            <PayerSettings
              key={k.id}
              k={k}
              busy={busy}
              onSave={(patch) =>
                run('설정 저장하는 중', async () => {
                  must(await supabase.from('contracts').update(patch).eq('id', k.id));
                  setNotice('저장했습니다. 월별 청구를 다시 계산했습니다.');
                })
              }
            />
          ))}
        </>
      )}

      {/* ── 입금 문자 자동 전달 ── */}
      {canWrite && charges.length > 0 && (
        <SmsHook
          token={hook}
          busy={busy}
          payerNames={payerNames}
          onCreate={(replace) =>
            run(replace ? '주소 바꾸는 중' : '주소 만드는 중', async () => {
              if (replace) must(await supabase.from('bank_webhooks').delete().eq('station_id', stationId));
              must(await supabase.from('bank_webhooks').insert({ station_id: stationId, created_by: me.id }));
            })
          }
        />
      )}
    </section>
  );
}

function addDays(d: string, n: number) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

// ── 월별 행 + 펼침 ──────────────────────────────────────────────────
function ChargeRows({
  c,
  b,
  multi,
  isOpen,
  current,
  onToggle,
  txs,
  tenant,
  canWrite,
  busy,
  onAmount,
  onUnlink,
}: {
  c: Charge;
  b: { text: string; tone: string };
  multi: boolean;
  isOpen: boolean;
  current: boolean;
  onToggle: () => void;
  txs: Tx[];
  tenant: string;
  canWrite: boolean;
  busy: string;
  onAmount: (n: number) => void;
  onUnlink: (id: string) => void;
}) {
  const [amt, setAmt] = useState(String(c.expected_amount));
  const [copied, setCopied] = useState(false);
  const left = c.expected_amount - c.paid_amount;
  const late = overdue(c);
  const msg =
    `[임대료 입금 안내]\n${tenant ? `${tenant} 담당자님, ` : ''}${monthKo(c.period)}분 임대료 ${won(c.expected_amount)}` +
    (c.paid_amount > 0 ? ` 중 ${won(left)}이` : '이') +
    ` 납기일(${Number(c.due_date.slice(5, 7))}월 ${Number(c.due_date.slice(8))}일)이 지났는데 아직 확인되지 않습니다. ` +
    `확인 후 입금 부탁드립니다. 이미 보내셨다면 이 문자는 넘겨 주세요.`;
  return (
    <>
      <tr className={`${current ? 'self' : ''} pay-row`}>
        <th scope="row">
          <button type="button" className="row-btn" aria-expanded={isOpen} onClick={onToggle}>
            {multi && <span className="brand-name first">{c.contract_title}</span>}
            {monthKo(c.period)}
          </button>
        </th>
        <td className="num-l col-due">{dot(c.due_date)}</td>
        <td className="num">
          {won(c.expected_amount)}
          {c.manual && <span className="brand-name">직접 고침</span>}
        </td>
        <td className="num col-paid">{c.paid_amount ? won(c.paid_amount) : '-'}</td>
        <td>
          <span className={`pay-tag tone-${b.tone}`}>{b.text}</span>
        </td>
      </tr>
      {isOpen && (
        <tr className="pay-detail">
          <td colSpan={5}>
            <p className="fine">
              납기 {dot(c.due_date)}, 받을 금액 {won(c.expected_amount)}, 들어온 금액 {won(c.paid_amount)}
              {c.note && `, ${c.note}`}
            </p>
            {txs.length ? (
              <ul className="tx-list">
                {txs.map((t) => (
                  <li key={t.id}>
                    <span className="tx-main">
                      {dot(kstDate(t.occurred_at))} <b>{won(t.amount)}</b> {t.payer}
                      <span className="brand-name">{SOURCE_KO[t.source]}</span>
                    </span>
                    {canWrite && (
                      <button type="button" className="link-btn" disabled={!!busy} onClick={() => onUnlink(t.id)}>
                        이 달에서 빼기
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="fine">이 달에 연결된 입금이 없습니다.</p>
            )}
            {canWrite && (
              <div className="copy-row">
                <input inputMode="numeric" aria-label={`${monthKo(c.period)} 받을 금액`} value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^\d]/g, ''))} />
                <button type="button" className="more" disabled={!!busy || !amt || Number(amt) === c.expected_amount} onClick={() => onAmount(Number(amt))}>
                  받을 금액 고치기
                </button>
              </div>
            )}
            {late && (
              <>
                <p className="fine">임차인에게 보낼 안내 문자 초안입니다. 복사해서 문자나 카카오톡으로 보내세요.</p>
                <textarea className="msg-draft" readOnly rows={4} value={msg} aria-label="안내 문자 초안" />
                <button
                  type="button"
                  className="more"
                  onClick={async () => {
                    await navigator.clipboard.writeText(msg);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                >
                  {copied ? '복사됨' : '문자 복사'}
                </button>
              </>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function PreviewTable<R extends ParsedTx & { pick: boolean }>({ rows, empty, onPick }: { rows: R[]; empty: string; onPick: (r: R, v: boolean) => void }) {
  if (!rows.length) return empty ? <p className="fine">{empty}</p> : null;
  return (
    <div className="table-scroll">
      <table className="price-table preview-table">
        <thead>
          <tr>
            <th scope="col">저장</th>
            <th scope="col">날짜</th>
            <th scope="col">입금자</th>
            <th scope="col" className="num">금액</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                <input type="checkbox" checked={r.pick} aria-label={`${r.payer} ${won(r.amount)} 저장`} onChange={(e) => onPick(r, e.target.checked)} />
              </td>
              <td className="num-l">
                {dot(kstDate(r.occurred_at))} {kstTime(r.occurred_at) !== '00:00' && kstTime(r.occurred_at)}
              </td>
              <td>{r.payer || '-'}</td>
              <td className="num">{won(r.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ManualAdd({ busy, onAdd }: { busy: string; onAdd: (t: ParsedTx) => void }) {
  const [openForm, setOpenForm] = useState(false);
  const [f, setF] = useState({ date: todayKst(), amount: '', payer: '' });
  if (!openForm)
    return (
      <button type="button" className="link-btn" onClick={() => setOpenForm(true)}>
        입금 한 건 직접 넣기
      </button>
    );
  return (
    <form
      className="form boxed"
      onSubmit={(e) => {
        e.preventDefault();
        onAdd({ occurred_at: new Date(`${f.date}T12:00:00+09:00`).toISOString(), amount: Number(f.amount), payer: f.payer.trim(), memo: '직접 입력' });
        setOpenForm(false);
        setF({ date: todayKst(), amount: '', payer: '' });
      }}
    >
      <div className="cf-grid">
        <label className="cf-field">
          <span>입금일</span>
          <input type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </label>
        <label className="cf-field">
          <span>금액 (원)</span>
          <input inputMode="numeric" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^\d]/g, '') })} />
        </label>
        <label className="cf-field">
          <span>입금자</span>
          <input required value={f.payer} onChange={(e) => setF({ ...f, payer: e.target.value })} />
        </label>
      </div>
      <div className="form-actions">
        <button type="submit" className="primary" disabled={!!busy || !f.amount}>
          입금 넣기
        </button>
        <button type="button" className="more" onClick={() => setOpenForm(false)}>
          취소
        </button>
      </div>
    </form>
  );
}

function PayerSettings({ k, busy, onSave }: { k: PayContract; busy: string; onSave: (p: Partial<PayContract>) => void }) {
  const [names, setNames] = useState((k.payer_names ?? []).join(', '));
  const [from, setFrom] = useState((k.payments_tracked_from ?? '').slice(0, 7));
  const parsed = names
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const changed = parsed.join(',') !== (k.payer_names ?? []).join(',') || from !== (k.payments_tracked_from ?? '').slice(0, 7);
  return (
    <form
      className="form boxed"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ payer_names: parsed, payments_tracked_from: from ? `${from}-01` : null });
      }}
    >
      <p className="insp-name">{k.title}</p>
      <div className="cf-grid">
        <label className="cf-field wide">
          <span>입금자 이름 (쉼표로 구분)</span>
          <input value={names} placeholder={k.tenant_name || '예: 샘플에너지, 홍길동'} onChange={(e) => setNames(e.target.value)} />
          <span className="field-hint">
            통장에 찍히는 이름을 적으세요. 임차인 이름({k.tenant_name || '미입력'})은 따로 적지 않아도 맞춰 봅니다. (주), 주식회사, 띄어쓰기는 무시합니다.
          </span>
        </label>
        <label className="cf-field">
          <span>이 달부터 확인</span>
          <input type="month" value={from} onChange={(e) => setFrom(e.target.value)} />
          <span className="field-hint">이전 달은 이미 받은 것으로 보고 목록에서 뺍니다.</span>
        </label>
      </div>
      <div className="form-actions">
        <button type="submit" className="primary" disabled={!!busy || !changed}>
          저장
        </button>
      </div>
    </form>
  );
}

function SmsHook({
  token,
  busy,
  payerNames,
  onCreate,
}: {
  token: string | null;
  busy: string;
  payerNames: string[];
  onCreate: (replace: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [os, setOs] = useState<'ios' | 'android'>(() => (/android/i.test(navigator.userAgent) ? 'android' : 'ios'));
  const [sample, setSample] = useState('');
  const url = token ? `${SUPABASE_URL}/functions/v1/bank-notify?token=${token}` : '';
  const parsed = sample.trim() ? parseBankSms(sample) : undefined;
  return (
    <>
      <h3 className="sub-head">입금 문자 자동 전달</h3>
      <p className="fine">
        임대료가 들어오는 통장의 입금 알림 문자를 휴대폰이 이 주소로 넘기면, 엑셀을 올리지 않아도 바로 입금이 기록됩니다. 계약 입금자와 이름이 맞는
        입금만 저장하고 나머지 문자는 버립니다.
      </p>
      {!token ? (
        <button type="button" className="more" disabled={!!busy} onClick={() => onCreate(false)}>
          전달 주소 만들기
        </button>
      ) : (
        <>
          <div className="copy-row">
            <input readOnly value={url} aria-label="입금 문자 전달 주소" onFocus={(e) => e.target.select()} />
            <button
              type="button"
              className="primary"
              onClick={async () => {
                await navigator.clipboard.writeText(url);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? '복사됨' : '주소 복사'}
            </button>
          </div>
          <div className="seg" role="group" aria-label="휴대폰 종류">
            <button type="button" aria-pressed={os === 'ios'} onClick={() => setOs('ios')}>
              아이폰
            </button>
            <button type="button" aria-pressed={os === 'android'} onClick={() => setOs('android')}>
              안드로이드
            </button>
          </div>
          {os === 'ios' ? (
            <ol className="steps">
              <li>단축어 앱 → 자동화 → 새로운 자동화 → 메시지를 고릅니다.</li>
              <li>"메시지 포함"에 입금 을 넣고, 보낸 사람에 은행 알림 번호(예: 신한 15778000)를 고른 뒤 "즉시 실행"을 켭니다.</li>
              <li>
                동작으로 "URL 콘텐츠 가져오기"를 추가하고 URL 에 위 주소를 붙여 넣습니다. 방법은 POST, 요청 본문은 JSON 으로 두고 키 text 에 값으로
                "단축어 입력"(메시지 본문)을 넣습니다.
              </li>
              <li>은행 앱 푸시만 오고 문자가 오지 않으면, 은행 앱에서 입금 알림을 문자로 바꿔야 합니다.</li>
            </ol>
          ) : (
            <ol className="steps">
              <li>
                Play 스토어에서 MacroDroid 를 설치하고 새 매크로를 만듭니다. 트리거는 "SMS 수신", 내용에 입금 포함으로 둡니다. 은행 앱 푸시를 쓰면
                "알림 수신"으로 은행 앱을 고릅니다.
              </li>
              <li>동작은 "HTTP 요청": 방식 POST, URL 에 위 주소, 본문은 텍스트로 [sms_message] (알림이면 [notification]) 를 넣습니다.</li>
              <li>배터리 최적화에서 MacroDroid 를 빼야 화면이 꺼져 있을 때도 전달됩니다.</li>
            </ol>
          )}
          <label className="cf-field wide test-box">
            <span>문자 읽기 확인 (저장하지 않음)</span>
            <textarea rows={4} value={sample} placeholder="받은 입금 문자를 그대로 붙여 넣어 보세요." onChange={(e) => setSample(e.target.value)} />
          </label>
          {parsed === null && <p className="fine">입금 문자로 읽히지 않습니다. "입금"과 금액이 들어 있는지 확인해 주세요.</p>}
          {parsed && (
            <p className="fine" role="status">
              {dot(kstDate(parsed.occurred_at))} {kstTime(parsed.occurred_at)}, {won(parsed.amount)}, 입금자 "{parsed.payer || '못 찾음'}".{' '}
              {payerMatches(parsed.payer, payerNames) ? '계약 입금자와 맞아서 저장됩니다.' : '계약 입금자와 맞지 않아 저장하지 않습니다. 계약별 입금자 이름에 추가하세요.'}
            </p>
          )}
          <button
            type="button"
            className="link-btn danger-inline"
            onClick={() => {
              if (!confirm('전달 주소를 새로 만들까요? 휴대폰 자동화에 넣은 주소도 바꿔야 합니다.')) return;
              onCreate(true);
            }}
          >
            주소가 새어 나갔다면: 새 주소로 바꾸기
          </button>
        </>
      )}
    </>
  );
}
