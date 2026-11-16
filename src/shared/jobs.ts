import type { SessionContext } from './domain.js';
import type { PublicFailure } from './faults.js';
import { ProtocolFault, requireId, requireRecord } from './faults.js';

export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed';
export interface JobRow {
  readonly id: string; readonly kind: string; readonly label: string; readonly owner: string | null; readonly status: JobStatus;
  readonly progress: string | null; readonly detail: string | null; readonly startedAt: number; readonly finishedAt: number | null;
  readonly output: { readonly total: number; readonly earliest: number };
}
export interface JobChunk { readonly at: number; readonly text: string; readonly gapBefore?: true }
export interface JobRowsFrame { readonly type: 'rows'; readonly jobs: readonly JobRow[] }
export type JobFollowFrame =
  | { readonly type: 'opened'; readonly job: JobRow; readonly from: number }
  | { readonly type: 'output'; readonly chunks: readonly JobChunk[]; readonly next: number; readonly lossy?: true }
  | { readonly type: 'status'; readonly job: JobRow };
export interface JobReadScope { readonly context: SessionContext; readonly viewId: string }
export interface JobViewRead extends JobReadScope {
  readonly expandedJobId: string | null; readonly sinceRevision?: number; readonly outputEpoch?: number | null; readonly outputCursor?: number | null; readonly refresh?: boolean;
}
export interface JobOutputDelta {
  readonly jobId: string; readonly epoch: number; readonly cursor: number | null; readonly reset: boolean;
  readonly chunks: readonly JobChunk[]; readonly gapBefore: boolean; readonly state: 'loading' | 'live' | 'cached' | 'stale' | 'settled'; readonly failure: PublicFailure | null;
}
export interface JobPanelSnapshot {
  readonly context: SessionContext; readonly viewId: string; readonly revision: number; readonly rows: readonly JobRow[];
  readonly state: 'loading' | 'live' | 'stale' | 'unavailable'; readonly failure: PublicFailure | null; readonly output: JobOutputDelta | null;
}
export function isLiveJob(job: JobRow): boolean { return job.status === 'running' || job.status === 'stopping'; }
export function observableJob(job: JobRow): boolean { return isLiveJob(job) || job.output.total > 0; }
export function jobByteOffset(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ProtocolFault('protocol'); return value;
}
function text(value: unknown, max: number, optional = false): string | null {
  if (optional && (value === undefined || value === null)) return null;
  if (typeof value !== 'string' || value.length > max) throw new ProtocolFault('protocol'); return value;
}
/** 只保留展示白名单；spillPaths 等服务端文件位置不向本地文件读接口透传。 */
export function parseJobRow(value: unknown, sessionId: string): JobRow {
  const data = requireRecord(value); const output = requireRecord(data.output);
  const owner = data.owner === undefined || data.owner === null ? null : requireId(data.owner);
  if (owner !== null && owner !== sessionId) throw new ProtocolFault('forbidden');
  if (typeof data.status !== 'string' || !['running', 'stopping', 'completed', 'killed', 'failed'].includes(data.status)) throw new ProtocolFault('unsupported');
  const total = jobByteOffset(output.total); const earliest = jobByteOffset(output.earliest); if (earliest > total) throw new ProtocolFault('protocol');
  const id = requireId(data.id); const kind = text(data.kind, 160); const label = text(data.label, 8192);
  if (id.length > 512 || kind === null || kind === '' || label === null) throw new ProtocolFault('protocol');
  return { id, kind, label, owner, status: data.status as JobStatus, progress: text(data.progress, 4096, true), detail: text(data.detail, 4096, true),
    startedAt: jobByteOffset(data.startedAt), finishedAt: data.finishedAt === undefined || data.finishedAt === null ? null : jobByteOffset(data.finishedAt), output: { total, earliest } };
}
export function parseJobRows(value: unknown, sessionId: string): JobRowsFrame {
  const data = requireRecord(value); if (data.type !== 'rows' || !Array.isArray(data.jobs)) throw new ProtocolFault('protocol');
  if (data.jobs.length > 512) throw new ProtocolFault('budget');
  const jobs = data.jobs.map(value => parseJobRow(value, sessionId));
  if (new Set(jobs.map(job => job.id)).size !== jobs.length) throw new ProtocolFault('protocol');
  return { type: 'rows', jobs };
}
export function parseJobFollow(value: unknown, sessionId: string, jobId: string): JobFollowFrame {
  const data = requireRecord(value);
  if (data.type === 'opened' || data.type === 'status') {
    const job = parseJobRow(data.job, sessionId); if (job.id !== jobId) throw new ProtocolFault('forbidden');
    if (data.type === 'status') { if (isLiveJob(job)) throw new ProtocolFault('protocol'); return { type: 'status', job }; }
    return { type: 'opened', job, from: jobByteOffset(data.from) };
  }
  if (data.type !== 'output' || !Array.isArray(data.chunks) || data.chunks.length > 4096 || data.lossy !== undefined && data.lossy !== true) throw new ProtocolFault('protocol');
  let bytes = 0; let end = -1;
  const chunks: JobChunk[] = data.chunks.map(value => {
    const chunk = requireRecord(value); const at = jobByteOffset(chunk.at);
    if (typeof chunk.text !== 'string' || chunk.gapBefore !== undefined && chunk.gapBefore !== true) throw new ProtocolFault('protocol');
    const size = Buffer.byteLength(chunk.text, 'utf8'); bytes += size;
    if (bytes > 2 * 1024 * 1024) throw new ProtocolFault('budget');
    if (at < end || !Number.isSafeInteger(at + size) || Buffer.from(chunk.text, 'utf8').toString('utf8') !== chunk.text) throw new ProtocolFault('protocol');
    end = at + size;
    return { at, text: chunk.text, ...(chunk.gapBefore === true ? { gapBefore: true as const } : {}) };
  });
  const next = jobByteOffset(data.next); if (next < end) throw new ProtocolFault('protocol');
  return { type: 'output', chunks, next, ...(data.lossy === true ? { lossy: true as const } : {}) };
}
