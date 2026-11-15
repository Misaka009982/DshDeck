import { parseRemoteEventResult } from '@deepseek-ai/dsh-api-gateway/stream-protocol';
import { ProtocolFault, requireId, requireKeys, requireRecord } from '../../shared/faults.js';
import { assertReadRequest, READ_ENDPOINTS } from './read-policy.js';

export interface BusinessRequest { readonly endpoint: string; readonly payload: { readonly args: Readonly<Record<string, unknown>> } }
export const MAX_REQUEST_BYTES = 256 * 1024;

/** 写操作仅限人工文本、人工停止和已有事件的应答；不开放创建/激活/设置。 */
export function assertBusinessRequest(value: unknown): asserts value is BusinessRequest {
  const request = requireRecord(value);
  requireKeys(request, ['endpoint', 'payload']);
  const endpoint = requireId(request.endpoint);
  if ((READ_ENDPOINTS as readonly string[]).includes(endpoint)) { assertReadRequest(value); return; }
  const payload = requireRecord(request.payload);
  requireKeys(payload, ['args']);
  const args = requireRecord(payload.args);
  if (endpoint === '$events') { requireKeys(args, []); return; }
  if (endpoint === '$events/result') {
    try { parseRemoteEventResult(args); } catch { throw new ProtocolFault('protocol'); }
    return;
  }
  if (endpoint === 'session/cancel') {
    requireKeys(args, ['request']);
    const cancel = requireRecord(args.request);
    requireKeys(cancel, ['sessionId']); requireId(cancel.sessionId);
    return;
  }
  if (endpoint === 'session/prompt') {
    requireKeys(args, ['request']);
    const prompt = requireRecord(args.request);
    requireKeys(prompt, ['requestId', 'sessionId', 'mode', 'content']);
    requireId(prompt.requestId); requireId(prompt.sessionId);
    if (prompt.mode !== 'queue' || !Array.isArray(prompt.content) || prompt.content.length !== 1) throw new ProtocolFault('protocol');
    const content = requireRecord(prompt.content[0]);
    requireKeys(content, ['type', 'text']);
    if (content.type !== 'text' || typeof content.text !== 'string' || content.text.trim() === '' || content.text.length > 65536) throw new ProtocolFault('protocol');
    return;
  }
  throw new ProtocolFault('unsupported');
}
export function promptRequest(sessionId: string, requestId: string, text: string): BusinessRequest {
  const request = { endpoint: 'session/prompt', payload: { args: { request: { sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }] } } } };
  assertBusinessRequest(request);
  return request;
}
