export const PET_PROTOCOL_VERSION = 1;
export const PET_MAX_LINE_BYTES = 1024 * 1024;
import { ProtocolFault, requireId, requireKeys, requireRecord } from './faults.js';

export interface PetEnvelope { readonly protocolVersion: 1; readonly instanceId: string; readonly generation: number; readonly revision: number; readonly type: string; readonly payload: unknown }
export interface PetAction { readonly actionId: string; readonly kind: 'open-task' | 'clear-task' | 'open-settings' | 'close-pet' | 'window-state' | 'submit-action'; readonly snapshotRevision: number; readonly taskId?: string }
export function parsePetEnvelope(line: string, instanceId: string, generation: number, lastRevision: number): PetEnvelope {
  if (Buffer.byteLength(line, 'utf8') > PET_MAX_LINE_BYTES) throw new ProtocolFault('budget');
  let value: unknown; try { value = JSON.parse(line) as unknown; } catch { throw new ProtocolFault('protocol'); }
  const envelope = requireRecord(value);
  requireKeys(envelope, ['protocolVersion', 'instanceId', 'generation', 'revision', 'type', 'payload']);
  if (envelope.protocolVersion !== PET_PROTOCOL_VERSION || envelope.instanceId !== instanceId || envelope.generation !== generation
    || typeof envelope.revision !== 'number' || !Number.isSafeInteger(envelope.revision) || envelope.revision <= lastRevision
    || !['hello', 'ready', 'action', 'diagnostic'].includes(String(envelope.type))) throw new ProtocolFault('protocol');
  return envelope as unknown as PetEnvelope;
}
export function parsePetAction(value: unknown, snapshotRevision: number): PetAction {
  const action = requireRecord(value);
  const actionId = requireId(action.actionId);
  if (actionId.length > 160 || action.snapshotRevision !== snapshotRevision
    || !['open-task', 'clear-task', 'open-settings', 'close-pet', 'window-state', 'submit-action'].includes(String(action.kind))) throw new ProtocolFault('cancelled');
  const kind = action.kind as PetAction['kind'];
  if (kind === 'open-task' || kind === 'clear-task') {
    requireKeys(action, ['actionId', 'kind', 'snapshotRevision', 'taskId']);
    const taskId = requireId(action.taskId);
    if (taskId.length > 512) throw new ProtocolFault('protocol');
    return { actionId, kind, snapshotRevision, taskId };
  }
  if (kind === 'window-state') {
    requireKeys(action, ['actionId', 'kind', 'snapshotRevision', 'position']);
    const position = requireRecord(action.position); requireKeys(position, ['x', 'y']);
    if (typeof position.x !== 'number' || typeof position.y !== 'number' || !Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new ProtocolFault('protocol');
  } else if (kind !== 'submit-action') requireKeys(action, ['actionId', 'kind', 'snapshotRevision']);
  return { actionId, kind, snapshotRevision };
}
