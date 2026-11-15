import { session } from 'electron';
import type { Session } from 'electron';
import WebSocket from 'ws';
import { REMOTE_STREAM_MUX_PATH } from '@deepseek-ai/dsh-api-gateway/stream-protocol';
import { createPartitionName } from '../../shared/server-config.js';
import { ProtocolFault, faultForAbort, requireKeys, requireRecord } from '../../shared/faults.js';
import type { ServerConfig } from '../../shared/contracts.js';
import { assertReadRequest } from '../protocol/read-policy.js';
import { MAX_RESPONSE_BYTES } from '../protocol/http-response.js';
import { CredentialStore } from './credential-store.js';
import { ReadRequestGate } from './read-request-gate.js';
import { isCertificateFailure, tlsOptions } from './tls-policy.js';
import type { PocTransport } from '../../../tools/poc/protocol-probe.js';
import { assertBusinessRequest, MAX_REQUEST_BYTES } from '../protocol/business-policy.js';
import { describeLogError } from '../logging/diagnostic-logger.js';
import type { ConnectionStep, DiagnosticLogger, LogFields, TransportState } from '../logging/diagnostic-logger.js';
import { navigationFields, responseCategory } from '../logging/connection-details.js';

/** 每个 profile 的浏览器、HTTP 和 Node WS 都从此处取得同一认证范围。 */
export class ServerSession {
  readonly partition: string;
  readonly browserSession: Session;
  private readonly gate: ReadRequestGate;
  private readonly baseUrl: URL;
  private readonly compatibilityContents = new Set<number>();

  constructor(readonly config: ServerConfig, private readonly credentials: CredentialStore, private readonly diagnostics?: DiagnosticLogger) {
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
    // 每次连接只记录首个 HTTP 成功路径，后台轮询不持续填满诊断历史。
    let firstRequest = true;
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
        const initial = firstRequest; firstRequest = false;
        const fields: LogFields = { endpoint: String(envelope.method), ...navigationFields(target.href, this.config.baseUrl) };
        try {
          if (signal.aborted) throw faultForAbort(signal);
          if (initial) this.recordTransport('http-request', 'begin', fields);
          const response = await this.browserSession.fetch(target.href, {
            ...init, signal, headers, credentials: 'include', redirect: 'manual', cache: 'no-store',
          });
          if (initial) {
            let redirect: LogFields = {};
            const location = response.headers.get('location');
            if (response.status >= 300 && response.status < 400 && location !== null) {
              try {
                const next = new URL(location, target);
                redirect = { redirectChangesOrigin: next.origin !== this.baseUrl.origin,
                  redirectToLoopback: navigationFields(next.href, this.config.baseUrl).targetLoopback ?? false };
              } catch { /* 不把无法解析的远程 Location 回显到日志。 */ }
            }
            this.recordTransport('http-response', 'headers', { ...fields, ...redirect, httpStatus: response.status,
              responseType: responseCategory(response.headers.get('content-type')) });
          }
          return response;
        } catch (error) {
          const fault = signal.aborted ? faultForAbort(signal)
            : error instanceof ProtocolFault ? error : new ProtocolFault(isCertificateFailure(error) ? 'tls' : 'network');
          if (initial || fault.kind !== 'cancelled') this.recordTransport('http-request', fault.kind === 'cancelled' ? 'cancelled' : 'failed', { ...fields, failureKind: fault.kind }, error);
          throw fault;
        } finally { release(); }
      },
      openWebSocket: signal => this.openWebSocket(AbortSignal.any([lifetime, signal])),
    };
  }

  private async openWebSocket(signal: AbortSignal): Promise<WebSocket> {
    if (signal.aborted) throw faultForAbort(signal);
    const httpUrl = new URL(REMOTE_STREAM_MUX_PATH.slice(1), this.baseUrl);
    const wsUrl = new URL(httpUrl);
    const protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.protocol = protocol;
    const fields: LogFields = { ...navigationFields(httpUrl.href, this.config.baseUrl), networkProtocol: protocol };
    let step: ConnectionStep = 'ws-proxy';
    try {
      // Node WS 不自动继承 Chromium 的代理；不偷偷绕过系统代理直连。
      this.recordTransport(step, 'begin', fields);
      const proxy = await this.browserSession.resolveProxy(wsUrl.href);
      if (signal.aborted) throw faultForAbort(signal);
      this.recordTransport(step, 'complete', { ...fields, proxyMode: proxy === 'DIRECT' ? 'direct' : 'configured' });
      if (proxy !== 'DIRECT') throw new ProtocolFault('unsupported');
      step = 'ws-handshake';
      const cookies = await this.browserSession.cookies.get({ url: httpUrl.href });
      if (signal.aborted) throw faultForAbort(signal);
      const headers: Record<string, string> = { Origin: this.baseUrl.origin };
      if (cookies.length > 0) {
        cookies.sort((a, b) => (b.path?.length ?? 1) - (a.path?.length ?? 1));
        if (cookies.some(cookie => /[;\r\n]/u.test(cookie.name) || /[;\r\n]/u.test(cookie.value))) throw new ProtocolFault('protocol');
        headers.Cookie = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
      }
      const authorization = this.credentials.authorizationFor(this.config.authProfileId, httpUrl.href);
      if (authorization !== undefined) headers.Authorization = authorization;
      this.recordTransport(step, 'begin', fields);
      const socket = new WebSocket(wsUrl.href, {
        headers, followRedirects: false, perMessageDeflate: false,
        maxPayload: MAX_RESPONSE_BYTES,
        ...(httpUrl.protocol === 'https:' ? tlsOptions() : {}),
      });
      socket.once('open', () => { if (!signal.aborted) this.recordTransport('ws-handshake', 'open', { ...fields, httpStatus: 101 }); });
      // 载体尚未交给 mux 时也可能取消握手，不能让 error 事件成为未处理异常。
      socket.on('error', error => {
        if (!signal.aborted) this.recordTransport('ws-handshake', 'failed', { ...fields,
          failureKind: isCertificateFailure(error) ? 'tls' : 'network' }, error);
      });
      const aborted = (): void => { socket.close(); };
      signal.addEventListener('abort', aborted, { once: true });
      socket.once('close', () => signal.removeEventListener('abort', aborted));
      if (signal.aborted) aborted();
      return socket;
    } catch (error) {
      const fault = signal.aborted ? faultForAbort(signal)
        : error instanceof ProtocolFault ? error : new ProtocolFault(isCertificateFailure(error) ? 'tls' : 'network');
      this.recordTransport(step, fault.kind === 'cancelled' ? 'cancelled' : 'failed', { ...fields, failureKind: fault.kind }, error);
      throw fault;
    }
  }

  private recordTransport(step: ConnectionStep, state: TransportState, fields: LogFields, error?: unknown): void {
    if (this.diagnostics === undefined) return;
    this.diagnostics.record(state === 'failed' || state === 'blocked' ? 'warn' : 'info', 'transport-state', {
      ...(error === undefined ? {} : describeLogError(error)), ...fields,
      serverId: this.config.id, connectionStep: step, transportState: state,
    });
  }
}
