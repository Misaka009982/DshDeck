import { ProtocolFault, requireId, requireKeys, requireRecord } from '../../shared/faults.js';
import { assertReadRequest } from '../protocol/read-policy.js';
import { assertBusinessRequest, MAX_REQUEST_BYTES } from '../protocol/business-policy.js';
import { fileShareUrl } from '../../shared/files.js';
import type { FileShareRequest } from '../../shared/files.js';

/** Chromium 只接受 main 临时登记的只读 RPC；不放行认证网页的业务载体。 */
export class ReadRequestGate {
  private readonly pending = new Set<string>();
  private readonly fileReads = new Map<string, number>();
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

  /** 文件 GET 只供 main 临时登记；认证网页不能借用已知路径碰巧赶上授权。 */
  registerFileShare(request: FileShareRequest): () => void {
    const target = fileShareUrl(this.baseUrl.href, request).href;
    if (this.fileReads.size >= 32 && !this.fileReads.has(target)) throw new ProtocolFault('budget');
    this.fileReads.set(target, (this.fileReads.get(target) ?? 0) + 1);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const count = this.fileReads.get(target) ?? 0;
      if (count <= 1) this.fileReads.delete(target); else this.fileReads.set(target, count - 1);
    };
  }

  private track(body: string): () => void {
    this.pending.add(body);
    return () => { this.pending.delete(body); };
  }

  allows(target: string, method: string, body: string, fromPage = false): boolean {
    let url: URL; let socket = false;
    try {
      url = new URL(target);
      socket = url.protocol === 'ws:' || url.protocol === 'wss:';
      if (url.protocol === 'wss:') url.protocol = 'https:';
      else if (url.protocol === 'ws:') url.protocol = 'http:';
    } catch { return false; }
    const prefix = new URL('dsh-file-share/api', this.baseUrl).pathname;
    if (url.origin === this.baseUrl.origin && (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) {
      return !fromPage && !socket && method === 'GET' && body === '' && this.fileReads.has(url.href);
    }
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
