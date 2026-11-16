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
import { basicChallengeScope } from './basic-challenge.js';
import { SocketHandshakeFault, waitForWebSocket } from './ws-handshake.js';
import { ReadRequestGate } from './read-request-gate.js';
import { isCertificateFailure, tlsOptions } from './tls-policy.js';
import type { PocTransport } from '../../../tools/poc/protocol-probe.js';
import { assertBusinessRequest, MAX_REQUEST_BYTES } from '../protocol/business-policy.js';
import { describeLogError } from '../logging/diagnostic-logger.js';
import type { ConnectionStep, DiagnosticLogger, LogFields, TransportState } from '../logging/diagnostic-logger.js';
import { navigationFields, responseCategory } from '../logging/connection-details.js';
import { isNativeReadRequest } from '../protocol/native-policy.js';
import { fileShareUrl } from '../../shared/files.js';
import type { FileShareRequest } from '../../shared/files.js';
import { checkSavedEndpoint } from './network-check.js';
import type { NetworkCheckReport } from '../../shared/network-check.js';

/** 每个 profile 的浏览器、HTTP 和 Node WS 都从此处取得同一认证范围。 */
export class ServerSession {
  readonly partition: string;
  readonly browserSession: Session;
  private readonly gate: ReadRequestGate;
  private readonly baseUrl: URL;
  private readonly networkReady: Promise<void>;
  private readonly compatibilityContents = new Set<number>();

  constructor(readonly config: ServerConfig, private readonly credentials: CredentialStore, private readonly diagnostics?: DiagnosticLogger) {
    this.partition = createPartitionName(config.authProfileId);
    this.browserSession = session.fromPartition(this.partition);
    this.baseUrl = new URL(config.baseUrl);
    this.networkReady = this.browserSession.setProxy({ mode: config.proxyMode === 'direct' ? 'direct' : 'system' })
      .then(() => this.browserSession.closeAllConnections());
    // 配置异步失败由实际请求报告，不成为未处理的 Promise 拒绝。
    void this.networkReady.catch(() => {});
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
      callback({ cancel: !compatible && !this.gate.allows(details.url, details.method, body, details.webContentsId !== undefined && details.webContentsId >= 0) });
    });
  }

  ready(signal?: AbortSignal): Promise<void> { return signal === undefined ? this.networkReady : waitForSignal(this.networkReady, signal); }

  transport(lifetime: AbortSignal, generation?: number): PocTransport { return this.createTransport(lifetime, false, generation); }

  businessTransport(lifetime: AbortSignal, generation?: number): PocTransport { return this.createTransport(lifetime, true, generation); }

  /** 独立只读插件通道；不暴露原始 URL、写方法或认证材料给 renderer。 */
  async readFileShare(request: FileShareRequest, signal: AbortSignal): Promise<Response> {
    const target = fileShareUrl(this.config.baseUrl, request);
    const release = this.gate.registerFileShare(request);
    const endpoint = request.operation === 'workspace' ? 'dsh-file-share/status' : request.operation === 'directory' ? 'dsh-file-share/list' : 'dsh-file-share/preview';
    const fields: LogFields = { endpoint, ...navigationFields(target.href, this.config.baseUrl), proxyPolicy: this.config.proxyMode ?? 'system' };
    const headers = new Headers({ origin: this.baseUrl.origin });
    let authorization = this.credentials.authorizationFor(this.config.authProfileId, target.href);
    if (authorization !== undefined) headers.set('authorization', authorization);
    try {
      if (signal.aborted) throw faultForAbort(signal);
      await this.ready(signal);
      this.recordTransport('http-request', 'begin', fields);
      const read = (): Promise<Response> => this.browserSession.fetch(target.href, { method: 'GET', signal, headers, credentials: 'include', redirect: 'manual', cache: 'no-store' });
      let response = await read();
      // GET 可在真实 BasicAuth 挑战后复用一次；端口、origin、realm 仍需完整匹配。
      if (response.status === 401 && authorization === undefined) {
        const scope = basicChallengeScope(this.config.authProfileId, target.href, response.headers.get('www-authenticate'));
        const saved = scope === undefined ? undefined : this.credentials.get(scope);
        if (scope !== undefined && saved !== undefined) {
          this.recordTransport('http-response', 'headers', { ...fields, httpStatus: 401, responseType: responseCategory(response.headers.get('content-type')) });
          await response.body?.cancel().catch(() => {});
          this.credentials.set(scope, saved); this.credentials.authorizeTarget(scope, target.href);
          authorization = this.credentials.authorizationFor(this.config.authProfileId, target.href);
          if (authorization === undefined) throw new ProtocolFault('auth-required');
          headers.set('authorization', authorization);
          if (signal.aborted) throw faultForAbort(signal);
          response = await read();
        }
      }
      if ([401, 403].includes(response.status) && authorization !== undefined) {
        this.credentials.rejectFor(this.config.authProfileId, target.href, authorization); await this.browserSession.clearAuthCache();
      }
      this.recordTransport('http-response', 'headers', { ...fields, httpStatus: response.status, responseType: responseCategory(response.headers.get('content-type')) });
      return response;
    } catch (error) {
      const fault = signal.aborted ? faultForAbort(signal) : error instanceof ProtocolFault ? error : new ProtocolFault(isCertificateFailure(error) ? 'tls' : 'network');
      this.recordTransport('http-request', fault.kind === 'cancelled' ? 'cancelled' : 'failed', { ...fields, failureKind: fault.kind }, error);
      throw fault;
    } finally { release(); }
  }

  /** HEAD 只核对保存入口的线路，不处理 Cookie、重定向或 dsh 业务握手。 */
  async checkNetwork(signal: AbortSignal, generation: number): Promise<NetworkCheckReport> {
    await this.ready(AbortSignal.any([signal, AbortSignal.timeout(8000)]));
    const fields: LogFields = { ...navigationFields(this.config.baseUrl, this.config.baseUrl), generation, proxyPolicy: this.config.proxyMode ?? 'system' };
    return checkSavedEndpoint(this.config.baseUrl, {
      resolveProxy: target => this.browserSession.resolveProxy(target), fetch: (target, init) => this.browserSession.fetch(target, init),
      observe: (phase, step) => {
        const connectionStep = phase === 'tcp' ? 'line-tcp' : 'line-http';
        if (step === null) { this.recordTransport(connectionStep, 'begin', fields); return; }
        const extra: LogFields = { ...fields, elapsedMs: step.elapsedMs,
          ...(step.state === 'failed' ? { failureKind: step.failure.kind, ...(step.networkCode === undefined ? {} : { networkCode: step.networkCode as NonNullable<LogFields['networkCode']> }) } : {}),
          ...(step.state === 'response' ? { httpStatus: step.httpStatus } : {}), ...(step.state === 'skipped' ? { proxyMode: 'configured' as const } : {}) };
        this.recordTransport(connectionStep, step.state === 'failed' ? step.failure.kind === 'cancelled' ? 'cancelled' : 'failed' : step.state === 'skipped' ? 'blocked' : step.state === 'response' ? 'headers' : 'open', extra);
      },
    }, signal);
  }

  clearVolatileCredentials(): void { this.credentials.clear(this.config.authProfileId); }

  allowCompatibilityContents(webContentsId: number): () => void {
    this.compatibilityContents.add(webContentsId);
    return () => { this.compatibilityContents.delete(webContentsId); };
  }

  private createTransport(lifetime: AbortSignal, business: boolean, generation?: number): PocTransport {
    // 每次连接只记录首个 HTTP 成功路径与各类逻辑流首次开场，后台轮询不持续填满诊断历史。
    let firstRequest = true; const reportedStreams = new Set<string>();
    return {
      streamDiagnostic: value => {
        if (generation !== undefined && value.generation !== generation) return;
        const key = `${value.endpoint}:${value.role}:${value.state}`;
        if (value.state === 'begin' || value.state === 'open') {
          if (reportedStreams.has(key)) return;
          reportedStreams.add(key);
        }
        this.recordTransport('ws-stream', value.state, { ...navigationFields(this.baseUrl.href, this.config.baseUrl),
          networkProtocol: this.baseUrl.protocol === 'https:' ? 'wss:' : 'ws:', proxyPolicy: this.config.proxyMode ?? 'system',
          generation: value.generation, endpoint: value.endpoint, streamRole: value.role,
          ...(value.elapsedMs <= 30000 ? { elapsedMs: value.elapsedMs } : {}), ...(value.failureKind === undefined ? {} : { failureKind: value.failureKind }) });
      },
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
        let authorization = this.credentials.authorizationFor(this.config.authProfileId, target.href);
        if (authorization !== undefined) headers.set('authorization', authorization);
        const initial = firstRequest; firstRequest = false;
        const fields: LogFields = { endpoint: String(envelope.method), ...navigationFields(target.href, this.config.baseUrl), proxyPolicy: this.config.proxyMode ?? 'system',
          ...(generation === undefined ? {} : { generation }) };
        let step: ConnectionStep = 'http-proxy';
        try {
          if (signal.aborted) throw faultForAbort(signal);
          if (initial) this.recordTransport(step, 'begin', fields);
          await this.ready(signal);
          if (initial) {
            const proxy = await waitForSignal(this.browserSession.resolveProxy(target.href), signal);
            this.recordTransport(step, 'complete', { ...fields, proxyMode: proxy === 'DIRECT' ? 'direct' : 'configured' });
            if (this.config.proxyMode === 'direct' && proxy !== 'DIRECT') throw new ProtocolFault('unsupported');
          }
          if (authorization === undefined && !retryableRead(request) && this.credentials.knownScope(this.config.authProfileId, target.origin) !== undefined) {
            // 写操作先做无正文认证预检；不会把已经发送的 prompt、cancel 或答案重发。
            step = 'http-auth-check'; this.recordTransport(step, 'begin', fields);
            const check = await this.browserSession.fetch(target.href, { method: 'HEAD', signal, headers: { origin: this.baseUrl.origin },
              credentials: 'include', redirect: 'manual', cache: 'no-store' });
            this.recordTransport(step, 'headers', { ...fields, httpStatus: check.status });
            const scope = check.status === 401 ? basicChallengeScope(this.config.authProfileId, target.href, check.headers.get('www-authenticate')) : undefined;
            const saved = scope === undefined ? undefined : this.credentials.get(scope);
            await check.body?.cancel().catch(() => {});
            if (scope !== undefined && saved !== undefined) {
              this.credentials.set(scope, saved); this.credentials.authorizeTarget(scope, target.href);
              authorization = this.credentials.authorizationFor(this.config.authProfileId, target.href);
              if (authorization === undefined) throw new ProtocolFault('auth-required');
              headers.set('authorization', authorization);
            } else if (check.status === 401) throw new ProtocolFault('auth-required');
          }
          step = 'http-request';
          if (signal.aborted) throw faultForAbort(signal);
          if (initial) this.recordTransport(step, 'begin', fields);
          let response = await this.browserSession.fetch(target.href, {
            ...init, signal, headers, credentials: 'include', redirect: 'manual', cache: 'no-store',
          });
          // 只读请求可按真实挑战复用一次保存密码；不重发 prompt、cancel 或人工答案。
          if (response.status === 401 && authorization === undefined && retryableRead(request)) {
            const scope = basicChallengeScope(this.config.authProfileId, target.href, response.headers.get('www-authenticate'));
            const saved = scope === undefined ? undefined : this.credentials.get(scope);
            if (scope !== undefined && saved !== undefined) {
              if (initial) this.recordTransport('http-response', 'headers', { ...fields, httpStatus: 401, responseType: responseCategory(response.headers.get('content-type')) });
              await response.body?.cancel().catch(() => {});
              this.credentials.set(scope, saved); this.credentials.authorizeTarget(scope, target.href);
              authorization = this.credentials.authorizationFor(this.config.authProfileId, target.href);
              if (authorization === undefined) throw new ProtocolFault('auth-required');
              headers.set('authorization', authorization);
              response = await this.browserSession.fetch(target.href, { ...init, signal, headers, credentials: 'include', redirect: 'manual', cache: 'no-store' });
            }
          }
          if ([401, 403].includes(response.status) && authorization !== undefined) {
            this.credentials.rejectFor(this.config.authProfileId, target.href, authorization);
            await this.browserSession.clearAuthCache();
          }
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
          if (initial || fault.kind !== 'cancelled') this.recordTransport(step, fault.kind === 'cancelled' ? 'cancelled' : 'failed', { ...fields, failureKind: fault.kind }, error);
          throw fault;
        } finally { release(); }
      },
      openWebSocket: signal => this.openWebSocket(AbortSignal.any([lifetime, signal]), generation),
    };
  }

  private async openWebSocket(signal: AbortSignal, generation?: number): Promise<WebSocket> {
    if (signal.aborted) throw faultForAbort(signal);
    const httpUrl = new URL(REMOTE_STREAM_MUX_PATH.slice(1), this.baseUrl);
    const wsUrl = new URL(httpUrl);
    const protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.protocol = protocol;
    const fields: LogFields = { ...navigationFields(httpUrl.href, this.config.baseUrl), networkProtocol: protocol, proxyPolicy: this.config.proxyMode ?? 'system',
      ...(generation === undefined ? {} : { generation }) };
    let step: ConnectionStep = 'ws-proxy';
    try {
      // Node WS 不自动继承 Chromium 的代理；不偷偷绕过系统代理直连。
      this.recordTransport(step, 'begin', fields);
      await this.ready(signal);
      const proxy = await waitForSignal(this.browserSession.resolveProxy(wsUrl.href), signal);
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
      let authorization = this.credentials.authorizationFor(this.config.authProfileId, httpUrl.href);
      const openingSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
      for (let attempt = 0; attempt < 2; attempt++) {
        if (openingSignal.aborted) throw faultForAbort(openingSignal);
        const currentHeaders = { ...headers, ...(authorization === undefined ? {} : { Authorization: authorization }) };
        this.recordTransport(step, 'begin', fields);
        const socket = new WebSocket(wsUrl.href, {
          // 支持时逐消息压缩，不复用上下文；服务端不协商时继续普通文本帧。
          headers: currentHeaders, followRedirects: false, perMessageDeflate: { clientNoContextTakeover: true, serverNoContextTakeover: true },
          maxPayload: MAX_RESPONSE_BYTES, ...(httpUrl.protocol === 'https:' ? tlsOptions() : {}),
        });
        let connected = false; let connectedAt = 0;
        socket.once('close', code => {
          if (!connected) return;
          this.recordTransport('ws-carrier', signal.aborted ? 'cancelled' : 'failed', { ...fields, wsCloseCode: code,
            connectionAborted: signal.aborted, connectionAgeSeconds: Math.max(0, Math.min(604800, Math.floor((performance.now() - connectedAt) / 1000))),
            ...(signal.aborted ? {} : { failureKind: 'network' as const }) });
        });
        socket.on('error', error => {
          if (connected && !signal.aborted) this.recordTransport('ws-handshake', 'failed', { ...fields,
            failureKind: isCertificateFailure(error) ? 'tls' : 'network' }, error);
        });
        const aborted = (): void => { if (socket.readyState === WebSocket.OPEN) socket.close(); else if (socket.readyState !== WebSocket.CLOSED) socket.terminate(); };
        signal.addEventListener('abort', aborted, { once: true }); socket.once('close', () => signal.removeEventListener('abort', aborted));
        try {
          await waitForWebSocket(socket, openingSignal);
          if (signal.aborted) { aborted(); throw faultForAbort(signal); }
          connected = true; connectedAt = performance.now(); this.recordTransport('ws-handshake', 'open', { ...fields, httpStatus: 101,
            wsCompression: socket.extensions.split(',').some(extension => extension.trim() === 'permessage-deflate') });
          return socket;
        } catch (error) {
          if (error instanceof SocketHandshakeFault) {
            this.recordTransport('ws-handshake', 'headers', { ...fields, httpStatus: error.status });
            if ([401, 403].includes(error.status) && authorization !== undefined) {
              this.credentials.rejectFor(this.config.authProfileId, httpUrl.href, authorization); await this.browserSession.clearAuthCache();
            }
            const scope = error.status === 401 && authorization === undefined && attempt === 0
              ? basicChallengeScope(this.config.authProfileId, httpUrl.href, error.challenge) : undefined;
            const saved = scope === undefined ? undefined : this.credentials.get(scope);
            if (scope !== undefined && saved !== undefined) {
              this.credentials.set(scope, saved); this.credentials.authorizeTarget(scope, httpUrl.href);
              authorization = this.credentials.authorizationFor(this.config.authProfileId, httpUrl.href);
              if (authorization === undefined) throw new ProtocolFault('auth-required');
              continue;
            }
          }
          throw error;
        }
      }
      throw new ProtocolFault('auth-required');
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

function retryableRead(value: unknown): boolean {
  try { assertReadRequest(value); return true; } catch { return isNativeReadRequest(value); }
}
function waitForSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); return Promise.reject(faultForAbort(signal)); }
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(faultForAbort(signal)); signal.addEventListener('abort', abort, { once: true }); });
  if (signal.aborted) abort();
  return Promise.race([work, cancelled]).finally(() => signal.removeEventListener('abort', abort));
}
