import { supabase } from './supabase';

/** 수집 데이터 (Actions 가 Supabase datasets 테이블에 올린 JSON). 임대인 계정만 읽을 수 있다 */
export async function getJSON<T>(key: string): Promise<T | null> {
  const { data, error } = await supabase.from('datasets').select('data').eq('key', key).maybeSingle();
  if (error || !data) return null;
  return data.data as T;
}

/** ISO 또는 YYYY-MM-DD → 11.14 */
export const md = (iso: string) => {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00+09:00` : iso);
  return d
    .toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric' })
    .replace(/\.\s?/g, '.')
    .replace(/\.$/, '');
};

export const won = (n: number) => `${n.toLocaleString('ko-KR')}원`;
