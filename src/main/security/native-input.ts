import { parseContext } from '../../shared/domain.js';
import { ProtocolFault, requireId, requireKeys, requireRecord } from '../../shared/faults.js';
import { boundedString, parseGoalRef, parseModelSelection } from '../../shared/native-controls.js';
import type { GoalAction, GoalActionInput, SelectModelInput } from '../../shared/native-controls.js';

export function parseSelectModelInput(value: unknown): SelectModelInput {
  const input = requireRecord(value); requireKeys(input, ['context', 'requestId', 'selection']);
  return { context: parseContext(input.context), requestId: requireId(input.requestId), selection: parseModelSelection(input.selection) };
}
export function parseGoalActionInput(value: unknown): GoalActionInput {
  const input = requireRecord(value); requireKeys(input, ['context', 'requestId', 'action']); const data = requireRecord(input.action);
  let action: GoalAction;
  if (data.kind === 'create') { requireKeys(data, ['kind', 'objective']); action = { kind: 'create', objective: boundedString(data.objective, 16384) }; }
  else if (data.kind === 'edit') { requireKeys(data, ['kind', 'ref', 'objective']); action = { kind: 'edit', ref: parseGoalRef(data.ref), objective: boundedString(data.objective, 16384) }; }
  else {
    requireKeys(data, ['kind', 'ref']);
    if (data.kind !== 'pause' && data.kind !== 'resume' && data.kind !== 'clear') throw new ProtocolFault('protocol');
    action = { kind: data.kind, ref: parseGoalRef(data.ref) };
  }
  return { context: parseContext(input.context), requestId: requireId(input.requestId), action };
}
