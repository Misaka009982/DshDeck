import { lstat, open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ProtocolFault, requireKeys, requireRecord } from '../../shared/faults.js';
import { readJson } from '../storage/json-file.js';

export interface PetAsset {
  readonly id: string;
  readonly displayName: string;
  readonly spritePath: string;
  readonly spriteVersionNumber: 1 | 2;
  readonly states: Readonly<Record<'idle' | 'green' | 'yellow' | 'red' | 'blue', { row: number; frames: number }>>;
}
export async function validatePetAsset(rootPath: string): Promise<PetAsset> {
  const root = await realpath(rootPath).catch(() => { throw new ProtocolFault('not-found'); });
  const manifestPath = await localFile(root, 'pet.json', 64 * 1024);
  const value = requireRecord(await readJson(manifestPath, 64 * 1024));
  const native = typeof value.spritesheetPath === 'string' && value.spritePath === undefined;
  if (native) requireKeys(value, ['id', 'displayName', 'spritesheetPath'], ['spriteVersionNumber', 'description', 'kind']);
  else requireKeys(value, ['id', 'displayName', 'spritePath', 'spriteVersionNumber', 'states']);
  const sprite = native ? value.spritesheetPath : value.spritePath;
  const version = value.spriteVersionNumber === undefined || value.spriteVersionNumber === 'default' || value.spriteVersionNumber === 'v1' ? 1
    : value.spriteVersionNumber === 'v2' ? 2 : value.spriteVersionNumber;
  if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 160 || typeof value.displayName !== 'string' || value.displayName.length === 0 || value.displayName.length > 160
    || typeof sprite !== 'string' || !sprite.toLowerCase().endsWith('.webp') || (version !== 1 && version !== 2)) throw new ProtocolFault('unsupported');
  const spritePath = await localFile(root, sprite, 20 * 1024 * 1024);
  const dimensions = await webpDimensions(spritePath);
  if (dimensions.width !== 1536 || dimensions.height !== (version === 1 ? 1872 : 2288)) throw new ProtocolFault('unsupported');
  if (native) {
    // Codex 原生精灵布局对应 idle/working/waiting/error/success；只传协议所需状态。
    return { id: value.id, displayName: value.displayName, spritePath, spriteVersionNumber: version, states: {
      idle: { row: 0, frames: 6 }, green: { row: 7, frames: 6 }, yellow: { row: 6, frames: 6 }, red: { row: 5, frames: 8 }, blue: { row: 8, frames: 6 },
    } };
  }
  const states = requireRecord(value.states); requireKeys(states, ['idle', 'green', 'yellow', 'red', 'blue']);
  const checked = {} as Record<'idle' | 'green' | 'yellow' | 'red' | 'blue', { row: number; frames: number }>;
  for (const name of ['idle', 'green', 'yellow', 'red', 'blue'] as const) {
    const state = requireRecord(states[name]); requireKeys(state, ['row', 'frames']);
    if (typeof state.row !== 'number' || !Number.isSafeInteger(state.row) || state.row < 0 || state.row >= (version === 1 ? 9 : 11)
      || typeof state.frames !== 'number' || !Number.isSafeInteger(state.frames) || state.frames < 1 || state.frames > 8) throw new ProtocolFault('unsupported');
    checked[name] = { row: state.row, frames: state.frames };
  }
  return { id: value.id, displayName: value.displayName, spritePath, spriteVersionNumber: version, states: checked };
}
export async function localFile(root: string, child: string, maxBytes: number): Promise<string> {
  if (isAbsolute(child) || /^[a-zA-Z][a-zA-Z\d+.-]*:/u.test(child) || /[\u0000-\u001f]/u.test(child)) throw new ProtocolFault('forbidden');
  const candidate = resolve(root, child);
  const distance = relative(root, candidate);
  if (distance === '..' || distance.startsWith(`..${sep}`) || isAbsolute(distance)) throw new ProtocolFault('forbidden');
  let part = root;
  for (const name of distance.split(sep)) {
    part = join(part, name);
    const metadata = await lstat(part).catch(() => { throw new ProtocolFault('not-found'); });
    if (metadata.isSymbolicLink()) throw new ProtocolFault('forbidden');
  }
  const path = await realpath(candidate).catch(() => { throw new ProtocolFault('not-found'); });
  const canonicalDistance = relative(root, path);
  if (canonicalDistance === '..' || canonicalDistance.startsWith(`..${sep}`) || isAbsolute(canonicalDistance)) throw new ProtocolFault('forbidden');
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > maxBytes) throw new ProtocolFault('budget');
  return path;
}
async function webpDimensions(path: string): Promise<{ width: number; height: number }> {
  const file = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(32); const read = await file.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead < 25 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') throw new ProtocolFault('unsupported');
    const type = bytes.toString('ascii', 12, 16);
    if (type === 'VP8X' && read.bytesRead >= 30) return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
    if (type === 'VP8L' && bytes[20] === 0x2f) {
      const packed = bytes.readUInt32LE(21); return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
    }
    if (type === 'VP8 ' && read.bytesRead >= 30 && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    throw new ProtocolFault('unsupported');
  } finally { await file.close(); }
}
