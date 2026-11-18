/**
 * 은행 입금 문자 / 통장 내역 엑셀 → 입금 거래
 * 대시보드(web)와 Edge Function(bank-notify)이 같이 쓰는 파서. 의존성 없음.
 */

export interface ParsedTx {
  occurred_at: string; // ISO
  amount: number;
  payer: string;
  memo: string;
}

/** DB 의 public.normalize_payer 와 같은 규칙 */
export const normalizePayer = (t: string) =>
  (t ?? '')
    .toLowerCase()
    .replace(/주식회사|㈜|\(주\)|[\s()（）]/g, '');

export function payerMatches(payer: string, names: string[]): boolean {
  const p = normalizePayer(payer);
  if (p.length < 2) return false;
  return names.some((n) => {
    const m = normalizePayer(n);
    return m.length >= 2 && (p.includes(m) || m.includes(p));
  });
}

/** 같은 날·같은 금액·같은 입금자면 같은 거래 (문자와 엑셀로 두 번 들어와도 한 건) */
export const dedupeKey = (t: ParsedTx) => {
  const day = new Date(new Date(t.occurred_at).getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
  return `${day}|${t.amount}|${normalizePayer(t.payer)}`;
};

const toInt = (s: string) => Number(String(s).replace(/[^\d]/g, '')) || 0;

const kst = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) =>
  new Date(Date.UTC(y, mo - 1, d, h - 9, mi, s)).toISOString();

const BANK_WORDS =
  /^(\[?web발신\]?|국민|kb|신한|우리|하나|농협|nh|기업|ibk|카카오뱅크|카카오|토스뱅크|토스|sc제일|sc|씨티|부산|대구|광주|전북|경남|수협|우체국|새마을|신협|케이뱅크|산업|kdb)/i;

/** 은행 입금 알림 문자 한 통 → 입금 거래 (입금이 아니면 null) */
export function parseBankSms(text: string, now = new Date()): ParsedTx | null {
  const raw = (text ?? '').replace(/\r/g, '').trim();
  if (!/입금/.test(raw)) return null;
  if (/출금/.test(raw) && !/입금\s*[\d,]/.test(raw) && raw.indexOf('출금') < raw.indexOf('입금')) return null;

  // 금액: "입금" 다음에 처음 나오는 숫자 (잔액 숫자는 건너뜀)
  const after = raw.slice(raw.indexOf('입금') + 2);
  const amtMatch = after.replace(/잔액[\s\S]*/, '').match(/(\d{1,3}(?:,\d{3})+|\d{4,})\s*원?/);
  if (!amtMatch) return null;
  const amount = toInt(amtMatch[1]);
  if (!amount) return null;

  // 시각: 11/16 14:22 (연도는 올해, 미래면 작년)
  const nowK = new Date(now.getTime() + 9 * 3_600_000);
  let occurred = now.toISOString();
  const dt = raw.match(/(\d{1,2})[/.-](\d{1,2})\s*(?:\(?[월화수목금토일]?\)?)?\s*(\d{1,2}):(\d{2})/);
  if (dt) {
    let y = nowK.getUTCFullYear();
    const iso = kst(y, +dt[1], +dt[2], +dt[3], +dt[4]);
    if (new Date(iso).getTime() > now.getTime() + 86_400_000) y -= 1;
    occurred = kst(y, +dt[1], +dt[2], +dt[3], +dt[4]);
  }

  // 입금자: 은행명·날짜·계좌·금액·키워드를 뺀 나머지 글자 토큰
  const payer = raw
    .replace(/\[[^\]]*\]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t && /[가-힣A-Za-z]/.test(t) && !/\d/.test(t) && !BANK_WORDS.test(t) && !/^(입금|출금|잔액|원|이체|입금액|잔액은)$/.test(t) && !/발신/.test(t))
    .join(' ');
  return { occurred_at: occurred, amount, payer: payer.slice(0, 60), memo: '' };
}

// ── 통장 내역 엑셀/CSV (행 배열) ─────────────────────────────────────
const H = {
  date: /거래\s*일시|거래\s*일자|거래일|일자|날짜|일시/,
  time: /시간|시각/,
  deposit: /입금\s*액|입금\s*금액|맡기신\s*금액|입금(?!자)|받은\s*금액/,
  withdraw: /출금|찾으신/,
  // 입금자 칸은 앞의 것일수록 우선 (적요는 "타행이체"처럼 쓸모없는 값인 경우가 많아 마지막)
  payer: [/입금자|보낸\s*분|의뢰인/, /기재\s*내용/, /^내용$|거래\s*내용|입금\s*내용/, /받는\s*분|상대/, /적요/],
  memo: /적요|메모|비고/,
};

function cellDate(v: unknown): { y: number; mo: number; d: number; h: number; mi: number; s: number } | null {
  if (v instanceof Date && !isNaN(v.getTime())) {
    return { y: v.getFullYear(), mo: v.getMonth() + 1, d: v.getDate(), h: v.getHours(), mi: v.getMinutes(), s: v.getSeconds() };
  }
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    // 엑셀 날짜 일련번호
    const ms = Math.round((v - 25569) * 86_400_000);
    const t = new Date(ms);
    return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds() };
  }
  const s = String(v ?? '').trim();
  const m = s.match(/(\d{4})[.\-/년\s]*(\d{1,2})[.\-/월\s]*(\d{1,2})일?(?:\D+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0) };
}

export interface StatementResult {
  txs: ParsedTx[];
  headerRow: number;
  columns: Record<string, string>;
  error?: string;
}

/** 시트의 행 배열 → 입금 거래 목록. 헤더 줄은 위쪽 30줄 안에서 자동으로 찾음 */
export function parseStatement(rows: unknown[][]): StatementResult {
  const norm = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();
  let hr = -1;
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const cells = (rows[i] ?? []).map(norm);
    if (cells.some((c) => H.date.test(c)) && cells.some((c) => H.deposit.test(c) && !H.withdraw.test(c))) {
      hr = i;
      break;
    }
  }
  if (hr < 0) return { txs: [], headerRow: -1, columns: {}, error: '거래일자와 입금액 칸을 찾지 못했습니다.' };

  const head = rows[hr].map(norm);
  const find = (re: RegExp, not?: RegExp) => head.findIndex((c) => re.test(c) && !(not && not.test(c)));
  const ci = {
    date: find(H.date),
    time: find(H.time, H.date),
    deposit: find(H.deposit, H.withdraw),
    payer: H.payer.map((re) => find(re, /금액|입금\s*액/)).find((i) => i >= 0) ?? -1,
    memo: -1,
  };
  ci.memo = head.findIndex((c, i) => H.memo.test(c) && i !== ci.payer);
  const columns = Object.fromEntries(Object.entries(ci).filter(([, i]) => i >= 0).map(([k, i]) => [k, head[i]]));

  const txs: ParsedTx[] = [];
  for (const row of rows.slice(hr + 1)) {
    if (!row || ci.deposit < 0) continue;
    const amount = toInt(String(row[ci.deposit] ?? ''));
    if (!amount) continue;
    const d = cellDate(row[ci.date]);
    if (!d) continue;
    if (ci.time >= 0 && d.h === 0 && d.mi === 0) {
      const t = String(row[ci.time] ?? '').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
      if (t) Object.assign(d, { h: +t[1], mi: +t[2], s: +(t[3] ?? 0) });
    }
    txs.push({
      occurred_at: kst(d.y, d.mo, d.d, d.h, d.mi, d.s),
      amount,
      payer: ci.payer >= 0 ? norm(row[ci.payer]).slice(0, 60) : '',
      memo: ci.memo >= 0 ? norm(row[ci.memo]).slice(0, 60) : '',
    });
  }
  return { txs, headerRow: hr, columns };
}
