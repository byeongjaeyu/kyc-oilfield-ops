// 캘린더 구독 피드 (ICS) — 구글 캘린더 "URL로 추가"에 넣는 주소
//  ?token=<calendar_feeds.token> 이 맞을 때만 계약 일정 + 법정 검사 기한을 돌려줌
import { createClient } from 'npm:@supabase/supabase-js@2';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
const ymd = (d: string) => d.replaceAll('-', '');
const nextDay = (d: string) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
};

/** RFC 5545: 한 줄 75바이트 넘으면 접기 */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let curLen = 0;
  for (const ch of line) {
    const len = new TextEncoder().encode(ch).length;
    if (curLen + len > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      curLen = 0;
    }
    cur += ch;
    curLen += len;
  }
  out.push(cur);
  return out.join('\r\n ');
}

interface Ev {
  uid: string;
  date: string;
  summary: string;
  description: string;
  alarmDays: number;
}

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get('token') ?? '';
  if (!/^[0-9a-f]{48}$/.test(token)) return new Response('Not found', { status: 404 });

  const admin = createClient(SB_URL, SERVICE);
  const { data: feed } = await admin.from('calendar_feeds').select('station_id, stations(name, status)').eq('token', token).maybeSingle();
  const station = feed?.stations as unknown as { name: string; status: string } | null;
  if (!feed || station?.status !== 'approved') return new Response('Not found', { status: 404 });

  // 이 주소를 만든 주유소의 일정만
  const [{ data: events }, { data: inspections }] = await Promise.all([
    admin
      .from('contract_events')
      .select('id, kind, date, title, note, contracts!inner(status)')
      .eq('station_id', feed.station_id)
      .eq('contracts.status', 'confirmed'),
    admin.from('inspections').select('id, name, due, party').eq('station_id', feed.station_id).not('due', 'is', null),
  ]);

  const list: Ev[] = [];
  for (const e of events ?? []) {
    list.push({
      uid: `contract-${e.id}@manddang`,
      date: e.date,
      summary: `[계약] ${e.title}`,
      description: e.note ?? '',
      alarmDays: e.kind === '만기' ? 90 : e.kind === '갱신 통지 마감' ? 30 : 14,
    });
  }
  for (const i of inspections ?? []) {
    list.push({
      uid: `inspection-${i.id}@manddang`,
      date: i.due!,
      summary: `[검사] ${i.name} 기한`,
      description: i.party ? `${i.party} 담당` : '',
      alarmDays: 30,
    });
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//manddang//ko',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${station?.name ?? '주유소'} 일정`,
    'X-WR-TIMEZONE:Asia/Seoul',
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
  ];
  for (const e of list) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${ymd(e.date)}`,
      `DTEND;VALUE=DATE:${ymd(nextDay(e.date))}`,
      `SUMMARY:${esc(e.summary)}`,
      ...(e.description ? [`DESCRIPTION:${esc(e.description)}`] : []),
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${esc(e.summary)}`,
      `TRIGGER:-P${e.alarmDays}D`,
      'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');

  return new Response(lines.map(fold).join('\r\n') + '\r\n', {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="manddang.ics"',
      'Cache-Control': 'private, max-age=900',
    },
  });
});
