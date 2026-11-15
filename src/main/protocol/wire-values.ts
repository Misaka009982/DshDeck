import { validateSessionEventData, validateSurfaceMetadata } from '@deepseek-ai/dsh-session/surface';
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session/types';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
import { isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol';
import type { AssistantBaseline, AssistantFrame, FollowSnapshot, HistoryPage, TerminalEvidence, WireEvent } from '../../shared/domain.js';
import { ProtocolFault, requireId, requireKeys, requireRecord } from '../../shared/faults.js';
import { parseSessionPageSummary, parseSessionSnapshotSummary } from './read-values.js';

/** 当前事件信封及 surface 语义复用拥有者的公开校验，不执行未知事件。 */
export function parseWireEvent(value: unknown): WireEvent {
  const event = requireRecord(value);
  requireKeys(event, ['type', 'seq', 'time', 'data'], ['ignorable', 'surfaceOp', 'sourceEventSeqs']);
  requireId(event.type);
  integer(event.seq, 0); integer(event.time, 0);
  if (!isRemoteJsonValue(event.data) || (event.ignorable !== undefined && event.ignorable !== true)) throw new ProtocolFault('protocol');
  try {
    validateSurfaceMetadata(event as unknown as SessionEvent);
    validateSessionEventData(event as unknown as SessionEvent, 'DshDeck event');
  } catch { throw new ProtocolFault('protocol'); }
  return structuredClone(event) as unknown as WireEvent;
}
export function parseHistory(value: unknown): HistoryPage {
  const summary = parseSessionPageSummary(value);
  const page = requireRecord(value);
  return { cursor: summary.cursor, hasMore: summary.hasMore, events: records(page.records) };
}
export function parseFollowSnapshot(value: unknown, sessionId: string): FollowSnapshot {
  const summary = parseSessionSnapshotSummary(value, sessionId);
  const snapshot = requireRecord(value);
  const header = requireRecord(snapshot.header);
  if (header.version !== SESSION_FORMAT_VERSION) throw new ProtocolFault('unsupported');
  const projections = requireRecord(snapshot.projections);
  if (snapshot.assistantStream === undefined) throw new ProtocolFault('protocol');
  return {
    header: { id: sessionId, createdAt: integer(header.createdAt, 0), version: SESSION_FORMAT_VERSION },
    cursor: summary.cursor, hasMore: summary.hasMore, events: records(snapshot.records),
    projections: structuredClone(requireRecord(projections.values)), assistant: parseAssistantBaseline(snapshot.assistantStream),
  };
}
export function parseAssistantBaseline(value: unknown): AssistantBaseline {
  const baseline = requireRecord(value);
  requireKeys(baseline, ['revision'], ['activeAttempt']);
  const revision = integer(baseline.revision, 0);
  if (baseline.activeAttempt === undefined) return { revision, activeAttempt: null };
  const attempt = requireRecord(baseline.activeAttempt);
  requireKeys(attempt, ['attemptId', 'startedAfterSeq', 'turn', 'step', 'nextIndex', 'stream']);
  if (!Array.isArray(attempt.stream) || !isRemoteJsonValue(attempt.stream)) throw new ProtocolFault('protocol');
  return { revision, activeAttempt: {
    attemptId: requireId(attempt.attemptId), startedAfterSeq: integer(attempt.startedAfterSeq, -1),
    turn: integer(attempt.turn, 0), step: integer(attempt.step, 0), nextIndex: integer(attempt.nextIndex, 0), stream: structuredClone(attempt.stream),
  } };
}
export function parseAssistantFrame(value: unknown): AssistantFrame {
  const frame = requireRecord(value);
  const attemptId = requireId(frame.attemptId);
  const revision = integer(frame.revision, 0);
  if (frame.type === 'start') {
    requireKeys(frame, ['type', 'attemptId', 'revision', 'startedAfterSeq', 'turn', 'step']);
    return { type: 'start', attemptId, revision, startedAfterSeq: integer(frame.startedAfterSeq, -1), turn: integer(frame.turn, 0), step: integer(frame.step, 0) };
  }
  if (frame.type === 'chunk') {
    requireKeys(frame, ['type', 'attemptId', 'revision', 'index', 'time', 'chunk']);
    if (!isRemoteJsonValue(frame.chunk)) throw new ProtocolFault('protocol');
    return { type: 'chunk', attemptId, revision, index: integer(frame.index, 0), time: integer(frame.time, 0), chunk: structuredClone(frame.chunk) };
  }
  if (frame.type === 'end') {
    requireKeys(frame, ['type', 'attemptId', 'revision', 'index', 'outcome']);
    const outcome = requireRecord(frame.outcome);
    if (outcome.kind === 'committed') {
      requireKeys(outcome, ['kind', 'seq', 'eventType']);
      if (outcome.eventType !== 'assistant/message' && outcome.eventType !== 'assistant/attempt') throw new ProtocolFault('protocol');
      return { type: 'end', attemptId, revision, index: integer(frame.index, 0), outcome: { kind: 'committed', seq: integer(outcome.seq, 0), eventType: outcome.eventType } };
    }
    requireKeys(outcome, ['kind']);
    if (outcome.kind !== 'abandoned') throw new ProtocolFault('protocol');
    return { type: 'end', attemptId, revision, index: integer(frame.index, 0), outcome: { kind: 'abandoned' } };
  }
  throw new ProtocolFault('protocol');
}
export function terminalFromEvent(event: WireEvent): TerminalEvidence | null {
  if (event.type !== 'turn/end') return null;
  const data = requireRecord(event.data);
  const reason = requireRecord(data.reason);
  const kind: TerminalEvidence['kind'] = reason.kind === 'completed' ? 'completed'
    : reason.kind === 'error' ? 'failed' : reason.kind === 'aborted' ? 'cancelled' : 'unknown';
  return { kind, turn: integer(data.turn, 0), seq: event.seq };
}
export function parsePassiveState(value: unknown): { cursor: number; active: boolean; running: boolean; pendingInput: readonly string[] } {
  const state = requireRecord(value);
  requireKeys(state, ['cursor', 'active', 'running', 'queue', 'pendingInput']);
  if (typeof state.active !== 'boolean' || typeof state.running !== 'boolean' || (state.queue !== null && !Array.isArray(state.queue))
    || !Array.isArray(state.pendingInput) || state.pendingInput.some(value => !['approval', 'question', 'other'].includes(String(value)))) throw new ProtocolFault('protocol');
  return { cursor: integer(state.cursor, -1), active: state.active, running: state.running, pendingInput: state.pendingInput as string[] };
}
function records(value: unknown): readonly WireEvent[] {
  if (!Array.isArray(value)) throw new ProtocolFault('protocol');
  return value.map(item => {
    const entry = requireRecord(item); requireKeys(entry, ['type', 'event']);
    if (entry.type !== 'event') throw new ProtocolFault('protocol');
    return parseWireEvent(entry.event);
  });
}
function integer(value: unknown, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || Object.is(value, -0)) throw new ProtocolFault('protocol');
  return value;
}
