/**
 * 기한 알림 — 매일 1회
 *  - #3 법정 검사: D-60, 30, 14, 7, 3, 1, 당일, 기한이 지나면 매주 같은 요일
 *  - #2 계약 일정(확정한 계약만): D-180, 90, 60, 30, 14, 7, 1, 당일
 *  - #1 임대료 미납: 납기 다음 날, 3일, 7일, 14일 지남, 그 뒤로는 매주
 *  - 소모품: 재고가 발주점 이하로 떨어진 품목 (한 번 알리면 다시 채워질 때까지 반복하지 않음)
 *  승인된 주유소마다 따로 계산해 그 주유소의 텔레그램 채팅으로 보냄
 */
import { env } from './lib/env.ts';
import { rest } from './lib/supabase.ts';
import { approvedStations, chatIdFor, type StationRow } from './lib/stations.ts';
import { escapeHtml, sendTelegram } from './lib/telegram.ts';
import { cadenceText, currentPeriod, type Routine } from '../web/src/routines.ts';
import { daysUntil, lastResult, todayKst, type Inspection } from '../web/src/inspections.ts';

const THRESHOLDS = [60, 30, 14, 7, 3, 1, 0];
const CONTRACT_THRESHOLDS = [180, 90, 60, 30, 14, 7, 1, 0];
const LATE_DAYS = [1, 3, 7, 14];

interface ChargeStatus {
  contract_title: string;
  period: string;
  due_date: string;
  expected_amount: number;
  paid_amount: number;
  status: string;
}
const won = (n: number) => `${n.toLocaleString('ko-KR')}원`;

interface ContractEvent {
  kind: string;
  date: string;
  title: string;
  note: string;
}

async function main() {
  const today = process.env.TODAY_OVERRIDE || todayKst();
  const stations = await approvedStations();
  let failed = 0;
  for (const st of stations) {
    try {
      await runStation(st, today);
    } catch (err) {
      failed++;
      console.error(`[${st.name}] 실패: ${(err as Error).message}`);
    }
  }
  if (failed) process.exitCode = 1;
}

async function runStation(st: StationRow, today: string) {
  const sid = `station_id=eq.${st.id}`;
  const items = await rest<Inspection[]>(`inspections?select=*,inspection_results(*)&${sid}&order=due.asc.nullslast`);
  const lines: string[] = [];
  let missing = 0;

  for (const it of items) {
    if (!it.due) {
      missing++;
      continue;
    }
    const d = daysUntil(it.due, today);
    const party = it.party ? ` (${it.party} 담당)` : '';
    const due = it.due.replaceAll('-', '.');
    if (THRESHOLDS.includes(d)) {
      lines.push(
        d === 0
          ? `🔴 <b>오늘 마감</b> ${escapeHtml(it.name)}${party}`
          : `${d <= 7 ? '🔴' : '🟡'} <b>D-${d}</b> ${escapeHtml(it.name)}${party} — ${due}`,
      );
    } else if (d < 0 && -d % 7 === 0) {
      const last = lastResult(it);
      lines.push(
        `⚠️ <b>${-d}일 지남</b> ${escapeHtml(it.name)}${party} — 기한 ${due}` +
          (last ? `, 마지막 기록 ${last.done_on.replaceAll('-', '.')}` : ', 결과 기록 없음'),
      );
    }
  }
  console.log(`[${st.name}] 법정 검사 항목 ${items.length}개, 오늘 알릴 것 ${lines.length}개, 기한 미입력 ${missing}개`);

  const events = await rest<ContractEvent[]>(
    `contract_events?select=kind,date,title,note,contracts!inner(status)&${sid}&contracts.status=eq.confirmed&order=date.asc`,
  );
  const contractLines: string[] = [];
  for (const e of events) {
    const d = daysUntil(e.date, today);
    if (!CONTRACT_THRESHOLDS.includes(d)) continue;
    const icon = d <= 30 ? '🔴' : '🟡';
    contractLines.push(
      `${icon} <b>${d === 0 ? '오늘' : `D-${d}`}</b> ${escapeHtml(e.title)} — ${e.date.replaceAll('-', '.')}` +
        (e.note ? `\n   ${escapeHtml(e.note)}` : ''),
    );
  }
  console.log(`[${st.name}] 계약 일정 ${events.length}개, 오늘 알릴 것 ${contractLines.length}개`);

  const late = await rest<ChargeStatus[]>(
    `rent_charge_status?select=contract_title,period,due_date,expected_amount,paid_amount,status&${sid}&status=in.(미납,부분)&due_date=lt.${today}&order=due_date.asc`,
  );
  const multi = new Set(late.map((c) => c.contract_title)).size > 1;
  const payLines: string[] = [];
  for (const c of late) {
    const over = -daysUntil(c.due_date, today);
    if (!LATE_DAYS.includes(over) && !(over > 14 && over % 7 === 0)) continue;
    const left = c.expected_amount - c.paid_amount;
    payLines.push(
      `🔴 <b>${over}일 미납</b> ${multi ? `${escapeHtml(c.contract_title)} ` : ''}${Number(c.period.slice(0, 4))}년 ${Number(c.period.slice(5))}월분 ` +
        `${won(left)}` +
        (c.paid_amount > 0 ? ` (받을 금액 ${won(c.expected_amount)} 중 ${won(c.paid_amount)} 입금)` : '') +
        ` — 납기 ${c.due_date.replaceAll('-', '.')}`,
    );
  }
  const lateTotal = late.reduce((s, c) => s + c.expected_amount - c.paid_amount, 0);
  console.log(`[${st.name}] 임대료 납기 지난 미납 ${late.length}건 (${won(lateTotal)}), 오늘 알릴 것 ${payLines.length}개`);

  const low = await rest<Array<{ id: string; name: string; unit: string; stock: number; reorder_point: number; order_qty: number; supply_vendors: { name: string } | null }>>(
    `supply_items?select=id,name,unit,stock,reorder_point,order_qty,supply_vendors(name)&${sid}&active=is.true&reorder_point=gt.0&low_alerted_at=is.null&order=name`,
  );
  const lowItems = low.filter((i) => Number(i.stock) <= Number(i.reorder_point));
  const supplyLines = lowItems.map(
    (i) =>
      `🟡 <b>${escapeHtml(i.name)}</b> 남은 ${Number(i.stock)}${escapeHtml(i.unit)} (발주점 ${Number(i.reorder_point)})` +
      (Number(i.order_qty) ? `, 주문 ${Number(i.order_qty)}${escapeHtml(i.unit)}` : '') +
      (i.supply_vendors?.name ? ` — ${escapeHtml(i.supply_vendors.name)}` : ''),
  );
  console.log(`[${st.name}] 소모품 발주점 이하 새로 ${lowItems.length}개`);
  if (lowItems.length) {
    await rest(`supply_items?id=in.(${lowItems.map((i) => i.id).join(',')})`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: JSON.stringify({ low_alerted_at: new Date().toISOString() }),
    });
  }
  // 반복 할 일: 기한 전날·당일·다음 날에, 아직 체크 안 된 것만
  const routines = await rest<Array<Routine & { routine_checks: Array<{ period: string }> }>>(
    `routines?select=id,title,cadence,due_day,note,active,routine_checks(period)&${sid}&active=is.true`,
  ).catch(() => []);
  const routineLines: string[] = [];
  for (const r of routines) {
    const p = currentPeriod(r, today);
    if (r.routine_checks.some((c) => c.period === p.period) || p.daysLeft > 1 || p.daysLeft < -1) continue;
    const when = p.daysLeft === 1 ? '내일까지' : p.daysLeft === 0 ? '오늘까지' : '어제까지였음';
    routineLines.push(`${p.daysLeft < 0 ? '🔴' : '🟡'} <b>${escapeHtml(r.title)}</b> ${when} (${cadenceText(r)})`);
  }
  console.log(`[${st.name}] 반복 할 일 ${routines.length}개, 오늘 알릴 것 ${routineLines.length}개`);

  if (!lines.length && !contractLines.length && !payLines.length && !supplyLines.length && !routineLines.length) return;

  const msg = [
    `📋 <b>기한 알림</b> ${escapeHtml(st.name)} ${today}`,
    ...(payLines.length
      ? ['', '<b>임대료</b>', ...payLines, '이미 받았다면 입금 확인 탭에 통장 내역을 올려 주세요. 해당 월을 누르면 임차인에게 보낼 안내 문자 초안이 있습니다.']
      : []),
    ...(contractLines.length ? ['', '<b>계약</b>', ...contractLines] : []),
    ...(routineLines.length ? ['', '<b>이번 주·이번 달 할 일</b>', ...routineLines, '했으면 유류 장부에서 체크해 주세요.'] : []),
    ...(supplyLines.length ? ['', '<b>소모품 주문할 때</b>', ...supplyLines, '소모품 탭에서 거래처별 주문서를 바로 보낼 수 있습니다.'] : []),
    ...(lines.length ? ['', '<b>법정 검사·보험</b>', ...lines, '결과지를 받으면 법정 검사 탭에서 결과 등록으로 올려 주세요 (임차인 계정도 가능).'] : []),
    '',
    `대시보드: ${escapeHtml(env.dashboardUrl)}`,
  ].join('\n');
  const sent = await sendTelegram(msg, chatIdFor(st));
  if (!sent) console.log(`\n── 텔레그램 미리보기 (${st.name}) ──\n${msg}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
