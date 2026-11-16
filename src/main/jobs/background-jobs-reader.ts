import type { SessionContext } from '../../shared/domain.js';
import { preferenceKey } from '../../shared/domain.js';
import { observableJob } from '../../shared/jobs.js';
import type { JobPanelSnapshot, JobReadScope, JobViewRead, JobRow } from '../../shared/jobs.js';
import { ProtocolFault, toPublicFailure } from '../../shared/faults.js';
import type { PublicFailure } from '../../shared/faults.js';
import { recoveryDelayMs } from '../../shared/recovery.js';
import type { WorkbenchAdapter, AdapterSubscription } from '../protocol/adapter.js';
import { JobOutputTail } from './job-output-tail.js';

interface StreamLife { readonly controller: AbortController; subscription: AdapterSubscription | undefined; timer: ReturnType<typeof setTimeout> | undefined }
interface Lease {
  context: SessionContext; readonly viewId: string; rows: readonly JobRow[]; state: JobPanelSnapshot['state']; failure: PublicFailure | null;
  desired: string | null; rowsLife: StreamLife | undefined; outputLife: StreamLife | undefined;
  rowsRetryAt: number; outputRetryAt: number; rowsAttempt: number; outputAttempt: number; expiresAt: number;
}
/** 一个前台面板的轻量列表与单个可见输出流；暂停和过期只取消读取，不停止后台命令。 */
export class BackgroundJobsReader {
  private lease: Lease | undefined;
  private cacheContext: SessionContext | undefined;
  private cacheRows: readonly JobRow[] = [];
  private readonly outputs = new Map<string, JobOutputTail>();
  private readonly released = new Set<string>();
  private revision = 1;
  private outputEpoch = 0;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  constructor(private readonly authorize: (context: SessionContext) => WorkbenchAdapter,
    private readonly report: (context: SessionContext, endpoint: 'job/list' | 'job/follow', error: unknown) => void = () => {}, private readonly now: () => number = Date.now) {}

  read(input: JobViewRead): JobPanelSnapshot | null {
    if (this.disposed) throw new ProtocolFault('cancelled');
    this.authorize(input.context);
    if (this.released.has(this.key(input))) throw new ProtocolFault('cancelled');
    let lease = this.lease;
    if (lease === undefined || !this.sameLease(lease, input)) {
      const reuse = this.cacheContext !== undefined && this.identity(this.cacheContext) === this.identity(input.context);
      const previousRows = reuse ? this.cacheRows : [];
      this.stopLease(); if (!reuse) { this.outputs.clear(); this.cacheRows = []; }
      this.cacheContext = { ...input.context };
      lease = { context: { ...input.context }, viewId: input.viewId, rows: previousRows, state: 'loading', failure: null, desired: null,
        rowsLife: undefined, outputLife: undefined, rowsRetryAt: 0, outputRetryAt: 0, rowsAttempt: 0, outputAttempt: 0, expiresAt: this.now() + 15000 };
      this.lease = lease; this.revision++;
    } else lease.context = { ...input.context };
    lease.expiresAt = this.now() + 15000; this.armExpiry();
    if (input.refresh === true) {
      this.stopRows(lease); this.stopOutput(lease); lease.rowsRetryAt = 0; lease.outputRetryAt = 0;
      lease.rowsAttempt = 0; lease.outputAttempt = 0; lease.state = 'loading'; lease.failure = null; this.revision++;
    }
    if (lease.desired !== input.expandedJobId) {
      this.stopOutput(lease); lease.desired = input.expandedJobId; lease.outputRetryAt = 0; lease.outputAttempt = 0; this.revision++;
    }
    this.ensureRows(lease); this.ensureOutput(lease);
    if (input.sinceRevision === this.revision) return null;
    const output = lease.desired === null ? undefined : this.outputs.get(lease.desired);
    return { context: { ...lease.context }, viewId: lease.viewId, revision: this.revision, rows: lease.rows.map(row => ({ ...row, output: { ...row.output } })),
      state: lease.state, failure: lease.failure, output: output?.delta(input.outputEpoch, input.outputCursor) ?? null };
  }
  release(input: JobReadScope): void {
    this.rememberRelease(this.key(input));
    if (this.lease !== undefined && this.sameLease(this.lease, input)) this.stopLease();
  }
  invalidate(serverId: string, revoke = false): void {
    if (this.cacheContext?.serverId !== serverId && this.lease?.context.serverId !== serverId) return;
    if (this.lease !== undefined) {
      const lease = this.lease; this.stopRows(lease); this.stopOutput(lease); lease.state = 'stale'; lease.rowsRetryAt = this.now(); lease.outputRetryAt = this.now();
      if (revoke) { lease.rows = []; lease.desired = null; }
    }
    if (revoke) { this.outputs.clear(); this.cacheRows = []; this.cacheContext = undefined; }
    else for (const output of this.outputs.values()) output.failed(new ProtocolFault('network'));
    this.revision++;
  }
  removed(serverId: string, sessionId: string): void {
    if (this.cacheContext?.serverId === serverId && this.cacheContext.sessionId === sessionId) {
      this.stopLease(); this.outputs.clear(); this.cacheRows = []; this.cacheContext = undefined; this.revision++;
    }
  }
  clearView(): void { this.stopLease(); }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.stopLease(); this.outputs.clear(); this.released.clear(); }

  private ensureRows(lease: Lease): void {
    if (lease.rowsLife !== undefined || lease.rowsRetryAt > this.now() || this.lease !== lease) return;
    const life = this.life(); lease.rowsLife = life;
    life.timer = setTimeout(() => this.rowsFailed(lease, life, new ProtocolFault('timeout')), 15000);
    try {
      const adapter = this.authorize(lease.context); if (adapter.watchJobRows === undefined) throw new ProtocolFault('unsupported');
      const subscription = adapter.watchJobRows(lease.context.sessionId, {
        item: frame => {
          if (!this.live(lease, life, 'rows')) return;
          clearTimeout(life.timer); life.timer = undefined;
          const changed = lease.state !== 'live' || lease.failure !== null || JSON.stringify(lease.rows) !== JSON.stringify(frame.jobs);
          lease.rows = frame.jobs; this.cacheRows = frame.jobs; lease.state = 'live'; lease.failure = null; lease.rowsAttempt = 0;
          for (const id of this.outputs.keys()) if (!frame.jobs.some(job => job.id === id)) this.outputs.delete(id);
          if (lease.desired !== null && !frame.jobs.some(job => job.id === lease.desired)) { this.stopOutput(lease); lease.desired = null; }
          else if (lease.desired !== null) {
            const job = frame.jobs.find(job => job.id === lease.desired); const output = this.outputs.get(lease.desired);
            if (job !== undefined && output !== undefined && !output.matches(job)) { this.stopOutput(lease); this.outputs.delete(job.id); lease.outputRetryAt = 0; }
          }
          if (changed) this.revision++;
          this.ensureOutput(lease);
        }, failed: error => this.rowsFailed(lease, life, error),
      }, life.controller.signal);
      if (lease.rowsLife === life && !life.controller.signal.aborted) life.subscription = subscription; else subscription.cancel();
    } catch (error) { this.rowsFailed(lease, life, error); }
  }
  private ensureOutput(lease: Lease): void {
    if (lease.desired === null || lease.state !== 'live' || lease.outputLife !== undefined || lease.outputRetryAt > this.now() || this.lease !== lease) return;
    const job = lease.rows.find(job => job.id === lease.desired);
    if (job === undefined || !observableJob(job)) return;
    let output = this.outputs.get(job.id);
    if (output === undefined || !output.matches(job)) {
      output = new JobOutputTail(job, ++this.outputEpoch); this.outputs.set(job.id, output);
      while (this.outputs.size > 8) { const first = this.outputs.keys().next().value; if (first === undefined) break; this.outputs.delete(first); }
    }
    if (output.settled()) return;
    const target = output; const life = this.life(); lease.outputLife = life;
    life.timer = setTimeout(() => this.outputFailed(lease, life, target, new ProtocolFault('timeout')), 15000);
    this.revision++;
    try {
      const adapter = this.authorize(lease.context); if (adapter.followJob === undefined) throw new ProtocolFault('unsupported');
      const subscription = adapter.followJob(lease.context.sessionId, job.id, target.cursor(), {
        item: frame => {
          if (!this.live(lease, life, 'output') || lease.desired !== job.id) return;
          try {
            target.accept(frame); clearTimeout(life.timer); life.timer = undefined; lease.outputAttempt = 0; this.revision++;
            if (frame.type === 'status') { this.stopOutput(lease); lease.outputRetryAt = Infinity; }
          } catch (error) { this.outputFailed(lease, life, target, error); }
        }, failed: error => this.outputFailed(lease, life, target, error),
      }, life.controller.signal);
      if (lease.outputLife === life && !life.controller.signal.aborted) life.subscription = subscription; else subscription.cancel();
    } catch (error) { this.outputFailed(lease, life, target, error); }
  }
  private rowsFailed(lease: Lease, life: StreamLife, error: unknown): void {
    if (this.lease !== lease || lease.rowsLife !== life || life.controller.signal.aborted) return;
    this.stopRows(lease); const failure = toPublicFailure(error); if (failure.kind === 'cancelled') return;
    lease.failure = failure; lease.state = failure.kind === 'unsupported' ? 'unavailable' : 'stale';
    lease.rowsRetryAt = ['network', 'timeout'].includes(failure.kind) ? this.now() + recoveryDelayMs(++lease.rowsAttempt) : Infinity;
    this.report(lease.context, 'job/list', error); this.revision++;
  }
  private outputFailed(lease: Lease, life: StreamLife, output: JobOutputTail, error: unknown): void {
    if (this.lease !== lease || lease.outputLife !== life || life.controller.signal.aborted) return;
    this.stopOutput(lease); const failure = toPublicFailure(error); if (failure.kind === 'cancelled') return;
    output.failed(error); lease.outputRetryAt = ['network', 'timeout'].includes(failure.kind) ? this.now() + recoveryDelayMs(++lease.outputAttempt) : Infinity;
    this.report(lease.context, 'job/follow', error); this.revision++;
  }
  private live(lease: Lease, life: StreamLife, kind: 'rows' | 'output'): boolean {
    if (this.disposed || this.lease !== lease || life.controller.signal.aborted || (kind === 'rows' ? lease.rowsLife : lease.outputLife) !== life) return false;
    try { this.authorize(lease.context); return true; } catch { return false; }
  }
  private life(): StreamLife { return { controller: new AbortController(), subscription: undefined, timer: undefined }; }
  private stopRows(lease: Lease): void { const life = lease.rowsLife; lease.rowsLife = undefined; this.stopLife(life); }
  private stopOutput(lease: Lease): void {
    const life = lease.outputLife; lease.outputLife = undefined; this.stopLife(life);
    if (lease.desired !== null) this.outputs.get(lease.desired)?.pause();
  }
  private stopLife(life: StreamLife | undefined): void { if (life === undefined) return; clearTimeout(life.timer); life.controller.abort(); life.subscription?.cancel(); }
  private stopLease(): void {
    const lease = this.lease; this.lease = undefined; clearTimeout(this.expiry); this.expiry = undefined;
    if (lease !== undefined) { this.stopRows(lease); this.stopOutput(lease); this.rememberRelease(this.key(lease)); }
  }
  private armExpiry(): void {
    if (this.expiry !== undefined) return;
    const lease = this.lease; if (lease === undefined) return;
    this.expiry = setTimeout(() => {
      this.expiry = undefined; if (this.lease !== lease) return;
      if (this.now() >= lease.expiresAt) this.stopLease(); else this.armExpiry();
    }, Math.max(1, lease.expiresAt - this.now()));
  }
  private identity(context: SessionContext): string { return preferenceKey(context.serverId, context.authProfileId, context.sessionId); }
  private key(input: JobReadScope): string { return JSON.stringify([this.identity(input.context), input.context.generation, input.viewId]); }
  private sameLease(lease: Lease, input: JobReadScope): boolean { return this.key(lease) === this.key(input); }
  private rememberRelease(key: string): void { this.released.add(key); if (this.released.size > 4096) this.released.delete(this.released.values().next().value ?? ''); }
}
