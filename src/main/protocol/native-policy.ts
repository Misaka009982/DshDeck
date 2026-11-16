import { ProtocolFault, requireId, requireKeys, requireRecord } from '../../shared/faults.js';
import { boundedString, parseGoalRef, parseModelSelection } from '../../shared/native-controls.js';
import type { BusinessRequest } from './business-policy.js';

export const NATIVE_ENDPOINTS = ['session/modelCatalog', 'session/projections', 'session/observeProjections', 'commands/list',
  'session/selectModel', 'commands/execute', 'goals/create', 'goals/edit', 'goals/pause', 'goals/resume', 'goals/clear'] as const;
export type NativeEndpoint = typeof NATIVE_ENDPOINTS[number];
const READ_NATIVE = new Set<string>(['session/modelCatalog', 'session/projections', 'session/observeProjections', 'commands/list']);

/** 前台原生能力独立准入；不扩大阶段 A 或后台的只读接口。 */
export function assertNativeRequest(value: unknown): asserts value is BusinessRequest {
  const request = requireRecord(value); requireKeys(request, ['endpoint', 'payload']);
  if (typeof request.endpoint !== 'string' || !(NATIVE_ENDPOINTS as readonly string[]).includes(request.endpoint)) throw new ProtocolFault('unsupported');
  const payload = requireRecord(request.payload); requireKeys(payload, ['args']); const args = requireRecord(payload.args);
  if (request.endpoint === 'session/modelCatalog') { requireKeys(args, []); return; }
  if (request.endpoint === 'session/projections' || request.endpoint === 'session/observeProjections') {
    requireKeys(args, ['request']); const input = requireRecord(args.request); requireKeys(input, ['sessionId']); requireId(input.sessionId); return;
  }
  if (request.endpoint === 'session/selectModel') {
    requireKeys(args, ['request']); const input = requireRecord(args.request); requireKeys(input, ['sessionId', 'provider', 'model'], ['reasoningEffort']);
    requireId(input.sessionId); parseModelSelection({ provider: input.provider, model: input.model, ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }) }); return;
  }
  if (request.endpoint === 'commands/list') { requireKeys(args, ['agentId']); requireId(args.agentId); return; }
  if (request.endpoint === 'commands/execute') {
    requireKeys(args, ['agentId', 'line', 'submittedAttachments']); requireId(args.agentId);
    const line = boundedString(args.line, 65536);
    if (!/^\/[^\s/]+(?:\s[\s\S]*)?$/u.test(line.trim()) || !Array.isArray(args.submittedAttachments) || args.submittedAttachments.length !== 0) throw new ProtocolFault('protocol');
    return;
  }
  if (request.endpoint === 'goals/create') {
    requireKeys(args, ['agentId', 'request']); requireId(args.agentId); const input = requireRecord(args.request); requireKeys(input, ['objective']); boundedString(input.objective, 16384); return;
  }
  if (request.endpoint === 'goals/edit') {
    requireKeys(args, ['agentId', 'ref', 'request']); requireId(args.agentId); parseGoalRef(args.ref);
    const input = requireRecord(args.request); requireKeys(input, ['objective']); boundedString(input.objective, 16384); return;
  }
  requireKeys(args, ['agentId', 'ref']); requireId(args.agentId); parseGoalRef(args.ref);
}
export function nativeRequest(endpoint: NativeEndpoint, args: Readonly<Record<string, unknown>>): BusinessRequest {
  const request = { endpoint, payload: { args } }; assertNativeRequest(request); return request;
}
export function isNativeReadRequest(value: unknown): boolean {
  try { assertNativeRequest(value); return READ_NATIVE.has(value.endpoint); } catch { return false; }
}
