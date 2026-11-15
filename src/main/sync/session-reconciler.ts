import type { SessionContext } from '../../shared/domain.js';
import { preferenceKey } from '../../shared/domain.js';
import { ProtocolFault } from '../../shared/faults.js';
import type { WorkbenchAdapter } from '../protocol/adapter.js';
import { SessionCache } from './session-cache.js';

/** 同会话单飞；缺口只能通过向后分页补齐，不发送不存在的 afterSeq。 */
export class SessionReconciler {
  private readonly flights = new Map<string, { generation: number; controller: AbortController; work: Promise<void> }>();
  private readonly repairs = new Map<string, { generation: number; signal: AbortSignal; work: Promise<void> }>();
  constructor(private readonly cache: SessionCache, private readonly accepted: (context: SessionContext) => void = () => {}) {}
  synchronize(context: SessionContext, adapter: WorkbenchAdapter, lifetime: AbortSignal): Promise<void> {
    const id = preferenceKey(context.serverId, context.authProfileId, context.sessionId);
    const previous = this.flights.get(id);
    if (previous !== undefined && previous.generation === context.generation && !previous.controller.signal.aborted) return previous.work;
    previous?.controller.abort();
    const controller = new AbortController();
    const signal = AbortSignal.any([lifetime, controller.signal]);
    const work = this.read(context, adapter, signal).finally(() => {
      if (this.flights.get(id)?.controller === controller) { this.flights.delete(id); this.cache.setSyncing(context, false); }
    });
    this.flights.set(id, { generation: context.generation, controller, work });
    return work;
  }
  cancel(context: SessionContext): void { this.flights.get(preferenceKey(context.serverId, context.authProfileId, context.sessionId))?.controller.abort(); }
  cancelServer(serverId: string): void { for (const [id, flight] of this.flights) if (JSON.parse(id)[0] === serverId) flight.controller.abort(); }
  dispose(): void { for (const flight of this.flights.values()) flight.controller.abort(); this.flights.clear(); this.repairs.clear(); }
  repair(context: SessionContext, adapter: WorkbenchAdapter, signal: AbortSignal): Promise<void> {
    const id = preferenceKey(context.serverId, context.authProfileId, context.sessionId);
    const previous = this.repairs.get(id);
    if (previous !== undefined && previous.generation === context.generation && !previous.signal.aborted) return previous.work;
    const work = this.readRepair(context, adapter, signal).finally(() => { if (this.repairs.get(id)?.work === work) this.repairs.delete(id); });
    this.repairs.set(id, { generation: context.generation, signal, work });
    return work;
  }
  private async readRepair(context: SessionContext, adapter: WorkbenchAdapter, signal: AbortSignal): Promise<void> {
    let lastBefore: number | null = null;
    let readBytes = 0;
    for (let pageIndex = 0; pageIndex < 16; pageIndex++) {
      if (signal.aborted) throw new ProtocolFault('cancelled');
      const cached = this.cache.get(context);
      if (cached === undefined || !cached.hasGap) return;
      const before = this.cache.gapBefore(context);
      if (before === null || before === lastBefore) throw new ProtocolFault('protocol');
      lastBefore = before;
      const page = await adapter.history(context.sessionId, before, cached.cursor, signal);
      readBytes += Buffer.byteLength(JSON.stringify(page), 'utf8');
      if (readBytes > 4 * 1024 * 1024) throw new ProtocolFault('budget');
      if (page.events.length === 0) throw new ProtocolFault('protocol');
      if (signal.aborted) throw new ProtocolFault('cancelled');
      this.cache.applyPage(context, page);
    }
    if (this.cache.get(context)?.hasGap) throw new ProtocolFault('budget');
  }
  private async read(context: SessionContext, adapter: WorkbenchAdapter, signal: AbortSignal): Promise<void> {
    this.cache.setSyncing(context, true);
    try {
      const snapshot = await adapter.opening(context.sessionId, signal);
      if (signal.aborted) throw new ProtocolFault('cancelled');
      this.cache.applySnapshot(context, snapshot);
      this.accepted(context);
      await this.repair(context, adapter, signal);
    } catch (error) {
      if (!signal.aborted) this.cache.setFailure(context, error);
      throw error;
    }
  }
}
