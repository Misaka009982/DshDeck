import { ProtocolFault, requireId, requireKeys, requireRecord } from '../../shared/faults.js';
import { parseContext } from '../../shared/domain.js';
import type { AnswerInput, ReadConfirmation, SendTextInput } from '../../shared/domain.js';

export function parseSendText(value: unknown): SendTextInput {
  const input = requireRecord(value); requireKeys(input, ['context', 'requestId', 'text']);
  if (typeof input.text !== 'string' || input.text.trim() === '' || input.text.length > 65536) throw new ProtocolFault('protocol');
  return { context: parseContext(input.context), requestId: requireId(input.requestId), text: input.text };
}
export function parseAnswerInput(value: unknown): AnswerInput {
  const input = requireRecord(value); requireKeys(input, ['context', 'interactionId', 'value']);
  if (typeof input.value !== 'string' || input.value.length > 65536) throw new ProtocolFault('protocol');
  return { context: parseContext(input.context), interactionId: requireId(input.interactionId), value: input.value };
}
export function parseReadConfirmation(value: unknown): ReadConfirmation {
  const input = requireRecord(value); requireKeys(input, ['context', 'throughSeq', 'visible', 'focused']);
  if (typeof input.throughSeq !== 'number' || !Number.isSafeInteger(input.throughSeq) || input.throughSeq < -1
    || typeof input.visible !== 'boolean' || typeof input.focused !== 'boolean') throw new ProtocolFault('protocol');
  return { context: parseContext(input.context), throughSeq: input.throughSeq, visible: input.visible, focused: input.focused };
}
export function requireBoolean(value: unknown): boolean { if (typeof value !== 'boolean') throw new ProtocolFault('protocol'); return value; }
