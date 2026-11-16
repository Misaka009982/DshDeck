import { ProtocolFault, requireId, requireKeys, requireRecord } from '../../shared/faults.js';
import { jobByteOffset } from '../../shared/jobs.js';

export const JOB_READ_ENDPOINTS = ['job/list', 'job/follow'] as const;
export interface JobReadRequest { readonly endpoint: typeof JOB_READ_ENDPOINTS[number]; readonly payload: { readonly args: { readonly request: Readonly<Record<string, unknown>> } } }
/** 固定 0.2.2-rc.3 描述符使用 args.request；仅人工查看，不开放 job/kill。 */
export function jobReadRequest(endpoint: JobReadRequest['endpoint'], sessionId: string, jobId?: string, from?: number): JobReadRequest {
  const request = { sessionId, ...(jobId === undefined ? {} : { jobId }), ...(from === undefined ? {} : { from }) };
  const value = { endpoint, payload: { args: { request } } }; assertJobReadRequest(value); return value;
}
export function assertJobReadRequest(value: unknown): asserts value is JobReadRequest {
  const data = requireRecord(value); requireKeys(data, ['endpoint', 'payload']);
  if (!(JOB_READ_ENDPOINTS as readonly unknown[]).includes(data.endpoint)) throw new ProtocolFault('unsupported');
  const payload = requireRecord(data.payload); requireKeys(payload, ['args']); const args = requireRecord(payload.args); requireKeys(args, ['request']);
  const request = requireRecord(args.request);
  if (data.endpoint === 'job/list') requireKeys(request, ['sessionId']);
  else { requireKeys(request, ['sessionId', 'jobId'], ['from']); requireId(request.jobId); if (request.from !== undefined) jobByteOffset(request.from); }
  requireId(request.sessionId);
}
