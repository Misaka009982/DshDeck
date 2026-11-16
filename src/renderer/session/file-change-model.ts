import type { WireEvent } from '../../shared/domain.js';
import { sensitiveFileName } from '../../shared/files.js';

export interface RecordedFileChange {
  readonly id: string;
  readonly seq: number;
  readonly time: number;
  readonly path: string;
  readonly oldText: string | null;
  readonly newText: string | null;
  readonly stopped: boolean;
  readonly unavailable: boolean;
}
export interface FileChangesView { readonly changes: readonly RecordedFileChange[]; readonly omitted: boolean; readonly filtered: boolean }
const MAX_CHANGES = 80;
const MAX_HUNK_BYTES = 512 * 1024;
const MAX_VIEW_BYTES = 2 * 1024 * 1024;

/** 只投影 tool/result 的实际 meta.diffs；拟修改参数、失败结果和文件当前内容都不是历史 diff。 */
export function recordedFileChanges(events: readonly WireEvent[]): FileChangesView {
  const changes: RecordedFileChange[] = []; let omitted = false; let filtered = false; let bytes = 0;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]; if (event === undefined || event.type !== 'tool/result') continue;
    const data = record(event.data); const message = record(data?.message); const meta = record(data?.meta);
    if (message === null || message.isError === true || message.isError !== undefined && message.isError !== false || meta === null || !Array.isArray(meta.diffs)) continue;
    if (meta.diffs.length > 256) { omitted = true; continue; }
    for (let item = 0; item < meta.diffs.length; item++) {
      if (changes.length >= MAX_CHANGES) { omitted = true; break; }
      const hunk = record(meta.diffs[item]);
      if (hunk === null || typeof hunk.path !== 'string' || hunk.path.length === 0 || hunk.path.length > 4096 || /[\u0000-\u001f\u007f]/u.test(hunk.path)
        || hunk.oldText !== null && typeof hunk.oldText !== 'string' || typeof hunk.newText !== 'string') { omitted = true; continue; }
      if (hunk.path.split(/[\\/]/u).some(sensitiveFileName)) { filtered = true; continue; }
      const characters = (hunk.oldText?.length ?? 0) + hunk.newText.length;
      const size = characters > MAX_HUNK_BYTES ? MAX_HUNK_BYTES + 1 : new TextEncoder().encode((hunk.oldText ?? '') + hunk.newText).byteLength;
      const unavailable = size > MAX_HUNK_BYTES || bytes + size > MAX_VIEW_BYTES;
      if (!unavailable) bytes += size;
      changes.push({ id: `${event.seq}:${item}`, seq: event.seq, time: event.time, path: hunk.path, stopped: meta.stopped === true,
        oldText: unavailable ? null : hunk.oldText, newText: unavailable ? null : hunk.newText, unavailable });
    }
    if (changes.length >= MAX_CHANGES && index > 0) { omitted = true; break; }
  }
  return { changes, omitted, filtered };
}
function record(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
