import { createHash } from 'node:crypto';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import type { PetChoice } from '../../shared/domain.js';
import { ProtocolFault } from '../../shared/faults.js';
import { validatePetAsset } from './pet-assets.js';
import type { PetAsset } from './pet-assets.js';

export interface PetLibraryEntry extends PetChoice { readonly root: string }
export interface PetLibrary { readonly sourceRoot: string; readonly root: string; readonly entries: readonly PetLibraryEntry[]; readonly truncated: boolean }
interface ScanLimits { readonly maxPackages?: number; readonly maxDirectories?: number; readonly maxEntries?: number; readonly maxDepth?: number }

/** 有界只读扫描；不穿过目录链接，不下载、导入或复制宠物素材。 */
export async function scanPetLibrary(sourceRoot: string, limits: ScanLimits = {}): Promise<PetLibrary> {
  const maxPackages = bounded(limits.maxPackages, 256, 256); const maxDirectories = bounded(limits.maxDirectories, 512, 512);
  const maxEntries = bounded(limits.maxEntries, 4096, 4096); const maxDepth = bounded(limits.maxDepth, 3, 3);
  const root = await realpath(sourceRoot).catch(() => { throw new ProtocolFault('not-found'); });
  if (!(await lstat(root)).isDirectory()) throw new ProtocolFault('unsupported');
  const queue = [{ path: root, depth: 0 }]; const entries: PetLibraryEntry[] = [];
  let seen = 0; let visited = 0; let truncated = false;
  while (queue.length > 0) {
    if (visited >= maxDirectories || entries.length >= maxPackages || seen >= maxEntries) { truncated = true; break; }
    const current = queue.shift(); if (current === undefined) break; visited++;
    const manifest = await lstat(join(current.path, 'pet.json')).catch(() => undefined);
    if (manifest !== undefined) {
      const id = `pet-${createHash('sha256').update(JSON.stringify([root, relative(root, current.path)])).digest('hex').slice(0, 24)}`;
      const initial = { id, name: basename(current.path).slice(0, 160), root: current.path };
      try {
        if (manifest.isSymbolicLink()) throw new ProtocolFault('forbidden');
        const asset = await validatePetAsset(current.path);
        entries.push({ ...initial, name: asset.displayName, available: true, message: `可用 · 精灵 V${asset.spriteVersionNumber}` });
      } catch (error) { entries.push({ ...initial, available: false, message: assetFailure(error) }); }
      // 一个包的素材子目录不是另一个宠物库。
      continue;
    }
    let directory;
    try { directory = await opendir(current.path); } catch { if (current.path === root) throw new ProtocolFault('not-found'); continue; }
    for await (const child of directory) {
      seen++; if (seen > maxEntries) { truncated = true; break; }
      if (child.isSymbolicLink() || !child.isDirectory()) continue;
      if (current.depth >= maxDepth) { truncated = true; continue; }
      if (queue.length + visited >= maxDirectories) { truncated = true; continue; }
      const path = await realpath(join(current.path, child.name)).catch(() => undefined); if (path === undefined) continue;
      const distance = relative(root, path);
      if (distance === '..' || distance.startsWith(`..${sep}`) || isAbsolute(distance)) continue;
      queue.push({ path, depth: current.depth + 1 });
    }
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN') || left.id.localeCompare(right.id));
  return { sourceRoot, root, entries, truncated };
}
export async function readPetChoice(library: PetLibrary, id: string): Promise<PetAsset> {
  const entry = library.entries.find(entry => entry.id === id && entry.available);
  if (entry === undefined) throw new ProtocolFault('forbidden');
  if ((await lstat(entry.root)).isSymbolicLink()) throw new ProtocolFault('forbidden');
  const root = await realpath(entry.root);
  const distance = relative(library.root, root);
  if (distance === '..' || distance.startsWith(`..${sep}`) || isAbsolute(distance)) throw new ProtocolFault('forbidden');
  return validatePetAsset(root);
}
function bounded(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new ProtocolFault('budget');
  return value;
}
function assetFailure(error: unknown): string {
  if (!(error instanceof ProtocolFault)) return '无法读取这个宠物包。';
  if (error.kind === 'forbidden') return '资源路径越出宠物目录或含符号链接，已拒绝。';
  if (error.kind === 'budget') return '清单、资源大小或状态索引超过上限。';
  if (error.kind === 'not-found') return '缺少清单或 WebP 精灵资源。';
  if (error.kind === 'protocol') return '宠物清单结构错误。';
  return '格式不支持：需要 Codex WebP 精灵 V1/V2 或兼容旧单包。';
}
