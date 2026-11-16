import type { FileDirectory, ProjectFileEntry } from '../../shared/files.js';

export interface FileTreeRow { readonly entry: ProjectFileEntry; readonly depth: number }
export const FILE_TREE_PAGE = 500;
export const FILE_TREE_LIMIT = 10000;
const CACHE_BYTES = 4 * 1024 * 1024;

/** 只筛选已经读取的名称/相对路径；不是远程递归搜索，也不悄悄枚举整个项目。 */
export function fileTreeRows(levels: ReadonlyMap<string, FileDirectory>, expanded: ReadonlySet<string>, query: string, maximum: number): { rows: readonly FileTreeRow[]; more: boolean } {
  const limit = Math.min(FILE_TREE_LIMIT, Math.max(FILE_TREE_PAGE, maximum));
  const rows: FileTreeRow[] = []; const text = query.trim().toLowerCase(); let more = false;
  const add = (entry: ProjectFileEntry, depth: number): void => { if (rows.length >= limit) { more = true; return; } rows.push({ entry, depth }); };
  if (text !== '') {
    const found = new Map<string, ProjectFileEntry>();
    for (const level of levels.values()) for (const entry of level.entries) if (entry.path.toLowerCase().includes(text)) found.set(entry.path, entry);
    for (const entry of [...found.values()].sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'))) add(entry, 0);
  } else {
    const walk = (directory: string, depth: number): void => {
      if (depth > 32) { more = true; return; }
      for (const entry of levels.get(directory)?.entries ?? []) {
        add(entry, depth);
        if (more) return;
        if (entry.type === 'dir' && expanded.has(entry.path)) walk(entry.path, depth + 1);
      }
    };
    walk('', 0);
  }
  return { rows, more };
}
/** 目录元数据同样有内存上限；折叠/重开先显示已有缓存，需要时再明确读取。 */
export function cacheFileDirectory(previous: ReadonlyMap<string, FileDirectory>, directory: FileDirectory): Map<string, FileDirectory> {
  const levels = new Map(previous); levels.delete(directory.directory); levels.set(directory.directory, directory);
  const size = (value: FileDirectory): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  let bytes = [...levels.values()].reduce((sum, value) => sum + size(value), 0);
  while (levels.size > 32 || bytes > CACHE_BYTES) {
    const oldest = [...levels.keys()].find(path => path !== '' && path !== directory.directory);
    if (oldest === undefined) break;
    bytes -= size(levels.get(oldest) as FileDirectory); levels.delete(oldest);
  }
  return levels;
}
