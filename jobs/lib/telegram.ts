import { env } from './env.ts';

const LIMIT = 4000; // 텔레그램 메시지 최대 4096자

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 줄 단위로 4000자 이하 조각으로 나눔 */
function chunk(text: string): string[] {
  const parts: string[] = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if (buf.length + line.length + 1 > LIMIT && buf) {
      parts.push(buf);
      buf = '';
    }
    buf += (buf ? '\n' : '') + line;
  }
  if (buf) parts.push(buf);
  return parts;
}

/**
 * HTML parse_mode 로 전송. 토큰/채팅 ID 가 없으면 건너뛰고 false 반환
 *  chatId: 주유소별 채팅 (기본은 개발자 채팅 TELEGRAM_CHAT_ID)
 */
export async function sendTelegram(html: string, chatId: string = env.telegramChatId): Promise<boolean> {
  if (!env.telegramToken || !chatId) {
    console.log(`[telegram] ${!env.telegramToken ? 'TELEGRAM_BOT_TOKEN' : '받을 채팅 ID'} 없음 — 전송 생략`);
    return false;
  }
  for (const part of chunk(html)) {
    const res = await fetch(`https://api.telegram.org/bot${env.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: part,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Telegram ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return true;
}
