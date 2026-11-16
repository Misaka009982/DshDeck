import { Socket } from 'node:net';
import { ProtocolFault, faultForAbort, toPublicFailure } from '../../shared/faults.js';
import type { NetworkCheckReport, NetworkCheckStep } from '../../shared/network-check.js';
import { networkErrorCode } from '../logging/connection-details.js';

export interface NetworkCheckPorts {
  readonly resolveProxy: (url: string) => Promise<string>;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly tcp?: (host: string, port: number, signal: AbortSignal) => Promise<void>;
  readonly observe?: (phase: 'tcp' | 'http', step: NetworkCheckStep | null) => void;
}

/** 仅由保存入口的手动操作调用；不扫端口、不沿重定向访问、不发送 Cookie 或 RPC 正文。 */
export async function checkSavedEndpoint(baseUrl: string, ports: NetworkCheckPorts, lifetime: AbortSignal): Promise<NetworkCheckReport> {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') throw new ProtocolFault('forbidden');
  if (lifetime.aborted) throw faultForAbort(lifetime);
  const proxy = await withAbort(ports.resolveProxy(url.href), AbortSignal.any([lifetime, AbortSignal.timeout(8000)]));
  const direct = proxy.trim().toUpperCase() === 'DIRECT';
  const run = async (phase: 'tcp' | 'http', operation: (signal: AbortSignal) => Promise<'open' | number>): Promise<NetworkCheckStep> => {
    ports.observe?.(phase, null);
    const started = performance.now(); const signal = AbortSignal.any([lifetime, AbortSignal.timeout(8000)]);
    let step: NetworkCheckStep;
    try {
      const value = await withAbort(operation(signal), signal);
      if (signal.aborted) throw faultForAbort(signal);
      step = value === 'open' ? { state: 'open', elapsedMs: elapsed(started) }
        : { state: 'response', elapsedMs: elapsed(started), httpStatus: value };
    } catch (error) {
      const networkCode = networkErrorCode(error);
      const tls = networkCode !== undefined && (networkCode.includes('CERT') || networkCode.startsWith('ERR_SSL_') || networkCode.includes('TLS_')
        || ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(networkCode));
      const fault = signal.aborted ? faultForAbort(signal) : error instanceof ProtocolFault ? error
        : new ProtocolFault(tls ? 'tls' : networkCode !== undefined && ['ETIMEDOUT', 'ERR_TIMED_OUT', 'ERR_CONNECTION_TIMED_OUT'].includes(networkCode) ? 'timeout' : 'network');
      step = { state: 'failed', elapsedMs: elapsed(started), failure: toPublicFailure(fault), ...(networkCode === undefined ? {} : { networkCode }) };
    }
    ports.observe?.(phase, step); return step;
  };
  const tcp = direct ? run('tcp', async signal => {
    await (ports.tcp ?? connectTcp)(url.hostname.replace(/^\[|\]$/gu, ''), Number(url.port || (url.protocol === 'https:' ? 443 : 80)), signal);
    return 'open';
  }) : Promise.resolve<NetworkCheckStep>({ state: 'skipped', elapsedMs: 0, reason: 'proxy' });
  if (!direct) ports.observe?.('tcp', { state: 'skipped', elapsedMs: 0, reason: 'proxy' });
  const http = run('http', async signal => {
    const response = await ports.fetch(url.href, { method: 'HEAD', signal, credentials: 'omit', redirect: 'manual', cache: 'no-store', headers: { origin: url.origin } });
    await response.body?.cancel().catch(() => {});
    if (response.status < 100 || response.status > 599) throw new ProtocolFault('network');
    return response.status;
  });
  const [native, chromium] = await Promise.all([tcp, http]);
  if (lifetime.aborted) throw faultForAbort(lifetime);
  return { checkedAt: Date.now(), proxyMode: direct ? 'direct' : 'configured', tcp: native, http: chromium,
    conclusion: chromium.state === 'response' ? 'http-reachable' : !direct ? 'proxy-managed' : native.state === 'open' ? 'http-layer' : 'route-or-process' };
}
function elapsed(started: number): number { return Math.max(0, Math.min(30000, Math.round(performance.now() - started))); }
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener('abort', abort); reject(faultForAbort(signal)); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void promise.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) reject(faultForAbort(signal)); else resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(signal.aborted ? faultForAbort(signal) : error); });
  });
}
function connectTcp(host: string, port: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new Socket(); let ended = false;
    const finish = (error?: unknown): void => {
      if (ended) return; ended = true;
      signal.removeEventListener('abort', abort);
      socket.removeListener('connect', connected); socket.removeListener('error', failed);
      // 销毁未完成的单次检查 socket 是正常资源清理，不停止远程任务。
      socket.on('error', () => {}); socket.destroy();
      if (error === undefined) resolve(); else reject(error);
    };
    const abort = (): void => finish(faultForAbort(signal));
    const connected = (): void => finish(); const failed = (error: Error): void => finish(error);
    signal.addEventListener('abort', abort, { once: true });
    socket.once('connect', connected); socket.once('error', failed);
    if (signal.aborted) { abort(); return; }
    try { socket.connect({ host, port }); } catch (error) { finish(error); }
  });
}
