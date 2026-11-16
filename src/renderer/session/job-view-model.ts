import type { JobOutputDelta, JobRow } from '../../shared/jobs.js';
import { isLiveJob } from '../../shared/jobs.js';

export interface DisplayJobOutput {
  readonly jobId: string; readonly epoch: number; readonly cursor: number | null; readonly text: string;
  readonly gapBefore: boolean; readonly state: JobOutputDelta['state']; readonly failure: JobOutputDelta['failure'];
}
export function mergeJobOutput(previous: DisplayJobOutput | null, delta: JobOutputDelta): DisplayJobOutput {
  const incoming = delta.chunks.map(chunk => chunk.text).join('');
  // 新读取基线未到之前保留已看内容；明确新基线或终态到达才允许替换。
  const waiting = delta.state === 'loading' && incoming === '' && previous?.jobId === delta.jobId;
  let text = waiting && previous !== null ? previous.text : (delta.reset || previous?.jobId !== delta.jobId ? '' : previous?.text ?? '') + incoming;
  let gapBefore = delta.gapBefore || (!delta.reset || waiting) && (previous?.gapBefore ?? false);
  if (text.length > 128 * 1024) { let start = text.length - 128 * 1024; const code = text.charCodeAt(start); if (code >= 0xdc00 && code <= 0xdfff) start++; text = text.slice(start); gapBefore = true; }
  return { jobId: delta.jobId, epoch: delta.epoch, cursor: delta.cursor, text, gapBefore, state: delta.state, failure: delta.failure };
}
export function jobOutputStateLabel(output: DisplayJobOutput | null, fresh: boolean): string {
  if (!fresh) return '输出缓存 · 等待连接恢复';
  if (output === null) return '正在加载输出…';
  const labels: Record<JobOutputDelta['state'], string> = { loading: '正在加载输出…', live: '实时输出', cached: '输出缓存', stale: '输出中断 · 保留缓存', settled: '任务已结束' };
  return labels[output.state];
}
export function orderedJobs(rows: readonly JobRow[]): readonly JobRow[] {
  return [...rows].sort((left, right) => {
    const running = Number(isLiveJob(right)) - Number(isLiveJob(left));
    return running !== 0 ? running : isLiveJob(left) ? left.startedAt - right.startedAt : (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt);
  });
}
export function jobStatusLabel(job: JobRow): string {
  return job.status === 'running' ? '运行中' : job.status === 'stopping' ? '正在停止' : job.status === 'completed' ? '已完成' : job.status === 'killed' ? '已停止' : '失败';
}
export function jobDuration(job: JobRow, now: number): string {
  const seconds = Math.max(0, Math.floor(((isLiveJob(job) ? now : job.finishedAt ?? job.startedAt) - job.startedAt) / 1000));
  const minutes = Math.floor(seconds / 60); const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}小时${minutes % 60}分` : minutes > 0 ? `${minutes}分${seconds % 60}秒` : `${seconds}秒`;
}
/** 只做文本展示：去除终端控制序列，不渲染链接、HTML 或执行输出中的内容。 */
export function jobOutputText(text: string): string {
  return text.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
}
