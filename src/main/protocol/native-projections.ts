import { isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol';
import { ProtocolFault, requireId, requireKeys, requireRecord } from '../../shared/faults.js';
import { nonnegative } from '../../shared/native-controls.js';
import type { NativeFrame } from '../../shared/native-controls.js';

type ChangeFrame = Extract<NativeFrame, { kind: 'change' }>;
type BaselineFrame = Extract<NativeFrame, { kind: 'baseline' }>;
export function parseProjectionFrame(value: unknown): ChangeFrame | { readonly kind: 'ready' } {
  const frame = requireRecord(value);
  if (frame.type === 'ready') { requireKeys(frame, ['type']); return { kind: 'ready' }; }
  requireKeys(frame, ['type', 'seq', 'changes']);
  if (frame.type !== 'projection' || !Array.isArray(frame.changes) || frame.changes.length > 256) throw new ProtocolFault('protocol');
  const keys = new Set<string>();
  const changes = frame.changes.map(item => {
    const change = requireRecord(item); requireKeys(change, ['key', 'val']); const key = requireId(change.key);
    if (keys.has(key) || !isRemoteJsonValue(change.val)) throw new ProtocolFault('protocol'); keys.add(key);
    return { key, val: change.val };
  });
  if (Buffer.byteLength(JSON.stringify(changes), 'utf8') > 1024 * 1024) throw new ProtocolFault('budget');
  return { kind: 'change', seq: nonnegative(frame.seq), changes };
}
export function parseProjectionBaseline(value: unknown): BaselineFrame {
  if (value === null) throw new ProtocolFault('unsupported');
  const baseline = requireRecord(value);
  if (baseline.kind === 'migration-required') throw new ProtocolFault('unsupported');
  requireKeys(baseline, ['kind', 'asOfSeq', 'values']);
  if (baseline.kind !== 'sequenced' || !isRemoteJsonValue(baseline.values)) throw new ProtocolFault('protocol');
  const values = requireRecord(baseline.values);
  if (Buffer.byteLength(JSON.stringify(values), 'utf8') > 2 * 1024 * 1024) throw new ProtocolFault('budget');
  return { kind: 'baseline', asOfSeq: nonnegative(baseline.asOfSeq, -1), values };
}

/** 先订阅变化再读明确基线；不同水位的变化绝不能靠 ready 或正文游标猜测。 */
export class ProjectionBuffer {
  private cursor: number | undefined;
  private readonly pending: ChangeFrame[] = [];
  private bytes = 0;
  constructor(private readonly accept: (frame: NativeFrame) => void) {}
  change(frame: ChangeFrame): void {
    if (this.cursor !== undefined) {
      if (frame.seq <= this.cursor) return;
      this.accept(frame); this.cursor = frame.seq; return;
    }
    this.bytes += Buffer.byteLength(JSON.stringify(frame), 'utf8');
    if (this.pending.length >= 128 || this.bytes > 2 * 1024 * 1024) throw new ProtocolFault('budget');
    this.pending.push(frame);
  }
  baseline(frame: BaselineFrame): void {
    if (this.cursor !== undefined && frame.asOfSeq < this.cursor) return;
    this.accept(frame); this.cursor = frame.asOfSeq;
    const changes = this.pending.splice(0).sort((left, right) => left.seq - right.seq); this.bytes = 0;
    for (const change of changes) this.change(change);
  }
}
