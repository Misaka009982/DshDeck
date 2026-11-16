import type { JobChunk, JobFollowFrame, JobOutputDelta, JobRow } from '../../shared/jobs.js';
import { ProtocolFault, toPublicFailure } from '../../shared/faults.js';
import type { PublicFailure } from '../../shared/faults.js';

/** 仅保留有界 UTF-8 展示尾部；游标来自 Host 的绝对字节，不按 JS 字符数推算。 */
export class JobOutputTail {
  private chunks: JobChunk[] = [];
  private bytes = 0;
  private next: number | null = null;
  private opened = false;
  private gapBefore = false;
  private state: JobOutputDelta['state'] = 'loading';
  private failure: PublicFailure | null = null;
  constructor(private job: JobRow, readonly epoch: number, private readonly budget = 256 * 1024) {
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > 2 * 1024 * 1024) throw new ProtocolFault('budget');
  }
  matches(job: JobRow): boolean { return this.job.id === job.id && this.job.kind === job.kind && this.job.owner === job.owner && this.job.startedAt === job.startedAt; }
  cursor(): number | undefined { return this.next ?? undefined; }
  settled(): boolean { return this.state === 'settled'; }
  accept(frame: JobFollowFrame): void {
    if (frame.type === 'opened') {
      if (!this.matches(frame.job) || frame.from > frame.job.output.total || this.next !== null && frame.from < this.next) throw new ProtocolFault('protocol');
      this.job = frame.job; this.next = frame.from; this.opened = true; this.state = 'live'; this.failure = null;
      this.gapBefore ||= frame.from < frame.job.output.earliest || this.chunks.length === 0 && frame.from > 0; return;
    }
    if (!this.opened || this.next === null) throw new ProtocolFault('protocol');
    if (frame.type === 'status') {
      if (!this.matches(frame.job)) throw new ProtocolFault('protocol');
      this.job = frame.job; this.state = 'settled'; this.opened = false; this.failure = null; return;
    }
    if (frame.next < this.next) throw new ProtocolFault('protocol');
    const pending: JobChunk[] = []; let addedBytes = 0; let gap = this.gapBefore;
    let cursor = this.next;
    for (const chunk of frame.chunks) {
      const buffer = Buffer.from(chunk.text, 'utf8'); const end = chunk.at + buffer.length;
      if (end <= cursor) continue;
      if (chunk.at > cursor || chunk.gapBefore === true) gap = true;
      const start = Math.max(0, cursor - chunk.at); const rest = buffer.subarray(start);
      const text = rest.toString('utf8'); if (Buffer.byteLength(text, 'utf8') !== rest.length) throw new ProtocolFault('protocol');
      if (text !== '') { pending.push({ at: chunk.at + start, text }); addedBytes += rest.length; }
      cursor = Math.max(cursor, end);
    }
    if (frame.next > cursor || frame.lossy === true) gap = true;
    this.chunks.push(...pending); this.bytes += addedBytes; this.gapBefore = gap;
    this.next = frame.next; this.state = 'live'; this.failure = null; this.trim();
  }
  pause(): void { this.opened = false; if (this.state !== 'settled') this.state = 'cached'; }
  failed(error: unknown): void { this.opened = false; this.state = 'stale'; this.failure = toPublicFailure(error); }
  delta(expectedEpoch: number | null | undefined, cursor: number | null | undefined): JobOutputDelta {
    const first = this.chunks[0]?.at ?? this.next ?? 0;
    const reset = expectedEpoch !== this.epoch || cursor === null || cursor === undefined || cursor < first || this.next !== null && cursor > this.next;
    const chunks: JobChunk[] = [];
    for (const chunk of this.chunks) {
      const bytes = Buffer.from(chunk.text, 'utf8'); const after = reset ? 0 : Math.max(0, (cursor ?? 0) - chunk.at);
      if (after >= bytes.length) continue;
      const rest = bytes.subarray(after); const text = rest.toString('utf8');
      // 调用者游标异常或位于多字节字符中部时重新给出完整尾部，不生成替代字符。
      if (Buffer.byteLength(text, 'utf8') !== rest.length) return this.delta(null, null);
      chunks.push({ at: chunk.at + after, text });
    }
    return { jobId: this.job.id, epoch: this.epoch, cursor: this.next, reset, chunks, gapBefore: this.gapBefore,
      state: this.state, failure: this.failure };
  }
  private trim(): void {
    while (this.chunks.length > 1024) { const first = this.chunks.shift(); if (first !== undefined) this.bytes -= Buffer.byteLength(first.text, 'utf8'); this.gapBefore = true; }
    while (this.bytes > this.budget && this.chunks.length > 0) {
      const first = this.chunks[0]; if (first === undefined) break; const bytes = Buffer.from(first.text, 'utf8');
      if (this.bytes - bytes.length >= this.budget) { this.chunks.shift(); this.bytes -= bytes.length; }
      else {
        let cut = this.bytes - this.budget;
        while (cut < bytes.length && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut++;
        this.chunks[0] = { at: first.at + cut, text: bytes.subarray(cut).toString('utf8') }; this.bytes -= cut;
      }
      this.gapBefore = true;
    }
  }
}
