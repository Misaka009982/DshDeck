import { ProtocolFault, requireId, requireKeys, requireRecord } from '../../shared/faults.js';
import { assertReadRequest } from '../protocol/read-policy.js';
import { assertBusinessRequest, MAX_REQUEST_BYTES } from '../protocol/business-policy.js';

/** Chromium 只接受 main 临时登记的只读 RPC；不放行认证网页的业务载体。 */
export class ReadRequestGate {
  private readonly pending = new Set<string>();
  private readonly baseUrl: URL;

  constructor(baseUrl: string) { this.baseUrl = new URL(baseUrl); }

  register(body: string): () => void {
    const envelope = this.envelope(body);
    assertReadRequest({ endpoint: envelope.method, payload: envelope.payload });
    return this.track(body);
  }

  registerAuthorized(body: string): () => void {
    const envelope = this.envelope(body);
    assertBusinessRequest({ endpoint: envelope.method, payload: envelope.payload });
    return this.track(body);
  }

  private track(body: string): () => void {
    this.pending.add(body);
    return () => { this.pending.delete(body); };
  }

  allows(target: string, method: string, body: string): boolean {
    let url: URL;
    try {
      url = new URL(target);
      if (url.protocol === 'wss:') url.protocol = 'https:';
      else if (url.protocol === 'ws:') url.protocol = 'http:';
    } catch { return false; }
    let decoded: unknown;
    if (body !== '') {
      try { decoded = JSON.parse(body) as unknown; } catch { decoded = undefined; }
    }
    const looksLikeRpc = typeof decoded === 'object' && decoded !== null
      && !Array.isArray(decoded) && Reflect.get(decoded, 'type') === 'client-request';
    if (looksLikeRpc) {
      if (!this.pending.has(body) || method !== 'POST' || url.origin !== this.baseUrl.origin) return false;
      try {
        const envelope = this.envelope(body);
        return url.href === new URL(`api/${String(envelope.method)}`, this.baseUrl).href;
      } catch { return false; }
    }
    if (url.origin === this.baseUrl.origin && url.pathname === `${this.baseUrl.pathname}api/remote.mux`) return false;
    // 超大未知 API 正文不放行，常规网页登录和 GET / Token 兑换不受影响。
    if (url.origin === this.baseUrl.origin && url.pathname.startsWith(`${this.baseUrl.pathname}api/`)
      && method === 'POST' && body.length > MAX_REQUEST_BYTES) return false;
    return true;
  }

  private envelope(body: string): Record<string, unknown> {
    if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) throw new ProtocolFault('budget');
    let value: unknown;
    try { value = JSON.parse(body) as unknown; } catch { throw new ProtocolFault('protocol'); }
    const envelope = requireRecord(value);
    requireKeys(envelope, ['type', 'rpcId', 'method', 'payload']);
    if (envelope.type !== 'client-request') throw new ProtocolFault('protocol');
    requireId(envelope.rpcId);
    requireId(envelope.method);
    return envelope;
  }
}
