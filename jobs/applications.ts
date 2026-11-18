/**
 * 새 주유소 등록 신청 알림 — 사이트 관리자(개발자) 텔레그램으로
 *  4시간마다 돌며, 아직 알리지 않은 심사 대기 신청만 보냄. 주유소별 데이터는 읽지 않고 신청 정보만.
 *  심사가 끝나고 30일 지난 사업자등록증 사본은 지움 (개인정보처리방침의 보관 기간)
 */
import { join } from 'node:path';
import { env } from './lib/env.ts';
import { readJSON, writeJSON } from './lib/store.ts';
import { rest, storageRemove, supabaseEnabled } from './lib/supabase.ts';
import { escapeHtml, sendTelegram } from './lib/telegram.ts';

interface App {
  id: string;
  name: string;
  address: string;
  applicant_role: 'owner' | 'tenant';
  operation: 'leased' | 'self';
  biz_doc_path: string | null;
  created_at: string;
}

if (!supabaseEnabled()) {
  console.log('[applications] SUPABASE_DATA_KEY 없음, 건너뜀');
  process.exit(0);
}

const path = join(env.dataDir, 'sys', 'applications-notified.json');
const seen = await readJSON<{ ids: string[] }>(path, { ids: [] });
const pending = await rest<App[]>('stations?select=id,name,address,applicant_role,operation,biz_doc_path,created_at&status=eq.pending&order=created_at');
const fresh = pending.filter((a) => !seen.ids.includes(a.id));
console.log(`[applications] 심사 대기 ${pending.length}건, 새로 알릴 것 ${fresh.length}건`);

if (fresh.length) {
  const role = (a: App) => (a.operation === 'self' ? '직접 운영' : a.applicant_role === 'owner' ? '임대인' : '임차인');
  const lines = fresh.map(
    (a) => `• <b>${escapeHtml(a.name)}</b> (${role(a)})\n  ${escapeHtml(a.address)}${a.biz_doc_path ? '' : '\n  사업자등록증 아직 안 올림'}`,
  );
  const ok = await sendTelegram(
    [`📮 <b>새 주유소 등록 신청 ${fresh.length}건</b> (대기 전체 ${pending.length}건)`, '', ...lines, '', '사이트 관리 → 등록 신청에서 확인하세요.'].join('\n'),
  );
  // 텔레그램을 못 보냈으면 다음에 다시 시도하도록 기록하지 않음
  if (ok) await writeJSON(path, { ids: pending.map((a) => a.id) });
}

// ── 사업자등록증 보관 기간: 심사 끝나고 30일 ──
const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
const old = await rest<Array<{ id: string; biz_doc_path: string }>>(
  `stations?select=id,biz_doc_path&status=in.(approved,rejected)&biz_doc_path=not.is.null&reviewed_at=lt.${encodeURIComponent(cutoff)}`,
);
for (const s of old) {
  try {
    await storageRemove('biz-docs', [s.biz_doc_path]);
    await rest(`stations?id=eq.${s.id}`, { method: 'PATCH', body: JSON.stringify({ biz_doc_path: null, biz_doc_name: '' }), prefer: 'return=minimal' });
  } catch (e) {
    console.log(`[applications] 사업자등록증 삭제 실패 ${s.id}: ${(e as Error).message}`);
  }
}
console.log(`[applications] 보관 기간 지난 사업자등록증 ${old.length}건 정리`);
