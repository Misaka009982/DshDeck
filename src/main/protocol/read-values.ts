import { ProtocolFault, requireId, requireKeys, requireRecord } from '../../shared/faults.js';
import type { SessionBrief, WorkspaceBrief } from '../../shared/contracts.js';
import { parseSessionTitle } from '../../shared/session-title.js';

interface WorkspaceBaseline {
  readonly items: readonly WorkspaceBrief[];
  readonly archivedSessionIds: readonly string[];
  readonly pinnedSessionIds: readonly string[];
}
export type WorkspaceReadFrame =
  | { readonly type: 'baseline' | 'replace'; readonly value: WorkspaceBaseline }
  | { readonly type: 'upsert'; readonly workspace: WorkspaceBrief }
  | { readonly type: 'remove'; readonly workspaceId: string }
  | { readonly type: 'order'; readonly workspaceIds: readonly string[] }
  | { readonly type: 'archived'; readonly archivedSessionIds: readonly string[] }
  | { readonly type: 'pinned'; readonly pinnedSessionIds: readonly string[] };

export interface SessionPageSummary {
  readonly cursor: number;
  readonly hasMore: boolean;
  readonly recordCount: number;
  readonly firstSeq: number | null;
}
export interface SessionSnapshotSummary extends SessionPageSummary {
  readonly assistant: { revision: number; nextIndex: number; chunkCount: number } | null;
}

export function parseWorkspaceFrame(value: unknown): WorkspaceReadFrame {
  const frame = requireRecord(value);
  switch (frame.type) {
    case 'baseline':
    case 'replace':
      requireKeys(frame, ['type', 'value']);
      return { type: frame.type, value: parseWorkspaceBaseline(frame.value) };
    case 'upsert':
      requireKeys(frame, ['type', 'workspace']);
      return { type: 'upsert', workspace: parseWorkspace(frame.workspace) };
    case 'remove':
      requireKeys(frame, ['type', 'workspaceId']);
      return { type: 'remove', workspaceId: requireId(frame.workspaceId) };
    case 'order':
      requireKeys(frame, ['type', 'workspaceIds']);
      return { type: 'order', workspaceIds: idList(frame.workspaceIds) };
    case 'archived':
      requireKeys(frame, ['type', 'archivedSessionIds']);
      return { type: 'archived', archivedSessionIds: idList(frame.archivedSessionIds) };
    case 'pinned':
      requireKeys(frame, ['type', 'pinnedSessionIds']);
      return { type: 'pinned', pinnedSessionIds: idList(frame.pinnedSessionIds) };
    default:
      throw new ProtocolFault('protocol');
  }
}

function parseWorkspaceBaseline(value: unknown): WorkspaceBaseline {
  const baseline = requireRecord(value);
  requireKeys(baseline, ['items', 'archivedSessionIds', 'pinnedSessionIds']);
  const items = boundedArray(baseline.items).map(parseWorkspace);
  if (new Set(items.map(item => item.workspaceId)).size !== items.length) throw new ProtocolFault('protocol');
  return { items, archivedSessionIds: idList(baseline.archivedSessionIds), pinnedSessionIds: idList(baseline.pinnedSessionIds) };
}

function parseWorkspace(value: unknown): WorkspaceBrief {
  const workspace = requireRecord(value);
  requireKeys(workspace, ['workspaceId', 'path', 'title', 'sessionIds', 'createdAt', 'updatedAt']);
  for (const key of ['createdAt', 'updatedAt'] as const) {
    if (typeof workspace[key] !== 'string' || !Number.isFinite(Date.parse(workspace[key]))) throw new ProtocolFault('protocol');
  }
  return {
    workspaceId: requireId(workspace.workspaceId),
    path: text(workspace.path), title: text(workspace.title), sessionIds: idList(workspace.sessionIds),
  };
}

export function parseSessionList(value: unknown): readonly SessionBrief[] {
  const list = requireRecord(value);
  requireKeys(list, ['items']);
  const items = boundedArray(list.items).map(value => {
    const item = requireRecord(value);
    requireKeys(item, ['sessionId', 'updatedAt', 'running', 'agentAvailable', 'blank'],
      ['formatStatus', 'parentSessionId', 'origin', 'cwd', 'projections']);
    if (typeof item.running !== 'boolean' || typeof item.agentAvailable !== 'boolean' || typeof item.blank !== 'boolean'
      || typeof item.updatedAt !== 'number' || !Number.isFinite(item.updatedAt)) throw new ProtocolFault('protocol');
    if (item.formatStatus !== undefined && item.formatStatus !== 'current' && item.formatStatus !== 'migration-required') throw new ProtocolFault('protocol');
    if (item.origin !== undefined && item.origin !== 'subagent') throw new ProtocolFault('protocol');
    let title: string | undefined;
    let blank = item.blank && !item.running; let updatedAt = item.updatedAt;
    let titleHint: SessionBrief['titleHint'];
    if (item.projections !== undefined) {
      const hints = requireRecord(item.projections); requireKeys(hints, ['kind', 'asOfSeq', 'values']);
      if (hints.kind !== 'cached' && hints.kind !== 'sequenced') throw new ProtocolFault('protocol');
      titleHint = { kind: hints.kind, asOfSeq: integer(hints.asOfSeq, -1) };
      const values = requireRecord(hints.values);
      title = parseSessionTitle(values.title);
      if (values.sessionListMetadata !== undefined) {
        const metadata = requireRecord(values.sessionListMetadata);
        if (metadata.blank !== undefined && typeof metadata.blank !== 'boolean'
          || metadata.lastPromptAt !== undefined && metadata.lastPromptAt !== null && (typeof metadata.lastPromptAt !== 'number' || !Number.isFinite(metadata.lastPromptAt))) throw new ProtocolFault('protocol');
        if (metadata.blank === false) blank = false;
        if (typeof metadata.lastPromptAt === 'number') updatedAt = Math.max(updatedAt, metadata.lastPromptAt);
      }
    }
    return {
      sessionId: requireId(item.sessionId), updatedAt,
      running: item.running, agentAvailable: item.agentAvailable, blank,
      ...(title === undefined ? {} : { title }), ...(titleHint === undefined ? {} : { titleHint }),
      ...(item.parentSessionId === undefined ? {} : { parentSessionId: requireId(item.parentSessionId) }),
      ...(item.origin === undefined ? {} : { origin: 'subagent' as const }),
      ...(item.cwd === undefined ? {} : { cwd: text(item.cwd) }),
      ...(item.formatStatus === undefined ? {} : { formatStatus: item.formatStatus }),
    };
  });
  if (new Set(items.map(item => item.sessionId)).size !== items.length) throw new ProtocolFault('protocol');
  return items;
}

/** 只验证 PoC 的信封和水位，不伪装为完整 Session 业务事件 validator。 */
export function parseSessionPageSummary(value: unknown): SessionPageSummary {
  const page = requireRecord(value);
  requireKeys(page, ['cursor', 'records', 'hasMore']);
  return pageSummary(page);
}

export function parseSessionSnapshotSummary(value: unknown, sessionId: string): SessionSnapshotSummary {
  const snapshot = requireRecord(value);
  requireKeys(snapshot, ['type', 'header', 'cursor', 'records', 'hasMore', 'projections'], ['assistantStream']);
  if (snapshot.type !== 'snapshot') throw new ProtocolFault('protocol');
  const header = requireRecord(snapshot.header);
  requireKeys(header, ['version', 'id', 'createdAt', 'isSeeded'], ['cwd', 'parentSession', 'origin', 'delegationDepth', 'agentPreset']);
  if (requireId(header.id) !== sessionId || typeof header.isSeeded !== 'boolean'
    || typeof header.createdAt !== 'number' || !Number.isFinite(header.createdAt)) throw new ProtocolFault('protocol');
  integer(header.version, 0);
  const summary = pageSummary(snapshot);
  const projections = requireRecord(snapshot.projections);
  requireKeys(projections, ['asOfSeq', 'values']);
  requireRecord(projections.values);
  if (integer(projections.asOfSeq, -1) !== summary.cursor) throw new ProtocolFault('protocol');
  let assistant: SessionSnapshotSummary['assistant'] = null;
  if (snapshot.assistantStream !== undefined) {
    const baseline = requireRecord(snapshot.assistantStream);
    requireKeys(baseline, ['revision'], ['activeAttempt']);
    const revision = integer(baseline.revision, 0);
    if (baseline.activeAttempt !== undefined) {
      const attempt = requireRecord(baseline.activeAttempt);
      requireKeys(attempt, ['attemptId', 'startedAfterSeq', 'turn', 'step', 'nextIndex', 'stream']);
      requireId(attempt.attemptId);
      if (integer(attempt.startedAfterSeq, -1) > summary.cursor) throw new ProtocolFault('protocol');
      integer(attempt.turn, 0);
      integer(attempt.step, 0);
      assistant = { revision, nextIndex: integer(attempt.nextIndex, 0), chunkCount: boundedArray(attempt.stream).length };
    }
  }
  return { ...summary, assistant };
}

function pageSummary(page: Record<string, unknown>): SessionPageSummary {
  const cursor = integer(page.cursor, -1);
  if (typeof page.hasMore !== 'boolean') throw new ProtocolFault('protocol');
  const records = boundedArray(page.records);
  let previous: number | null = null;
  let firstSeq: number | null = null;
  for (const item of records) {
    const record = requireRecord(item);
    requireKeys(record, ['type', 'event']);
    if (record.type !== 'event') throw new ProtocolFault('protocol');
    const event = requireRecord(record.event);
    requireKeys(event, ['type', 'seq', 'time', 'data'], ['ignorable', 'sourceEventSeqs', 'surfaceOp']);
    requireId(event.type);
    const seq = integer(event.seq, 0);
    if (seq > cursor || (previous !== null && seq !== previous + 1)
      || typeof event.time !== 'number' || !Number.isFinite(event.time)
      || (event.ignorable !== undefined && event.ignorable !== true)) throw new ProtocolFault('protocol');
    firstSeq ??= seq;
    previous = seq;
  }
  return { cursor, hasMore: page.hasMore, recordCount: records.length, firstSeq };
}

function integer(value: unknown, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || Object.is(value, -0)) throw new ProtocolFault('protocol');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) throw new ProtocolFault('protocol');
  return value;
}
function boundedArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new ProtocolFault('protocol');
  if (value.length > 10000) throw new ProtocolFault('budget');
  return value as unknown[];
}
function idList(value: unknown): readonly string[] {
  const ids = boundedArray(value).map(requireId);
  if (new Set(ids).size !== ids.length) throw new ProtocolFault('protocol');
  return ids;
}
