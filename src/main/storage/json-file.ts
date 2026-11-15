import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ProtocolFault } from '../../shared/faults.js';

/** 本地非敏感 JSON 使用 UTF-8 和同目录替换，不保留半份配置。 */
export async function readJson(path: string, maxBytes: number): Promise<unknown | undefined> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) {
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') return undefined;
    throw new ProtocolFault('network');
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new ProtocolFault('budget');
  try { return JSON.parse(text) as unknown; } catch { throw new ProtocolFault('protocol'); }
}
export async function writeJson(path: string, value: unknown, maxBytes: number): Promise<void> {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new ProtocolFault('budget');
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, path);
  } catch {
    await unlink(temporary).catch(() => {});
    throw new ProtocolFault('network');
  }
}
