import type { SessionContext } from '../../shared/domain.js';
import { preferenceKey } from '../../shared/domain.js';
import { ProtocolFault } from '../../shared/faults.js';

export interface SyncTarget { readonly context: SessionContext; readonly running: boolean; readonly pending: boolean }
interface Job { target: SyncTarget; due: number; busy: boolean; finishing: boolean; retired: boolean; paused: boolean }

/** 关注不参与调度资格；全局四个/每服务器两个读取，运行首轮和终态收尾独立排程。 */
export class SyncScheduler {
  private readonly jobs = new Map<string, Job>();
  private readonly lifetime = new AbortController();
  private foreground: string | null = null;
  private intervalMs = 10000;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active = 0;
  private readonly serverActive = new Map<string, number>();
  constructor(private readonly read: (context: SessionContext, signal: AbortSignal) => Promise<void>, private readonly now: () => number = Date.now) {}
  start(): void {
    if (this.timer !== undefined || this.lifetime.signal.aborted) return;
    const poll = (): void => {
      if (this.lifetime.signal.aborted) return;
      void this.tick();
      this.timer = setTimeout(poll, 200);
    };
    this.timer = setTimeout(poll, 0);
  }
  update(targets: readonly SyncTarget[], selected: SessionContext | null): void {
    this.foreground = selected === null ? null : id(selected);
    const current = new Set<string>();
    for (const target of targets) {
      const key = id(target.context); current.add(key);
      let job = this.jobs.get(key);
      if (key === this.foreground) {
        if (job !== undefined) { job.retired = true; if (!job.busy) this.jobs.delete(key); }
        continue;
      }
      if (job === undefined) {
        if (!target.running) continue;
        job = { target, due: this.now(), busy: false, finishing: false, retired: false, paused: false };
        this.jobs.set(key, job);
      } else {
        if (job.target.context.generation !== target.context.generation) {
          job.retired = true;
          if (!job.busy) { this.jobs.delete(key); if (target.running) this.jobs.set(key, { target, due: this.now(), busy: false, finishing: false, retired: false, paused: false }); }
          continue;
        }
        const ending = job.target.running && !target.running;
        const waiting = !job.target.pending && target.pending;
        if (!job.target.running && target.running) job.paused = false;
        if (ending || waiting) { job.due = this.now(); job.finishing = !target.running; }
        job.target = target;
      }
    }
    for (const [key, job] of this.jobs) if (!current.has(key)) { job.retired = true; if (!job.busy) this.jobs.delete(key); }
  }
  setIntervalSeconds(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1 || value > 3600) throw new ProtocolFault('protocol');
    this.intervalMs = value * 1000;
    for (const job of this.jobs.values()) if (!job.finishing) job.due = this.now() + this.intervalMs;
  }
  request(context: SessionContext): void {
    if (id(context) === this.foreground) return;
    const previous = this.jobs.get(id(context));
    if (previous !== undefined) { previous.due = this.now(); previous.paused = false; }
    else this.jobs.set(id(context), { target: { context, running: false, pending: false }, due: this.now(), busy: false, finishing: true, retired: false, paused: false });
  }
  async tick(): Promise<void> {
    if (this.lifetime.signal.aborted) return;
    const work: Promise<void>[] = [];
    const ready = [...this.jobs.entries()].filter(([key, job]) => key !== this.foreground && !job.busy && !job.retired && !job.paused && job.due <= this.now()).sort((left, right) => left[1].due - right[1].due);
    for (const [key, job] of ready) {
      const serverId = job.target.context.serverId;
      if (this.active >= 4 || (this.serverActive.get(serverId) ?? 0) >= 2) continue;
      job.busy = true; this.active++; this.serverActive.set(serverId, (this.serverActive.get(serverId) ?? 0) + 1);
      work.push(this.read(job.target.context, this.lifetime.signal).catch(error => {
        if (error instanceof ProtocolFault && ['budget', 'protocol', 'unsupported'].includes(error.kind)) job.paused = true;
      }).finally(() => {
        job.busy = false; this.active--; this.serverActive.set(serverId, Math.max(0, (this.serverActive.get(serverId) ?? 1) - 1));
        if (job.retired || job.finishing || !job.target.running) this.jobs.delete(key);
        else job.due = this.now() + this.intervalMs;
      }));
    }
    await Promise.all(work);
  }
  pauseServer(serverId: string): void { for (const [key, job] of this.jobs) if (job.target.context.serverId === serverId) { job.retired = true; if (!job.busy) this.jobs.delete(key); } }
  dispose(): void { if (this.timer !== undefined) clearTimeout(this.timer); this.lifetime.abort(); this.jobs.clear(); }
}
function id(context: SessionContext): string { return preferenceKey(context.serverId, context.authProfileId, context.sessionId); }
