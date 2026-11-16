import { parseContext } from '../../shared/domain.js';
import { ProtocolFault, requireId, requireKeys, requireRecord } from '../../shared/faults.js';
import { jobByteOffset } from '../../shared/jobs.js';
import type { JobReadScope, JobViewRead } from '../../shared/jobs.js';

function scope(data: Record<string, unknown>): JobReadScope {
  if (typeof data.viewId !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(data.viewId)) throw new ProtocolFault('protocol');
  return { context: parseContext(data.context), viewId: data.viewId };
}
export function parseJobReadScope(value: unknown): JobReadScope {
  const data = requireRecord(value); requireKeys(data, ['context', 'viewId']); return scope(data);
}
export function parseJobViewRead(value: unknown): JobViewRead {
  const data = requireRecord(value); requireKeys(data, ['context', 'viewId', 'expandedJobId'], ['sinceRevision', 'outputEpoch', 'outputCursor', 'refresh']);
  if (data.refresh !== undefined && typeof data.refresh !== 'boolean') throw new ProtocolFault('protocol');
  return { ...scope(data), expandedJobId: data.expandedJobId === null ? null : requireId(data.expandedJobId),
    ...(data.sinceRevision === undefined ? {} : { sinceRevision: jobByteOffset(data.sinceRevision) }),
    ...(data.outputEpoch === undefined ? {} : { outputEpoch: data.outputEpoch === null ? null : jobByteOffset(data.outputEpoch) }),
    ...(data.outputCursor === undefined ? {} : { outputCursor: data.outputCursor === null ? null : jobByteOffset(data.outputCursor) }),
    ...(data.refresh === undefined ? {} : { refresh: data.refresh }) };
}
