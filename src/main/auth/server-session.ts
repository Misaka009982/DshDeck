import { session } from 'electron';
import type { Session } from 'electron';
import WebSocket from 'ws';
import { REMOTE_STREAM_MUX_PATH } from '@deepseek-ai/dsh-api-gateway/stream-protocol';
import { createPartitionName } from '../../shared/server-config.js';
import { ProtocolFault, requireKeys, requireRecord } from '../../shared/faults.js';
import type { ServerConfig } from '../../shared/contracts.js';
import { assertReadRequest } from '../protocol/read-policy.js';
import { MAX_RESPONSE_BYTES } from '../protocol/http-response.js';
import { CredentialStore } from './credential-store.js';
import { ReadRequestGate } from './read-request-gate.js';
import { isCertificateFailure, tlsOptions } from './tls-policy.js';
import type { PocTransport } from '../../../tools/poc/protocol-probe.js';
import { assertBusinessRequest, MAX_REQUEST_BYTES } from '../protocol/business-policy.js';

/** 每个 profile 的浏览器、HTTP 和 Node WS 都从此处取得同一认证范围。 */
export class ServerSession {
  readonly partition: string;
  readonly browserSession: Session;
  private readonly gate: ReadRequestGate;
  private readonly baseUrl: URL;
  private readonly compatibilityContents = new Set<number>();

  constructor(readonly config: ServerConfig, private readonly credentials: CredentialStore) {
    this.partition = createPartitionName(config.authProfileId);
    this.browserSession = session.fromPartition(this.partition);
    this.baseUrl = new URL(config.baseUrl);
    this.gate = new ReadRequestGate(config.baseUrl);
    this.browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.browserSession.setPermissionCheckHandler(() => false);
    this.browserSession.on('will-download', event => event.preventDefault());
    this.browserSession.webRequest.onBeforeRequest((details, callback) => {
      // 不保存或记录上传内容，只识别客户端信封并匹配 main 的临时读授权。
      const parts = details.uploadData ?? [];
      let size = 0;
      for (const part of parts) size += part.bytes?.byteLength ?? 0;
      const body = size > MAX_REQUEST_BYTES ? ' '.repeat(MAX_REQUEST_BYTES + 1)
        : Buffer.concat(parts.flatMap(part => part.bytes === undefined ? [] : [part.bytes])).toString('utf8');
      let compatible = false;
      try {
        const target = new URL(details.url);
        if (target.protocol === 'ws:') target.protocol = 'http:';
        if (target.protocol === 'wss:') target.protocol = 'https:';
        compatible = this.compatibilityContents.has(details.webContentsId ?? -1) && target.origin === this.baseUrl.origin;
      } catch { compatible = false; }
      callback({ cancel: !compatible && !this.gate.allows(details.url, details.method, body) });
    });
  }

  transport(lifetime: AbortSignal): PocTransport { return this.createTransport(lifetime, false); }

  businessTransport(lifetime: AbortSignal): PocTransport { return this.createTransport(lifetime, true); }

  clearVolatileCredentials(): void { this.credentials.clear(this.config.authProfileId); }

  allowCompatibilityContents(webContentsId: number): () => void {
    this.compatibilityContents.add(webContentsId);
    return () => { this.compatibilityContents.delete(webContentsId); };
  }

  private createTransport(lifetime: AbortSignal, business: boolean): PocTransport {
    return {
      fetch: async (input, init) => {
        const target = new URL(input, this.baseUrl);
        if (target.origin !== this.baseUrl.origin || init.method !== 'POST' || typeof init.body !== 'string') throw new ProtocolFault('forbidden');
        let decoded: unknown;
        try { decoded = JSON.parse(init.body) as unknown; } catch { throw new ProtocolFault('protocol'); }
        const envelope = requireRecord(decoded);
        requireKeys(envelope, ['type', 'rpcId', 'method', 'payload']);
        const request = { endpoint: envelope.method, payload: envelope.payload };
        if (business) assertBusinessRequest(request); else assertReadRequest(request);
        if (target.href !== new URL(`api/${String(envelope.method)}`, this.baseUrl).href) throw new ProtocolFault('forbidden');
        const release = business ? this.gate.registerAuthorized(init.body) : this.gate.register(init.body);
        const signal = init.signal === undefined || init.signal === null ? lifetime : AbortSignal.any([lifetime, init.signal]);
        const headers = new Headers({ 'content-type': 'application/json', origin: this.baseUrl.origin });
        const authorization = this.credentials.authorizationFor(this.config.authProfileId, target.href);
        if (authorization !== undefined) headers.set('authorization', authorization);
        try {
          if (signal.aborted) throw new ProtocolFault('cancelled');
          return await this.browserSession.fetch(target.href, {
            ...init, signal, headers, credentials: 'include', redirect: 'manual', cache: 'no-store',
          });
        } catch (error) {
          if (signal.aborted) throw new ProtocolFault('cancelled');
          throw error instanceof ProtocolFault ? error : new ProtocolFault(isCertificateFailure(error) ? 'tls' : 'network');
        } finally { release(); }
      },
      openWebSocket: signal => this.openWebSocket(AbortSignal.any([lifetime, signal])),
    };
  }

  private async openWebSocket(signal: AbortSignal): Promise<WebSocket> {
    if (signal.aborted) throw new ProtocolFault('cancelled');
    const httpUrl = new URL(REMOTE_STREAM_MUX_PATH.slice(1), this.baseUrl);
    const wsUrl = new URL(httpUrl);
    wsUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    // Node WS 不自动继承 Chromium 的代理；不偷偷绕过系统代理直连。
    const proxy = await this.browserSession.resolveProxy(wsUrl.href);
    if (signal.aborted) throw new ProtocolFault('cancelled');
    if (proxy !== 'DIRECT') throw new ProtocolFault('unsupported');
    const cookies = await this.browserSession.cookies.get({ url: httpUrl.href });
    if (signal.aborted) throw new ProtocolFault('cancelled');
    const headers: Record<string, string> = { Origin: this.baseUrl.origin };
    if (cookies.length > 0) {
      cookies.sort((a, b) => (b.path?.length ?? 1) - (a.path?.length ?? 1));
      if (cookies.some(cookie => /[;\r\n]/u.test(cookie.name) || /[;\r\n]/u.test(cookie.value))) throw new ProtocolFault('protocol');
      headers.Cookie = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
    }
    const authorization = this.credentials.authorizationFor(this.config.authProfileId, httpUrl.href);
    if (authorization !== undefined) headers.Authorization = authorization;
    const socket = new WebSocket(wsUrl.href, {
      headers, followRedirects: false, perMessageDeflate: false,
      maxPayload: MAX_RESPONSE_BYTES,
      ...(httpUrl.protocol === 'https:' ? tlsOptions() : {}),
    });
    // 载体尚未交给 mux 时也可能取消握手，不能让 error 事件成为未处理异常。
    socket.on('error', () => {});
    const aborted = (): void => { socket.close(); };
    signal.addEventListener('abort', aborted, { once: true });
    socket.once('close', () => signal.removeEventListener('abort', aborted));
    if (signal.aborted) aborted();
    return socket;
  }
}
