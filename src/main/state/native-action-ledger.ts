import type { SessionContext } from '../../shared/domain.js';
import { ProtocolFault, requireId } from '../../shared/faults.js';
import type { FaultKind } from '../../shared/faults.js';

interface Entry { readonly signature: string; failed: boolean; work: Promise<unknown> }

/** 仅用于明确未提交业务写入的准备失败；网络写入后的取消不得冒充从未发送。 */
export class NativeActionNotSent extends ProtocolFault { constructor(kind: FaultKind = 'cancelled') { super(kind); } }

/** 人工动作只提交一次；重复点击共享同一次等待，未知送达保留账本而不重发。 */
export class NativeActionLedger {
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  async run<T>(context: SessionContext, requestId: string, signature: string, action: () => Promise<T>): Promise<T> {
    if (this.closed) throw new ProtocolFault('cancelled');
    requireId(requestId);
    if (signature.length > 256 * 1024) throw new ProtocolFault('budget');
    const key = JSON.stringify([context.serverId, context.authProfileId, context.generation, context.sessionId, requestId]);
    const previous = this.entries.get(key);
    if (previous !== undefined) {
      if (previous.signature !== signature) throw new ProtocolFault('conflict');
      if (previous.failed) throw new ProtocolFault('uncertain');
      return previous.work as Promise<T>;
    }
    if (this.entries.size >= 512) throw new ProtocolFault('budget');
    const entry: Entry = { signature, failed: false, work: Promise.resolve() };
    const work = Promise.resolve().then(action).catch((error: unknown) => {
      if (error instanceof NativeActionNotSent && this.entries.get(key) === entry) this.entries.delete(key);
      else entry.failed = true;
      throw error;
    });
    entry.work = work; this.entries.set(key, entry);
    return work;
  }
  dispose(): void { this.closed = true; this.entries.clear(); }
}
