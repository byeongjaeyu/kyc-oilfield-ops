/**
 * 잡 결과 저장소
 *  - Supabase 서비스 키가 있으면 datasets 테이블 (key = data/ 아래 상대 경로, 예: prices/latest.json)
 *  - 없으면 로컬 파일 (테스트·샘플 실행용)
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, sep } from 'node:path';
import { env } from './env.ts';
import { rest, supabaseEnabled } from './supabase.ts';

const keyOf = (path: string) => relative(env.dataDir, path).split(sep).join('/');

export async function readJSON<T>(path: string, fallback: T): Promise<T> {
  if (supabaseEnabled()) {
    const rows = await rest<Array<{ data: T }>>(`datasets?select=data&key=eq.${encodeURIComponent(keyOf(path))}`);
    return rows[0]?.data ?? fallback;
  }
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
}

export async function writeJSON(path: string, data: unknown): Promise<void> {
  if (supabaseEnabled()) {
    await rest('datasets?on_conflict=key', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: JSON.stringify({ key: keyOf(path), data, updated_at: new Date().toISOString() }),
    });
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
