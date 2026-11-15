import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { ProtocolFault, requireKeys, requireRecord } from '../../shared/faults.js';
import { readJson } from '../storage/json-file.js';

export interface PetAsset {
  readonly id: string;
  readonly displayName: string;
  readonly spritePath: string;
  readonly spriteVersionNumber: 1 | 2;
  readonly states: Readonly<Record<'idle' | 'green' | 'yellow' | 'red' | 'blue', { row: number; frames: number }>>;
}
export async function validatePetRuntime(rootPath: string): Promise<{ executable: string; entry: string; root: string }> {
  const root = await realpath(rootPath).catch(() => { throw new ProtocolFault('not-found'); });
  const manifest = requireRecord(await readJson(join(root, 'package.json'), 64 * 1024));
  if (manifest.name !== 'cli-manager-desktop-pet-e' || manifest.main !== 'dist/main.js') throw new ProtocolFault('unsupported');
  const entry = await localFile(root, 'dist/main.js', 4 * 1024 * 1024);
  let executable: string | undefined;
  for (const path of ['node_modules/electron/dist/electron.exe', 'runtime/electron.exe']) {
    try { executable = await localFile(root, path, 256 * 1024 * 1024); break; } catch { /* 只检查明确属于该 companion 的候选，不使用任意 PATH。 */ }
  }
  if (executable === undefined) throw new ProtocolFault('not-found');
  return { executable, entry, root };
}
export async function validatePetAsset(rootPath: string): Promise<PetAsset> {
  const root = await realpath(rootPath).catch(() => { throw new ProtocolFault('not-found'); });
  const value = requireRecord(await readJson(join(root, 'pet.json'), 64 * 1024));
  requireKeys(value, ['id', 'displayName', 'spritePath', 'spriteVersionNumber', 'states']);
  if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 160 || typeof value.displayName !== 'string' || value.displayName.length > 160
    || typeof value.spritePath !== 'string' || !value.spritePath.toLowerCase().endsWith('.webp')
    || (value.spriteVersionNumber !== 1 && value.spriteVersionNumber !== 2)) throw new ProtocolFault('unsupported');
  const spritePath = await localFile(root, value.spritePath, 20 * 1024 * 1024);
  const states = requireRecord(value.states); requireKeys(states, ['idle', 'green', 'yellow', 'red', 'blue']);
  const checked = {} as Record<'idle' | 'green' | 'yellow' | 'red' | 'blue', { row: number; frames: number }>;
  for (const name of ['idle', 'green', 'yellow', 'red', 'blue'] as const) {
    const state = requireRecord(states[name]); requireKeys(state, ['row', 'frames']);
    if (typeof state.row !== 'number' || !Number.isSafeInteger(state.row) || state.row < 0 || state.row > 1000
      || typeof state.frames !== 'number' || !Number.isSafeInteger(state.frames) || state.frames < 1 || state.frames > 1000) throw new ProtocolFault('unsupported');
    checked[name] = { row: state.row, frames: state.frames };
  }
  return { id: value.id, displayName: value.displayName, spritePath, spriteVersionNumber: value.spriteVersionNumber, states: checked };
}
async function localFile(root: string, child: string, maxBytes: number): Promise<string> {
  if (isAbsolute(child)) throw new ProtocolFault('forbidden');
  const path = await realpath(resolve(root, child)).catch(() => { throw new ProtocolFault('not-found'); });
  const distance = relative(root, path);
  if (distance.startsWith('..') || isAbsolute(distance)) throw new ProtocolFault('forbidden');
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > maxBytes) throw new ProtocolFault('budget');
  return path;
}
