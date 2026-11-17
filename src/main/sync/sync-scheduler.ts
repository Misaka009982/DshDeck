import type { SessionContext } from '../../shared/domain.js';
import { preferenceKey } from '../../shared/domain.js';
import { ProtocolFault } from '../../shared/faults.js';
import { recoveryDelayMs } from '../../shared/recovery.js';

export interface SyncTarget { readonly context: SessionContext; readonly running: boolean; readonly pending: boolean }
interface Job { target: SyncTarget; due: number; busy: boolean; finishing: boolean; retired: boolean; paused: boolean; attempt: number; retryAt: number; controller: AbortController | undefined }

/** 关注不参与调度资格；全局四个/同服一个后台读取，首轮错峰并按会话局部退避。 */
export class SyncScheduler {
  private readonly jobs = new Map<string, Job>();
  private readonly lifetime = new AbortController();
  private foreground: string | null = null;
  private intervalMs = 10000;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active = 0;
  private readonly serverActive = new Map<string, number>();
  constructor(private readonly read: (context: SessionContext, signal: AbortSignal) => Promise<void>, private readonly now: () => number = Date.now,
    private readonly admitted: (context: SessionContext) => boolean = () => true) {}
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
    const current = new Set<string>(); const newStarts = new Map<string, number>();
    const add = (key: string, target: SyncTarget): void => {
      if (!target.running) return;
      const serverId = target.context.serverId; const order = newStarts.get(serverId) ?? 0; newStarts.set(serverId, order + 1);
      this.jobs.set(key, makeJob(target, this.now() + Math.min(order * 500, 5000)));
    };
    for (const target of targets) {
      const key = id(target.context); current.add(key);
      const job = this.jobs.get(key);
      if (key === this.foreground) { if (job !== undefined) this.retire(key, job); continue; }
      if (job === undefined) add(key, target);
      else if (job.retired || job.target.context.generation !== target.context.generation) {
        this.retire(key, job); this.jobs.delete(key); add(key, target);
      } else {
        const ending = job.target.running && !target.running;
        const waiting = !job.target.pending && target.pending;
        if (!job.target.running && target.running) { job.paused = false; job.finishing = false; job.attempt = 0; job.retryAt = 0; }
        if (ending || waiting) { job.due = this.now(); job.finishing = !target.running; }
        job.target = target;
      }
    }
    for (const [key, job] of this.jobs) if (!current.has(key)) this.retire(key, job);
  }
  setIntervalSeconds(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1 || value > 3600) throw new ProtocolFault('protocol');
    this.intervalMs = value * 1000;
    for (const job of this.jobs.values()) if (!job.finishing) job.due = this.now() + this.intervalMs;
  }
  request(context: SessionContext): void {
    if (id(context) === this.foreground) return;
    const key = id(context); const previous = this.jobs.get(key);
    if (previous !== undefined && !previous.retired && previous.target.context.generation === context.generation) {
      previous.due = this.now(); previous.paused = false; previous.attempt = 0; previous.retryAt = 0;
    } else {
      if (previous !== undefined) this.retire(key, previous);
      this.jobs.set(key, makeJob({ context, running: false, pending: false }, this.now()));
    }
  }
  async tick(): Promise<void> {
    if (this.lifetime.signal.aborted) return;
    const work: Promise<void>[] = [];
    const ready = [...this.jobs.entries()].filter(([key, job]) => key !== this.foreground && !job.busy && !job.retired && !job.paused
      && Math.max(job.due, job.retryAt) <= this.now()).sort((left, right) => Math.max(left[1].due, left[1].retryAt) - Math.max(right[1].due, right[1].retryAt));
    for (const [key, job] of ready) {
      if (this.lifetime.signal.aborted) break;
      if (this.jobs.get(key) !== job || job.retired || key === this.foreground) continue;
      const serverId = job.target.context.serverId;
      if (this.active >= 4 || (this.serverActive.get(serverId) ?? 0) >= 1 || !this.admitted(job.target.context)) continue;
      const controller = new AbortController(); const signal = AbortSignal.any([this.lifetime.signal, controller.signal]); job.controller = controller;
      job.busy = true; this.active++; this.serverActive.set(serverId, (this.serverActive.get(serverId) ?? 0) + 1);
      work.push((async () => {
        try { await this.read(job.target.context, signal); job.attempt = 0; job.retryAt = 0; }
        catch (error) {
          if (signal.aborted || !(error instanceof ProtocolFault)) return;
          if (['budget', 'protocol', 'unsupported'].includes(error.kind)) job.paused = true;
          else if (error.kind === 'network' || error.kind === 'timeout') {
            job.attempt = Math.min(job.attempt + 1, 1000000); job.retryAt = this.now() + recoveryDelayMs(job.attempt);
          }
        } finally {
          job.busy = false; job.controller = undefined; this.active--; this.serverActive.set(serverId, Math.max(0, (this.serverActive.get(serverId) ?? 1) - 1));
          // 同身份新代次可能已排队；旧读取收尾只能修改自己的调度项。
          if (this.jobs.get(key) === job) {
            if (job.retired || job.finishing || !job.target.running) this.jobs.delete(key);
            else job.due = this.now() + this.intervalMs;
          }
        }
      })());
    }
    await Promise.all(work);
  }
  pauseServer(serverId: string): void { for (const [key, job] of this.jobs) if (job.target.context.serverId === serverId) this.retire(key, job); }
  dispose(): void { if (this.timer !== undefined) clearTimeout(this.timer); this.lifetime.abort(); this.jobs.clear(); }
  private retire(key: string, job: Job): void { job.retired = true; job.controller?.abort(); if (!job.busy && this.jobs.get(key) === job) this.jobs.delete(key); }
}
function makeJob(target: SyncTarget, due: number): Job { return { target, due, busy: false, finishing: !target.running, retired: false, paused: false, attempt: 0, retryAt: 0, controller: undefined }; }
function id(context: SessionContext): string { return preferenceKey(context.serverId, context.authProfileId, context.sessionId); }
