import { useEffect, useMemo, useState } from 'react';
import { md } from './data';
import { supabase, type Station } from './supabase';
import { Loading } from './Loading';
import {
  METHOD_KO,
  addMonth,
  amountOf,
  dayKo,
  isLow,
  isPurchase,
  monthKo,
  monthKoFull,
  monthOf,
  monthStartIso,
  n,
  qtyFmt,
  telOf,
  vendorMonth,
  won,
  wonShort,
  type Item,
  type Method,
  type Move,
  type Order,
  type OrderLine,
  type Settlement,
  type Vendor,
} from './supplyShared';

const belongs = (i: Item, vendor: Vendor | undefined, vendors: Vendor[]) =>
  vendor ? i.vendor_id === vendor.id : !i.vendor_id || !vendors.some((v) => v.id === i.vendor_id);

/** 주문할 수량 제안: 정해 둔 주문 수량, 없으면 발주점의 두 배까지 */
export const suggestQty = (i: Item) => n(i.order_qty) || Math.max(1, Math.ceil(n(i.reorder_point) * 2 - n(i.stock)));

// ── 주문서 한 장 (거래처 하나) ───────────────────────────────────────
export function OrderCard({
  station,
  vendor,
  vendors,
  items,
  initial,
  canWrite,
  busy,
  onVendor,
  onClose,
  onSent,
}: {
  station: Station;
  vendor?: Vendor;
  vendors: Vendor[];
  /** 주문할 수 있는 품목 전체 (쓰는 것만) */
  items: Item[];
  /** 처음 채워 둘 수량 */
  initial: Record<string, number>;
  canWrite: boolean;
  busy: string;
  /** 있으면 거래처를 바꿀 수 있는 새 주문서 */
  onVendor?: (id: string) => void;
  onClose?: () => void;
  onSent: (vendor: Vendor | undefined, lines: OrderLine[], message: string) => void;
}) {
  const [qtys, setQtys] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, String(v)])));
  const [added, setAdded] = useState<string[]>([]);
  const prefilled = Object.keys(initial);
  const [open, setOpen] = useState(prefilled.length === 0);
  const [copied, setCopied] = useState(false);

  const mine = items.filter((i) => belongs(i, vendor, vendors));
  const shownIds = new Set([...prefilled, ...added, ...(open ? mine.map((i) => i.id) : [])]);
  // 이 거래처 품목 먼저, 다른 거래처에서 넣은 품목은 넣은 순서대로 뒤에
  const shown = [...items.filter((i) => shownIds.has(i.id) && belongs(i, vendor, vendors)), ...[...new Set([...prefilled, ...added])].map((id) => items.find((i) => i.id === id)).filter((i): i is Item => !!i && !belongs(i, vendor, vendors))];
  const hiddenMine = mine.filter((i) => !shownIds.has(i.id));
  const others = items.filter((i) => !shownIds.has(i.id) && !belongs(i, vendor, vendors));

  const lines: OrderLine[] = shown
    .filter((i) => Number(qtys[i.id]) > 0)
    .map((i) => ({ item_id: i.id, name: i.name, qty: Number(qtys[i.id]), unit: i.unit }));
  const message = [
    `[${station.name}] 주문 요청`,
    `${vendor?.contact_name || vendor?.name || '담당자'}님, 안녕하세요. 아래 물품 주문 부탁드립니다.`,
    '',
    ...lines.map((l) => `- ${l.name} ${qtyFmt(l.qty)}${l.unit}`),
    '',
    `납품: ${station.address}`,
    '납품 일정 알려 주시면 감사하겠습니다.',
  ].join('\n');
  const phone = telOf(vendor);
  const smsHref = `sms:${phone}?&body=${encodeURIComponent(message)}`;
  const mailHref = `mailto:${vendor?.email ?? ''}?subject=${encodeURIComponent(`[${station.name}] 주문 요청`)}&body=${encodeURIComponent(message)}`;
  const copy = async () => {
    await navigator.clipboard.writeText(message);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const add = (id: string) => {
    if (!id) return;
    const it = items.find((i) => i.id === id);
    setAdded([...added, id]);
    if (it && !qtys[id]) setQtys({ ...qtys, [id]: String(suggestQty(it)) });
  };
  const ok = lines.length > 0 && !busy;

  return (
    <div className={`order-card ${onVendor ? 'is-new' : ''}`}>
      <div className="order-head">
        {onVendor ? (
          <label className="order-vendor">
            <span className="fine">거래처</span>
            <select value={vendor?.id ?? ''} onChange={(e) => onVendor(e.target.value)}>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
              <option value="">거래처 미지정</option>
            </select>
          </label>
        ) : (
          <p className="insp-name">
            {vendor?.name ?? '거래처 미지정'}
            {vendor && <span className="brand-name">{METHOD_KO[vendor.order_method]}로 주문</span>}
          </p>
        )}
        {onClose && (
          <button type="button" className="link-btn" onClick={onClose}>
            닫기
          </button>
        )}
      </div>

      {shown.length > 0 ? (
        <ul className="count-list">
          {shown.map((i) => (
            <li key={i.id}>
              <label>
                <span>
                  {i.name}{' '}
                  <span className={`brand-name ${isLow(i) ? 'alert-text' : ''}`}>
                    남은 {qtyFmt(n(i.stock))}
                    {i.unit}
                  </span>
                </span>
                <span className="count-input">
                  <input
                    inputMode="decimal"
                    placeholder="0"
                    aria-label={`${i.name} 주문 수량`}
                    value={qtys[i.id] ?? ''}
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => setQtys({ ...qtys, [i.id]: e.target.value.replace(/[^\d.]/g, '') })}
                  />
                  {i.unit}
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <p className="fine">이 거래처로 지정된 품목이 없습니다. 아래에서 주문할 품목을 넣으세요.</p>
      )}

      {canWrite && (hiddenMine.length > 0 || others.length > 0) && (
        <div className="order-more">
          {hiddenMine.length > 0 && (
            <button type="button" className="link-btn" onClick={() => setOpen(true)}>
              이 거래처 다른 품목 {hiddenMine.length}개도 보기
            </button>
          )}
          {others.length > 0 && (
            <select aria-label="다른 품목 넣기" value="" onChange={(e) => add(e.target.value)}>
              <option value="">다른 품목 넣기</option>
              {others.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {lines.length > 0 && <textarea className="msg-draft" readOnly rows={Math.min(10, lines.length + 6)} value={message} aria-label="주문 메시지" />}
      {!vendor && vendors.length > 0 && !onVendor && <p className="fine">품목에 거래처를 지정하면 그 거래처 연락처로 바로 보낼 수 있습니다.</p>}
      {canWrite && (
        <>
          <div className="form-actions">
            {vendor?.order_method === 'email' && vendor.email ? (
              <a className={`primary ${ok ? '' : 'is-off'}`} aria-disabled={!ok} href={ok ? mailHref : undefined} onClick={() => ok && onSent(vendor, lines, message)}>
                이메일 보내기
              </a>
            ) : vendor?.order_method === 'sms' && phone ? (
              <a className={`primary ${ok ? '' : 'is-off'}`} aria-disabled={!ok} href={ok ? smsHref : undefined} onClick={() => ok && onSent(vendor, lines, message)}>
                문자 보내기
              </a>
            ) : null}
            {vendor?.order_method === 'phone' && phone && (
              <a className="more" href={`tel:${phone}`}>
                전화 걸기
              </a>
            )}
            <button type="button" className="more" disabled={!lines.length} onClick={copy}>
              {copied ? '복사됨' : vendor?.order_method === 'kakao' ? '복사 (카톡에 붙여 넣기)' : '복사'}
            </button>
            <button type="button" className="link-btn" disabled={!ok} onClick={() => onSent(vendor, lines, message)}>
              주문한 것으로 기록
            </button>
          </div>
          <p className="fine">전화나 방문한 영업사원에게 말로 주문했다면 "주문한 것으로 기록"만 누르세요. 물건이 오면 받은 수량·단가를 확인하고 입고합니다.</p>
        </>
      )}
    </div>
  );
}

// ── 받은 물건 확인 → 입고 ───────────────────────────────────────────
export interface Received {
  item: Item;
  qty: number;
  unit_cost: number | null;
}
export function ReceiveForm({ order, items, busy, onReceive, onCancel }: { order: Order; items: Item[]; busy: string; onReceive: (rows: Received[]) => void; onCancel: () => void }) {
  const rows = order.lines.map((l) => ({ line: l, item: items.find((i) => i.id === l.item_id) }));
  const [f, setF] = useState<Record<string, { qty: string; cost: string }>>(() =>
    Object.fromEntries(rows.map(({ line, item }) => [line.item_id, { qty: String(n(line.qty)), cost: item?.unit_cost != null ? String(item.unit_cost) : '' }])),
  );
  const total = rows.reduce((s, { line }) => s + (Number(f[line.item_id]?.qty) || 0) * (Number(f[line.item_id]?.cost) || 0), 0);
  const missing = rows.some(({ line }) => f[line.item_id]?.cost === '');
  return (
    <form
      className="receive-form"
      onSubmit={(e) => {
        e.preventDefault();
        onReceive(
          rows
            .filter(({ item, line }) => item && Number(f[line.item_id].qty) > 0)
            .map(({ item, line }) => ({ item: item!, qty: Number(f[line.item_id].qty), unit_cost: f[line.item_id].cost === '' ? null : Number(f[line.item_id].cost) })),
        );
      }}
    >
      <p className="fine">실제로 받은 수량과 개당 단가를 확인하세요. 단가는 거래처 명세서 기준이고, 바뀌었으면 품목의 들여오는 값도 같이 바뀝니다.</p>
      <ul className="recv-list">
        {rows.map(({ line, item }) => (
          <li key={line.item_id}>
            <span className="recv-name">{line.name}</span>
            {item ? (
              <>
                <label className="recv-field">
                  <span className="fine">받은 수량</span>
                  <span className="count-input">
                    <input inputMode="decimal" value={f[line.item_id].qty} onFocus={(e) => e.target.select()} onChange={(e) => setF({ ...f, [line.item_id]: { ...f[line.item_id], qty: e.target.value.replace(/[^\d.]/g, '') } })} />
                    {line.unit}
                  </span>
                </label>
                <label className="recv-field">
                  <span className="fine">단가</span>
                  <span className="count-input">
                    <input inputMode="numeric" placeholder="모름" value={f[line.item_id].cost} onFocus={(e) => e.target.select()} onChange={(e) => setF({ ...f, [line.item_id]: { ...f[line.item_id], cost: e.target.value.replace(/\D/g, '') } })} />원
                  </span>
                </label>
              </>
            ) : (
              <span className="fine">지워진 품목이라 입고하지 않습니다.</span>
            )}
          </li>
        ))}
      </ul>
      <p className="recv-total">
        합계 <b>{won(total)}</b>
        {missing && <span className="fine"> 단가 빠진 품목은 합계에서 빠집니다. 나중에 거래처 내역에서 넣어도 됩니다.</span>}
      </p>
      <div className="form-actions">
        <button type="submit" className="primary" disabled={!!busy}>
          입고
        </button>
        <button type="button" className="more" onClick={onCancel}>
          닫기
        </button>
      </div>
    </form>
  );
}

// ── 거래처 (연락처·이번 달 입고·정산) ───────────────────────────────────
export function VendorSection({
  station,
  vendors,
  items,
  purchases,
  settlements,
  canWrite,
  busy,
  stamp,
  onCompose,
  onSave,
  onDelete,
  onSettle,
  onUnsettle,
  onFixCost,
}: {
  station: Station;
  vendors: Vendor[];
  items: Item[];
  /** 지난달 1일부터의 입고 기록 */
  purchases: Move[];
  settlements: Settlement[];
  canWrite: boolean;
  busy: string;
  /** 다시 불러올 때마다 바뀜 */
  stamp: number;
  onCompose: (vendorId: string) => void;
  onSave: (v: Partial<Vendor>) => Promise<boolean>;
  onDelete: (v: Vendor) => void;
  onSettle: (vendorId: string, ym: string, amount: number) => void;
  onUnsettle: (vendorId: string, ym: string) => void;
  onFixCost: (m: Move, cost: number | null) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<Vendor> | null>(null);
  const now = monthOf();
  const prev = addMonth(now, -1);
  const settled = (vid: string, ym: string) => settlements.find((s) => s.vendor_id === vid && s.month.slice(0, 7) === ym);

  return (
    <>
      <h3 className="sub-head" id="sup-vendors">
        거래처
      </h3>
      {vendors.length === 0 && (
        <p className="readout">
          물건을 받는 곳을 등록해 두면, 그 거래처 품목을 모아 문자·이메일·카톡으로 주문하고 달마다 받은 금액을 맞춰 볼 수 있습니다.
        </p>
      )}
      {vendors.length > 0 && (
        <ul className="vendor-list">
          {vendors.map((v) => {
            const cur = vendorMonth(purchases, v.id, now);
            const last = vendorMonth(purchases, v.id, prev);
            const due = last.total > 0 && !settled(v.id, prev);
            const count = items.filter((i) => i.active && i.vendor_id === v.id).length;
            const isOpen = openId === v.id;
            return (
              <li key={v.id} className={`vendor-item ${due ? 'is-due' : ''}`}>
                <button type="button" className="vendor-row" aria-expanded={isOpen} onClick={() => (setOpenId(isOpen ? null : v.id), setForm(null))}>
                  <span className="sup-name">
                    {v.name}
                    <span className="sup-sub">
                      {METHOD_KO[v.order_method]}로 주문, 품목 {count}개{v.contact_name && `, ${v.contact_name}`}
                    </span>
                  </span>
                  <span className="vendor-sum">
                    <b>{cur.total > 0 ? wonShort(cur.total) : '-'}</b>
                    <span className="sup-sub">{due ? <span className="alert-text">{monthKo(prev)} 정산 전</span> : `${monthKo(now)} 입고`}</span>
                  </span>
                </button>
                {isOpen &&
                  (form?.id === v.id ? (
                    <VendorForm
                      value={form}
                      busy={busy}
                      onCancel={() => setForm(null)}
                      onSave={async (f) => (await onSave(f)) && setForm(null)}
                      onDelete={() => onDelete(v)}
                    />
                  ) : (
                    <VendorPanel
                      station={station}
                      vendor={v}
                      items={items}
                      settled={(ym) => settled(v.id, ym)}
                      canWrite={canWrite}
                      busy={busy}
                      stamp={stamp}
                      initialMonth={due ? prev : now}
                      onCompose={() => onCompose(v.id)}
                      onEdit={() => setForm({ ...v })}
                      onSettle={(ym, amount) => onSettle(v.id, ym, amount)}
                      onUnsettle={(ym) => onUnsettle(v.id, ym)}
                      onFixCost={onFixCost}
                    />
                  ))}
              </li>
            );
          })}
        </ul>
      )}
      {canWrite &&
        (form && !form.id ? (
          <VendorForm value={form} busy={busy} onCancel={() => setForm(null)} onSave={async (f) => (await onSave(f)) && setForm(null)} />
        ) : (
          <button type="button" className="more add-vendor" onClick={() => (setForm({ name: '', contact_name: '', phone: '', email: '', order_method: 'sms', note: '' }), setOpenId(null))}>
            거래처 추가
          </button>
        ))}
    </>
  );
}

function VendorPanel({
  station,
  vendor,
  items,
  settled,
  canWrite,
  busy,
  stamp,
  initialMonth,
  onCompose,
  onEdit,
  onSettle,
  onUnsettle,
  onFixCost,
}: {
  station: Station;
  vendor: Vendor;
  items: Item[];
  settled: (ym: string) => Settlement | undefined;
  canWrite: boolean;
  busy: string;
  stamp: number;
  initialMonth: string;
  onCompose: () => void;
  onEdit: () => void;
  onSettle: (ym: string, amount: number) => void;
  onUnsettle: (ym: string) => void;
  onFixCost: (m: Move, cost: number | null) => void;
}) {
  const [ym, setYm] = useState(initialMonth);
  const [rows, setRows] = useState<Move[] | null>(null);
  const [fix, setFix] = useState<{ id: string; cost: string } | null>(null);
  const [amount, setAmount] = useState('');
  const [copied, setCopied] = useState(false);
  const now = monthOf();

  useEffect(() => {
    let off = false;
    setRows(null);
    supabase
      .from('supply_moves')
      .select('*')
      .eq('vendor_id', vendor.id)
      .in('kind', ['in', 'adjust'])
      .gte('created_at', monthStartIso(ym))
      .lt('created_at', monthStartIso(addMonth(ym, 1)))
      .order('created_at')
      .limit(1000)
      .then(({ data }) => !off && setRows(((data as Move[]) ?? []).filter(isPurchase)));
    return () => {
      off = true;
    };
  }, [vendor.id, ym, stamp]);

  const total = (rows ?? []).reduce((s, m) => s + amountOf(m), 0);
  const missing = (rows ?? []).filter((m) => m.kind === 'in' && m.unit_cost == null).length;
  const done = settled(ym);
  useEffect(() => setAmount(total > 0 ? String(total) : ''), [total, ym]);
  const itemOf = (id: string) => items.find((i) => i.id === id);
  const phone = telOf(vendor);

  const statement = [
    `[${station.name}] ${monthKoFull(ym)} 입고 내역 (${vendor.name})`,
    '',
    ...(rows ?? []).map((m) => {
      const it = itemOf(m.item_id);
      const q = n(m.qty);
      return `${dayKo(m.created_at)} ${it?.name ?? '지운 품목'} ${q < 0 ? `${qtyFmt(-q)}${it?.unit ?? ''} 반품` : `${qtyFmt(q)}${it?.unit ?? ''}`}${m.unit_cost != null ? ` × ${won(n(m.unit_cost))} = ${won(amountOf(m))}` : ' (단가 확인 필요)'}`;
    }),
    '',
    `합계 ${won(total)}`,
    '명세서와 맞는지 확인 부탁드립니다.',
  ].join('\n');
  const copy = async () => {
    await navigator.clipboard.writeText(statement);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="vendor-panel">
      <div className="vendor-acts">
        {canWrite && (
          <button type="button" className="primary" onClick={onCompose}>
            주문서 만들기
          </button>
        )}
        {phone && (
          <a className="more" href={`tel:${phone}`}>
            전화
          </a>
        )}
        {phone && (
          <a className="more" href={`sms:${phone}`}>
            문자
          </a>
        )}
        {vendor.email && (
          <a className="more" href={`mailto:${vendor.email}`}>
            이메일
          </a>
        )}
        {canWrite && (
          <button type="button" className="link-btn" onClick={onEdit}>
            거래처 고치기
          </button>
        )}
      </div>
      {(vendor.phone || vendor.email || vendor.note) && <p className="fine">{[vendor.phone, vendor.email, vendor.note].filter(Boolean).join(', ')}</p>}

      <div className="stmt">
        <div className="stmt-head">
          <button type="button" className="link-btn" aria-label="이전 달" onClick={() => setYm(addMonth(ym, -1))}>
            ‹
          </button>
          <h4>{monthKoFull(ym)} 받은 물건</h4>
          <button type="button" className="link-btn" aria-label="다음 달" disabled={ym >= now} onClick={() => setYm(addMonth(ym, 1))}>
            ›
          </button>
        </div>
        {!rows ? (
          <Loading size="block" />
        ) : rows.length === 0 ? (
          <p className="fine">이 달에 이 거래처에서 입고한 기록이 없습니다.</p>
        ) : (
          <>
            <ul className="stmt-list">
              {rows.map((m) => {
                const it = itemOf(m.item_id);
                const q = n(m.qty);
                const editing = fix?.id === m.id;
                return (
                  <li key={m.id} className={m.unit_cost == null && m.kind === 'in' ? 'is-missing' : ''}>
                    <span className="stmt-day">{dayKo(m.created_at)}</span>
                    <span className="stmt-name">
                      {it?.name ?? '지운 품목'}
                      <span className="brand-name">
                        {q < 0 ? `${qtyFmt(-q)}${it?.unit ?? ''} 되돌림` : `${qtyFmt(q)}${it?.unit ?? ''}`}
                        {m.unit_cost != null && ` × ${won(n(m.unit_cost))}`}
                      </span>
                    </span>
                    {editing ? (
                      <form
                        className="stmt-fix"
                        onSubmit={(e) => {
                          e.preventDefault();
                          onFixCost(m, fix.cost === '' ? null : Number(fix.cost));
                          setFix(null);
                        }}
                      >
                        <input inputMode="numeric" aria-label="단가" autoFocus value={fix.cost} onChange={(e) => setFix({ ...fix, cost: e.target.value.replace(/\D/g, '') })} />
                        <button type="submit" className="more" disabled={!!busy}>
                          저장
                        </button>
                      </form>
                    ) : canWrite && m.kind === 'in' ? (
                      <button type="button" className="stmt-amt" onClick={() => setFix({ id: m.id, cost: m.unit_cost != null ? String(m.unit_cost) : '' })} aria-label={`${it?.name ?? ''} 단가 고치기`}>
                        {m.unit_cost == null ? '단가 넣기' : won(amountOf(m))}
                      </button>
                    ) : (
                      <span className="stmt-amt">{m.unit_cost == null ? '단가 없음' : won(amountOf(m))}</span>
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="recv-total">
              합계 <b>{won(total)}</b>
              {missing > 0 && <span className="alert-text"> 단가 빠진 기록 {missing}건</span>}
            </p>
            <div className="form-actions">
              <button type="button" className="more" onClick={copy}>
                {copied ? '복사됨' : '내역 복사'}
              </button>
              <span className="fine">거래처 명세서와 맞춰 보거나, 문자·카톡으로 보내 확인받을 때 쓰세요.</span>
            </div>
          </>
        )}

        {done ? (
          <p className="settle-done">
            <b>정산함</b> {md(done.settled_at)}에 {won(n(done.amount))}
            {n(done.amount) !== total && rows && <span className="fine"> (기록 합계 {won(total)}와 {won(Math.abs(n(done.amount) - total))} 차이)</span>}
            {canWrite && (
              <button type="button" className="link-btn" disabled={!!busy} onClick={() => onUnsettle(ym)}>
                정산 취소
              </button>
            )}
          </p>
        ) : (
          canWrite &&
          rows &&
          (rows.length > 0 || ym < now) && (
            <form
              className="settle-form"
              onSubmit={(e) => {
                e.preventDefault();
                onSettle(ym, Number(amount) || 0);
              }}
            >
              <label className="cf-field">
                <span>낸 금액 (원)</span>
                <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} />
              </label>
              <button type="submit" className="primary" disabled={!!busy || amount === ''}>
                {monthKo(ym)} 정산 완료
              </button>
              <p className="fine">명세서 금액과 다르면 실제로 낸 금액을 넣으세요. 기록 합계와 차이가 남아 나중에 확인할 수 있습니다.</p>
            </form>
          )
        )}
      </div>
    </div>
  );
}

function VendorForm({ value, busy, onSave, onCancel, onDelete }: { value: Partial<Vendor>; busy: string; onSave: (v: Partial<Vendor>) => void; onCancel: () => void; onDelete?: () => void }) {
  const [f, setF] = useState(value);
  const set = (k: keyof Vendor, v: string) => setF({ ...f, [k]: v });
  const needs = useMemo(() => {
    if (f.order_method === 'email' && !f.email) return '이메일로 주문하려면 이메일 주소가 필요합니다.';
    if ((f.order_method === 'sms' || f.order_method === 'phone') && !f.phone) return '문자·전화로 주문하려면 휴대폰 번호가 필요합니다.';
    return '';
  }, [f.order_method, f.email, f.phone]);
  return (
    <form
      className="form boxed vendor-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!f.name?.trim()) return;
        onSave({ ...f, name: f.name.trim() });
      }}
    >
      <h4 className="sup-cat">{f.id ? `${value.name} 고치기` : '거래처 추가'}</h4>
      <div className="cf-grid">
        <label className="cf-field">
          <span>거래처 이름</span>
          <input required autoFocus={!f.id} value={f.name ?? ''} placeholder="예: OO상사 (요소수 대리점)" onChange={(e) => set('name', e.target.value)} />
        </label>
        <label className="cf-field">
          <span>담당자</span>
          <input value={f.contact_name ?? ''} placeholder="예: 박 과장" onChange={(e) => set('contact_name', e.target.value)} />
        </label>
        <label className="cf-field">
          <span>주문 방법</span>
          <select value={f.order_method} onChange={(e) => set('order_method', e.target.value as Method)}>
            {(Object.keys(METHOD_KO) as Method[]).map((m) => (
              <option key={m} value={m}>
                {METHOD_KO[m]}
              </option>
            ))}
          </select>
        </label>
        <label className="cf-field">
          <span>휴대폰·전화</span>
          <input type="tel" value={f.phone ?? ''} onChange={(e) => set('phone', e.target.value)} />
        </label>
        <label className="cf-field">
          <span>이메일</span>
          <input type="email" value={f.email ?? ''} onChange={(e) => set('email', e.target.value)} />
        </label>
        <label className="cf-field">
          <span>메모</span>
          <input value={f.note ?? ''} placeholder="예: 화·금 납품, 40통 이상 무료 배송" onChange={(e) => set('note', e.target.value)} />
        </label>
      </div>
      {needs && <p className="fine">{needs}</p>}
      <div className="form-actions">
        <button type="submit" className="primary" disabled={!!busy || !f.name?.trim()}>
          {f.id ? '저장' : '추가'}
        </button>
        <button type="button" className="more" onClick={onCancel}>
          취소
        </button>
        {onDelete && (
          <button type="button" className="link-btn danger" onClick={onDelete}>
            거래처 지우기
          </button>
        )}
      </div>
    </form>
  );
}
