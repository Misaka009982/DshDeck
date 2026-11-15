import { ProtocolFault, requireId, requireKeys, requireRecord } from '../../shared/faults.js';

export const READ_ENDPOINTS = [
  'session/list', 'session/events', 'session/state',
  'workspace/follow', 'session/follow', 'session/observeState', 'session/control',
] as const;

export type ReadEndpoint = typeof READ_ENDPOINTS[number];
export interface ReadRequest {
  readonly endpoint: ReadEndpoint;
  readonly payload: { readonly args: Readonly<Record<string, unknown>> };
}
export interface ReadOptions {
  readonly sessionId?: string;
  readonly maxMessages?: number;
  readonly beforeSeq?: number;
  readonly throughSeq?: number;
}

/** 固定公开的 0.2.2-rc.3 描述符；list 的具名参数确为 _request。 */
export function createReadRequest(endpoint: ReadEndpoint, options: ReadOptions = {}): ReadRequest {
  const optionsRecord = requireRecord(options);
  requireKeys(optionsRecord, [], ['sessionId', 'maxMessages', 'beforeSeq', 'throughSeq']);
  let args: Record<string, unknown>;
  switch (endpoint) {
    case 'session/list':
      requireKeys(optionsRecord, []);
      args = { _request: {} };
      break;
    case 'workspace/follow':
    case 'session/control':
      requireKeys(optionsRecord, []);
      args = {};
      break;
    case 'session/state':
    case 'session/observeState':
      requireKeys(optionsRecord, ['sessionId']);
      args = { request: { sessionId: requireId(options.sessionId) } };
      break;
    case 'session/events':
    case 'session/follow': {
      const request: Record<string, unknown> = {
        address: { kind: 'session', sessionId: requireId(options.sessionId) },
        maxMessages: options.maxMessages ?? 20,
      };
      if (endpoint === 'session/events') {
        if (options.beforeSeq !== undefined) request.beforeSeq = options.beforeSeq;
        if (options.throughSeq !== undefined) request.throughSeq = options.throughSeq;
      } else {
        if (options.beforeSeq !== undefined || options.throughSeq !== undefined) throw new ProtocolFault('protocol');
        request.assistantStream = true;
      }
      args = { request };
      break;
    }
    default:
      throw new ProtocolFault('unsupported');
  }
  const result = { endpoint, payload: { args } };
  assertReadRequest(result);
  return result;
}

/** 再次在网络边界校验，类型标注或 renderer 请求不能扩大白名单。 */
export function assertReadRequest(value: unknown): asserts value is ReadRequest {
  const request = requireRecord(value);
  requireKeys(request, ['endpoint', 'payload']);
  if (typeof request.endpoint !== 'string' || !(READ_ENDPOINTS as readonly string[]).includes(request.endpoint)) {
    throw new ProtocolFault('unsupported');
  }
  const payload = requireRecord(request.payload);
  requireKeys(payload, ['args']);
  const args = requireRecord(payload.args);
  switch (request.endpoint as ReadEndpoint) {
    case 'session/list':
      requireKeys(args, ['_request']);
      requireKeys(requireRecord(args._request), []);
      return;
    case 'workspace/follow':
    case 'session/control':
      requireKeys(args, []);
      return;
    case 'session/state':
    case 'session/observeState': {
      requireKeys(args, ['request']);
      const stateRequest = requireRecord(args.request);
      requireKeys(stateRequest, ['sessionId']);
      requireId(stateRequest.sessionId);
      return;
    }
    case 'session/events':
    case 'session/follow': {
      requireKeys(args, ['request']);
      const history = requireRecord(args.request);
      const optional = request.endpoint === 'session/events'
        ? ['maxMessages', 'beforeSeq', 'throughSeq'] : ['maxMessages', 'assistantStream'];
      requireKeys(history, ['address'], optional);
      const address = requireRecord(history.address);
      requireKeys(address, ['kind', 'sessionId']);
      if (address.kind !== 'session') throw new ProtocolFault('unsupported');
      requireId(address.sessionId);
      if (history.maxMessages !== undefined) boundedInteger(history.maxMessages, 1, 500);
      if (history.beforeSeq !== undefined) boundedInteger(history.beforeSeq, 0, Number.MAX_SAFE_INTEGER);
      if (history.throughSeq !== undefined) boundedInteger(history.throughSeq, -1, Number.MAX_SAFE_INTEGER);
      if (history.assistantStream !== undefined && history.assistantStream !== true) throw new ProtocolFault('protocol');
      return;
    }
  }
}

function boundedInteger(value: unknown, min: number, max: number): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max || Object.is(value, -0)) {
    throw new ProtocolFault('protocol');
  }
}
