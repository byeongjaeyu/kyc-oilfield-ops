/**
 * 데모 장부 예시 데이터 — 날짜는 모두 "오늘" 기준으로 만들어 언제 열어도 그럴듯하게
 *  사람·회사 이름은 지어낸 것. 실제 주유소와 관계없음
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

export const DEMO_SID = '0de30000-0000-4000-8000-00000000d001';
export const DEMO_UID = '0de30000-0000-4000-8000-00000000u001';
const STAFF_UID = '0de30000-0000-4000-8000-00000000u002';
const CONTRACT = '0de30000-0000-4000-8000-00000000c001';
const V_UREA = '0de30000-0000-4000-8000-00000000v001';
const V_CAR = '0de30000-0000-4000-8000-00000000v002';
const V_MART = '0de30000-0000-4000-8000-00000000v003';

const DAY = 86_400_000;
const kstNow = () => new Date(Date.now() + 9 * 3_600_000);
/** 오늘(KST)에서 n일 뒤 YYYY-MM-DD */
const day = (n = 0) => new Date(kstNow().getTime() + n * DAY).toISOString().slice(0, 10);
/** n일 전 그날 hh:mm (KST) 의 ISO */
const at = (n: number, hh = 10, mm = 0) => new Date(`${day(-n)}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+09:00`).toISOString();
/** 이번 달에서 m달 뒤의 d일 */
const monthDay = (m: number, d: number) => {
  const t = kstNow();
  const y = t.getUTCFullYear();
  const mo = t.getUTCMonth() + m;
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, mo, Math.min(d, last))).toISOString().slice(0, 10);
};
const ym = (m: number) => monthDay(m, 1).slice(0, 7);
let seq = 0;
const id = (p: string) => `0de30000-0000-4000-8000-${p}${String(++seq).padStart(12 - p.length, '0')}`;

export function makeFixtures(): Record<string, Row[]> {
  seq = 0;
  const station: Row = {
    id: DEMO_SID,
    name: '예시 주유소',
    address: '예시시 예시구 예시로 1',
    jibun_address: '',
    opinet_id: 'DEMO',
    brand: '자가상표',
    katec_x: null,
    katec_y: null,
    lawd_cd: '29200',
    dong: '',
    nearby_dongs: [],
    land_keywords: [],
    biz_no: '0000000000',
    biz_doc_path: null,
    biz_doc_name: null,
    applicant_role: 'owner',
    applied_by: DEMO_UID,
    applicant_email: 'demo@example.com',
    status: 'approved',
    review_note: '',
    reviewed_at: at(400),
    is_demo: false,
    telegram_chat_id: '',
    operation: 'self',
    created_at: at(400),
    updated_at: at(400),
  };

  const AREAS = ['prices', 'land', 'policy', 'contracts', 'inspections', 'payments', 'supplies', 'fuel'];
  const permissions = ['owner', 'tenant'].flatMap((role) =>
    AREAS.map((area) => ({
      station_id: DEMO_SID,
      role,
      area,
      can_read: !(role === 'owner' && area === 'fuel'),
      can_write: !(role === 'owner' && area === 'fuel') && !(role === 'tenant' && area === 'payments'),
    })),
  );

  // ── 계약: 2년 8개월 전 시작, 5년 계약, 월 300만 원 + 부가세 ──
  const start = monthDay(-32, 1);
  const end = (() => {
    const s = new Date(`${start}T00:00:00Z`);
    return new Date(Date.UTC(s.getUTCFullYear() + 5, s.getUTCMonth(), 0)).toISOString().slice(0, 10);
  })();
  const nextIncrease = monthDay(4, 1);
  const noticeBy = new Date(Date.parse(`${end}T00:00:00Z`) - 90 * DAY).toISOString().slice(0, 10);
  const contract: Row = {
    id: CONTRACT,
    station_id: DEMO_SID,
    title: '주유소 부지 임대차 계약',
    tenant_name: '(주)한빛에너지',
    start_date: start,
    end_date: end,
    deposit: 100_000_000,
    monthly_rent: 3_000_000,
    vat_included: false,
    rent_due_day: 25,
    auto_renew: false,
    renewal_notice_days: 90,
    increase_rate: 3,
    increase_every_months: 24,
    next_increase_date: nextIncrease,
    increase_rule: '2년마다 직전 임대료의 3% 인상 (소비자물가 상승률이 5%를 넘으면 협의)',
    restoration: '계약이 끝나면 임차인이 지하 저장탱크와 배관을 철거하고 토양오염도 검사 결과 기준 이내로 정화한 뒤 반환',
    restoration_items: ['지하 저장탱크·배관 철거', '토양 정화 (검사 결과 첨부)', '캐노피·주유기 철거'],
    quotes: {
      monthly_rent: '월 차임은 금 삼백만원(₩3,000,000)으로 하며 부가가치세는 별도로 한다.',
      rent_due_day: '임차인은 매월 25일까지 임대인이 지정한 계좌로 차임을 지급한다.',
      renewal_notice_days: '계약 만료 90일 전까지 서면으로 갱신 여부를 통지한다.',
    },
    file_path: null,
    file_name: '임대차계약서_예시.pdf',
    status: 'confirmed',
    note: '',
    payer_names: ['한빛에너지'],
    payments_tracked_from: monthDay(-3, 1),
    created_at: at(30),
    updated_at: at(30),
  };
  const ev = (kind: string, date: string, title: string, note = '') => ({ id: id('e'), station_id: DEMO_SID, contract_id: CONTRACT, kind, date, title, note, auto: true, created_at: at(30) });
  const events = [
    ev('계약 시작', start, '주유소 부지 임대차 계약 시작'),
    ev('임대료 인상', nextIncrease, '임대료 인상 (3%)', '월 3,000,000원 → 3,090,000원'),
    ev('갱신 통지 마감', noticeBy, '갱신 통지 마감', '만기 90일 전까지 갱신 여부 통지'),
    ev('만기', end, '주유소 부지 임대차 계약 만기'),
  ];

  // ── 임대료: 3달 전부터 다음 달까지 ──
  const charges = [-3, -2, -1, 0, 1].map((m) => ({
    id: id('r'),
    station_id: DEMO_SID,
    contract_id: CONTRACT,
    period: ym(m),
    due_date: monthDay(m, 25),
    expected_amount: 3_300_000,
    manual: false,
    note: '',
    created_at: at(30),
  }));
  const tx = (chargeIdx: number | null, date: string, amount: number, payer: string, memo: string, source = 'sms') => ({
    id: id('t'),
    station_id: DEMO_SID,
    occurred_at: new Date(`${date}T14:20:00+09:00`).toISOString(),
    amount,
    payer,
    memo,
    source,
    dedupe_key: `demo-${date}-${amount}-${payer}`,
    charge_id: chargeIdx == null ? null : charges[chargeIdx].id,
    created_by: DEMO_UID,
    created_at: new Date(`${date}T14:21:00+09:00`).toISOString(),
  });
  const transactions = [
    tx(0, monthDay(-3, 24), 3_300_000, '한빛에너지', '임대료', 'excel'),
    tx(1, monthDay(-2, 25), 3_300_000, '한빛에너지', '임대료', 'excel'),
    tx(2, monthDay(-1, 26), 1_650_000, '한빛에너지', '임대료 일부'),
    tx(null, monthDay(-1, 28), 154_000, '한빛에너지', '관리비'),
  ];

  // ── 법정 검사 ──
  const insp = (name: string, due: number | null, cycle: number | null, party: string, agency: string, note = '') => ({
    id: id('i'),
    station_id: DEMO_SID,
    name,
    due: due == null ? null : day(due),
    cycle_months: cycle,
    party,
    agency,
    note,
    created_at: at(300),
    updated_at: at(10),
  });
  const inspections = [
    insp('토양오염도 검사', 7, 12, '임차인', '토양관련전문기관', '결과지는 구청 환경과에 제출'),
    insp('저장탱크 누출검사', 46, 12, '임차인', '한국석유관리원'),
    insp('위험물 정기점검', 112, 12, '임차인', '위험물안전관리자'),
    insp('소방시설 자체점검', 23, 6, '임차인', '소방시설관리업체'),
    insp('화재보험 만기', 198, 12, '임대인', '보험사'),
    insp('환경책임보험 만기', 83, 12, '임차인', '보험사'),
  ];
  const result = (i: number, n: number, verdict: string, note = '') => ({
    id: id('x'),
    station_id: DEMO_SID,
    inspection_id: inspections[i].id,
    done_on: day(-n),
    verdict,
    note,
    file_path: null,
    file_name: null,
    file_type: null,
    file_size: null,
    created_by: DEMO_UID,
    created_at: at(n),
  });
  const results = [result(0, 358, '적합', '불소·TPH 모두 기준 이내'), result(1, 319, '적합'), result(3, 159, '적합'), result(2, 253, '부적합', '정전기 접지선 보완 후 재점검 완료')];

  // ── 소모품 ──
  const vendors = [
    { id: V_UREA, station_id: DEMO_SID, name: '남도케미칼', contact_name: '박 과장', phone: '010-0000-1111', email: '', order_method: 'sms', note: '요소수 40통 이상 무료 배송', created_at: at(200) },
    { id: V_CAR, station_id: DEMO_SID, name: '한길카용품', contact_name: '이 대리', phone: '010-0000-2222', email: 'order@example.com', order_method: 'email', note: '', created_at: at(200) },
    { id: V_MART, station_id: DEMO_SID, name: '동네마트 납품', contact_name: '', phone: '010-0000-3333', email: '', order_method: 'phone', note: '화요일·금요일 납품', created_at: at(200) },
  ];
  const item = (name: string, category: string, unit: string, stock: number, rp: number, oq: number, vendor: string | null, cost: number | null, price: number | null, barcode: string | null = null) => ({
    id: id('s'),
    station_id: DEMO_SID,
    name,
    category,
    unit,
    barcode,
    vendor_id: vendor,
    stock,
    reorder_point: rp,
    order_qty: oq,
    unit_cost: cost,
    sell_price: price,
    active: true,
    note: '',
    low_alerted_at: null,
    created_at: at(200),
    updated_at: at(1),
  });
  const items = [
    item('요소수 10L', '판매 상품', '통', 6, 10, 40, V_UREA, 9_500, 15_000, '8800000000017'),
    item('불스원샷 경유용 500ml', '판매 상품', '병', 3, 5, 24, V_CAR, 6_800, 11_000),
    item('엔진세정제 휘발유용 500ml', '판매 상품', '병', 0, 4, 24, V_CAR, 6_500, 10_000),
    item('사계절 워셔액 1.8L', '판매 상품', '통', 28, 10, 20, V_CAR, 1_500, 3_000),
    item('사은품 생수 500ml', '고객 서비스', '병', 64, 48, 120, V_MART, 250, null),
    item('사은품 물티슈', '고객 서비스', '개', 37, 50, 200, V_MART, 180, null),
    item('주유용 비닐장갑', '주유·운영', '박스', 2, 3, 10, V_MART, 4_000, null),
    item('영수증 용지 (감열지)', '주유·운영', '롤', 14, 10, 30, V_MART, 900, null),
    item('화장실 휴지', '화장실·청소', '롤', 40, 24, 60, V_MART, 600, null),
    item('흡착포 (기름 유출용)', '안전·환경', '장', 45, 20, 100, null, 450, null),
  ];
  const moves: Row[] = [];
  const outs: Array<[number, number[]]> = [
    [0, [3, 2, 4, 2, 3, 1, 4, 2, 3, 2, 4, 3, 2, 1]],
    [1, [1, 0, 2, 1, 0, 1, 1, 0, 2, 1, 0, 1, 1, 0]],
    [4, [6, 8, 5, 7, 9, 6, 8, 7, 5, 6, 8, 7, 6, 9]],
    [5, [9, 7, 8, 10, 6, 8, 9, 7, 8, 9, 10, 7, 8, 6]],
  ];
  for (const [i, perDay] of outs) {
    let stock = items[i].stock + perDay.reduce((s, x) => s + x, 0);
    perDay.forEach((q, k) => {
      if (!q) return;
      const n = 14 - k;
      moves.push({ id: id('m'), station_id: DEMO_SID, item_id: items[i].id, kind: 'out', qty: q, stock_before: stock, stock_after: stock - q, note: '카운터', order_id: null, created_by: STAFF_UID, created_at: at(n, 16, 10) });
      stock -= q;
    });
  }
  // 입고 (지난달·이번 달) → 거래처별 월 입고 내역과 정산
  const today = kstNow().getUTCDate();
  const inMonth = (k: number, d: number, hh = 10) => new Date(`${ym(k)}-${String(k === 0 ? Math.min(d, today) : d).padStart(2, '0')}T${String(hh).padStart(2, '0')}:20:00+09:00`).toISOString();
  const recv = (k: number, d: number, i: number, qty: number, cost: number | null) =>
    moves.push({ id: id('m'), station_id: DEMO_SID, item_id: items[i].id, kind: 'in', qty, stock_before: 0, stock_after: qty, note: '주문 입고', order_id: null, vendor_id: items[i].vendor_id, unit_cost: cost, created_by: DEMO_UID, created_at: inMonth(k, d) });
  recv(-1, 6, 0, 40, 9_500);
  recv(-1, 20, 0, 40, 9_500);
  recv(-1, 9, 1, 24, 6_800);
  recv(-1, 9, 3, 20, 1_500);
  recv(-1, 4, 4, 120, 250);
  recv(-1, 4, 5, 200, 180);
  recv(-1, 18, 6, 10, 4_000);
  recv(0, 2, 8, 60, 600);
  recv(0, 2, 7, 30, null);
  recv(0, 5, 2, 24, 6_500);
  const settlements = [
    { vendor_id: V_CAR, month: `${ym(-1)}-01`, station_id: DEMO_SID, amount: 193_200, note: '', settled_at: inMonth(0, 3, 15), created_by: DEMO_UID },
    { vendor_id: V_MART, month: `${ym(-1)}-01`, station_id: DEMO_SID, amount: 106_000, note: '', settled_at: inMonth(0, 3, 15), created_by: DEMO_UID },
  ];
  const orders = [
    {
      id: id('o'),
      station_id: DEMO_SID,
      vendor_id: V_UREA,
      vendor_name: '남도케미칼',
      status: 'sent',
      lines: [{ item_id: items[0].id, name: '요소수 10L', qty: 40, unit: '통' }],
      message: '안녕하세요, 예시 주유소입니다.\n요소수 10L 40통 주문합니다.\n받는 곳: 예시시 예시구 예시로 1',
      sent_at: at(1, 9, 30),
      received_at: null,
      created_by: DEMO_UID,
      created_at: at(1, 9, 28),
    },
  ];

  // ── 유류 장부 (임차인) ──
  const purchases = [
    { fuel: 'gasoline', n: 3, cost: 1_598.5, l: 20_000 },
    { fuel: 'diesel', n: 2, cost: 1_472, l: 16_000 },
    { fuel: 'gasoline', n: 11, cost: 1_612, l: 20_000 },
    { fuel: 'diesel', n: 9, cost: 1_481.5, l: 16_000 },
  ].map((p) => ({ id: id('p'), station_id: DEMO_SID, fuel: p.fuel, bought_on: day(-p.n), unit_cost: p.cost, liters: p.l, supplier: '한빛석유 대리점', note: '', created_by: DEMO_UID, created_at: at(p.n, 11) }));
  const tanks = [
    { station_id: DEMO_SID, fuel: 'gasoline', capacity_l: 50_000, reorder_l: 12_000, updated_at: at(60) },
    { station_id: DEMO_SID, fuel: 'diesel', capacity_l: 40_000, reorder_l: 10_000, updated_at: at(60) },
  ];
  const dips = [
    { fuel: 'gasoline', n: 1, l: 24_800 },
    { fuel: 'gasoline', n: 8, l: 21_300 },
    { fuel: 'diesel', n: 1, l: 13_900 },
    { fuel: 'diesel', n: 8, l: 18_600 },
  ].map((x) => ({ id: id('d'), station_id: DEMO_SID, fuel: x.fuel, measured_at: at(x.n, 22), liters: x.l, created_by: DEMO_UID, created_at: at(x.n, 22) }));
  const closes: Row[] = [];
  for (let n = 1; n <= 14; n++) {
    const g = 2_900 + ((n * 137) % 520);
    const dsl = 2_500 + ((n * 211) % 610);
    const total = Math.round(g * 1_690 + dsl * 1_570);
    const card = Math.round(total * 0.89);
    const expected = Math.round(card * (1 - 0.015));
    closes.push({
      station_id: DEMO_SID,
      close_on: day(-n),
      gasoline_l: g,
      diesel_l: dsl,
      premium_l: null,
      kerosene_l: null,
      card_sales: card,
      cash_sales: total - card - 60_000,
      other_sales: 60_000,
      card_deposit: n <= 2 ? null : n === 9 ? expected - 12_400 : n === 6 || n === 7 ? null : expected,
      note: n === 9 ? '카드사 한 곳 수수료 다름' : '',
      created_by: DEMO_UID,
      created_at: at(n, 22, 30),
      updated_at: at(n, 22, 30),
    });
  }
  const routine = (title: string, cadence: string, due_day: number, note = '') => ({ id: id('u'), station_id: DEMO_SID, title, cadence, due_day, note, active: true, created_at: at(60) });
  const routines = [
    routine('석유 수급상황 주간보고', 'weekly', 2, '한국석유관리원에 지난주 입·출하 보고'),
    routine('카드 매출 입금 확인', 'weekly', 5, '일 마감 표에서 카드 입금 적기'),
    routine('원천세·4대보험 납부', 'monthly', 10, '직원 3명'),
    routine('임대료 보내기', 'monthly', 25, '계약서 지급일'),
  ];
  const routineChecks = [{ routine_id: routines[2].id, period: day(0).slice(0, 7), station_id: DEMO_SID, done_by: DEMO_UID, done_at: at(7) }];

  const feedback = [
    {
      id: id('f'),
      user_id: DEMO_UID,
      user_email: 'demo@example.com',
      station_id: DEMO_SID,
      kind: 'idea',
      body: '요소수 재고가 떨어지면 거래처에 바로 문자 보낼 수 있으면 좋겠어요.',
      page: 'supplies',
      user_agent: '',
      status: 'done',
      reply: '소모품 화면에 거래처별 주문서 만들기를 넣었습니다. 기준 아래로 떨어진 품목이 모이면 문자 내용을 바로 만들어 드립니다.',
      replied_at: at(12),
      created_at: at(15),
      updated_at: at(12),
    },
  ];

  return {
    stations: [station],
    profiles: [
      { id: DEMO_UID, email: 'demo@example.com', name: '데모 사용자', is_site_admin: false, created_at: at(400) },
      { id: STAFF_UID, email: 'staff@example.com', name: '주유원 김 씨', is_site_admin: false, created_at: at(120) },
    ],
    station_members: [
      { station_id: DEMO_SID, user_id: DEMO_UID, role: 'owner', is_manager: true, created_at: at(400) },
      { station_id: DEMO_SID, user_id: STAFF_UID, role: 'owner', is_manager: false, created_at: at(120) },
    ],
    station_invites: [{ station_id: DEMO_SID, email: 'accountant@example.com', role: 'owner', is_manager: false, invited_by: DEMO_UID, created_at: at(3) }],
    station_permissions: permissions,
    contracts: [contract],
    contract_events: events,
    rent_charges: charges,
    bank_transactions: transactions,
    bank_webhooks: [],
    calendar_feeds: [],
    inspections,
    inspection_results: results,
    supply_vendors: vendors,
    supply_items: items,
    supply_moves: moves,
    supply_orders: orders,
    supply_settlements: settlements,
    chat_profiles: [{ user_id: DEMO_UID, nickname: '예시사장', created_at: at(30), updated_at: at(30) }],
    chat_messages: [
      ['u1', '셀프왕', '요즘 경유 공급가 다들 얼마에 받으세요? 이번 주 또 올랐네요', 26, false],
      ['u2', '광역시3년차', '저희는 지난주보다 L당 20원 정도 올랐어요. 주변이 안 올려서 눈치 보는 중', 25, false],
      ['u3', '요소수장인', '요소수 10L 도매 단가 1만원 넘어가는 곳 있나요?', 8, false],
      ['admin', '운영자', '게시판 열었습니다. 쓰시다 불편한 점은 계정 메뉴 → 의견·버그 보내기로 알려 주세요.', 6, true],
      ['u1', '셀프왕', '세차기 업체 추천 좀 해 주세요. 지금 쓰는 데가 AS가 너무 늦어요', 2, false],
    ].map(([uid, nickname, body, h, admin], i) => ({
      id: `c${i}`,
      user_id: `demo-user-${uid}`,
      nickname,
      is_admin: admin,
      body,
      created_at: new Date(Date.now() - (h as number) * 3_600_000).toISOString(),
    })),
    fuel_settings: [{ station_id: DEMO_SID, card_fee_pct: 1.5, updated_at: at(60) }],
    fuel_purchases: purchases,
    fuel_tanks: tanks,
    fuel_dips: dips,
    daily_closes: closes,
    routines,
    routine_checks: routineChecks,
    feedback,
  };
}
