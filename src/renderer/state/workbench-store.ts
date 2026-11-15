import type { AppBridge, IpcResult } from '../../shared/contracts.js';
import type { SessionContext, WorkbenchSnapshot } from '../../shared/domain.js';
import type { PublicFailure } from '../../shared/faults.js';

/** 只轮询本地 revision；没有 renderer 网络、隐式服务器连接或后台详情订阅。 */
export class WorkbenchClientStore {
  private snapshot: WorkbenchSnapshot | null = null;
  private error: PublicFailure | null = null;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private polling = false;
  constructor(readonly api: AppBridge) {}
  getSnapshot = (): WorkbenchSnapshot | null => this.snapshot;
  getError = (): PublicFailure | null => this.error;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    const poll = async (): Promise<void> => {
      await this.refresh();
      if (!this.stopped) this.timer = setTimeout(() => { void poll(); }, 250);
    };
    void poll();
  }
  stop(): void { this.stopped = true; if (this.timer !== undefined) clearTimeout(this.timer); }
  async refresh(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const result = await this.api.workbench(this.snapshot?.revision);
      if (result.ok) { if (result.value !== null) this.accept(result.value); }
      else { this.error = result.error; this.emit(); }
    } finally { this.polling = false; }
  }
  async select(context: SessionContext): Promise<void> {
    const result = await this.api.selectSession(context);
    if (result.ok) this.accept(result.value); else { this.error = result.error; this.emit(); }
  }
  async action<T>(operation: Promise<IpcResult<T>>): Promise<T | undefined> {
    const result = await operation;
    if (!result.ok) { this.error = result.error; this.emit(); return undefined; }
    this.error = null; this.emit(); void this.refresh();
    return result.value;
  }
  clearError(): void { this.error = null; this.emit(); }
  private accept(snapshot: WorkbenchSnapshot): void {
    if (this.snapshot !== null && snapshot.revision < this.snapshot.revision) return;
    this.snapshot = snapshot; this.emit();
  }
  private emit(): void { for (const listener of this.listeners) listener(); }
}
