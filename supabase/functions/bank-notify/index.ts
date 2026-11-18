// 은행 입금 문자 → 입금 기록 (휴대폰 자동화가 문자 본문을 이 주소로 보냄)
//  POST /functions/v1/bank-notify?token=<bank_webhooks.token>
//  본문: 문자 원문 그대로(text/plain) 또는 {"text": "..."}
//  주소(토큰)가 속한 주유소의 계약 입금자명과 맞는 입금만 저장 (다른 입금 내역은 저장하지 않음)
import { createClient } from 'npm:@supabase/supabase-js@2';
import { dedupeKey, parseBankSms, payerMatches } from './bankParse.ts';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: false, message: 'POST 로 문자 본문을 보내 주세요.' }, 405);
  const token = new URL(req.url).searchParams.get('token') ?? '';
  if (!/^[0-9a-f]{48}$/.test(token)) return json({ ok: false }, 404);

  const admin = createClient(SB_URL, SERVICE);
  const { data: hook } = await admin.from('bank_webhooks').select('station_id, stations(status)').eq('token', token).maybeSingle();
  if (!hook || (hook.stations as unknown as { status: string } | null)?.status !== 'approved') return json({ ok: false }, 404);

  const rawBody = await req.text();
  let text = rawBody;
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed && typeof parsed.text === 'string') text = parsed.text;
  } catch {
    /* 평문 */
  }
  if (!text.trim()) return json({ ok: false, message: '문자 본문이 비어 있습니다.' }, 400);

  const tx = parseBankSms(text);
  if (!tx) return json({ ok: true, stored: false, message: '입금 문자가 아니어서 건너뜀' });

  const { data: contracts } = await admin
    .from('contracts')
    .select('tenant_name, payer_names')
    .eq('station_id', hook.station_id)
    .eq('status', 'confirmed');
  const names = (contracts ?? []).flatMap((c) => [c.tenant_name, ...(c.payer_names ?? [])]).filter(Boolean);
  if (!payerMatches(tx.payer, names)) {
    return json({ ok: true, stored: false, parsed: tx, message: '입금자명이 계약의 입금자명과 맞지 않아 저장하지 않음' });
  }

  const { data, error } = await admin
    .from('bank_transactions')
    .upsert(
      {
        station_id: hook.station_id,
        occurred_at: tx.occurred_at,
        amount: tx.amount,
        payer: tx.payer,
        memo: tx.memo,
        source: 'sms',
        dedupe_key: dedupeKey(tx),
        created_by: null,
      },
      { onConflict: 'station_id,dedupe_key', ignoreDuplicates: true },
    )
    .select('id, charge_id');
  if (error) return json({ ok: false, message: error.message }, 500);
  const row = data?.[0];
  return json({
    ok: true,
    stored: !!row,
    duplicate: !row,
    matched: !!row?.charge_id,
    parsed: tx,
    message: !row ? '이미 기록된 입금' : row.charge_id ? '입금 기록, 청구와 연결됨' : '입금 기록, 맞는 청구를 못 찾음 (대시보드에서 연결)',
  });
});
