import type { EventEmitter } from 'node:events';
import { ProtocolFault, faultForAbort } from '../../shared/faults.js';
import { isCertificateFailure } from './tls-policy.js';
import { networkErrorCode } from '../logging/connection-details.js';

export interface HandshakeSocket extends EventEmitter {
  readonly readyState: number;
  close(): void;
  terminate(): void;
}
interface HandshakeResponse {
  readonly statusCode?: number;
  readonly headers: { readonly 'www-authenticate'?: string | string[] };
  destroy(): unknown;
}
export class SocketHandshakeFault extends ProtocolFault {
  constructor(readonly status: number, readonly challenge: string | null) {
    super(status === 401 ? 'auth-required' : status === 403 ? 'forbidden' : status >= 300 && status < 400 ? 'login-response' : 'network');
  }
}

/** 先结束失败握手再交给调用方决定是否重试；未知 HTTP 响应不悬挂，也不携带原始响应正文。 */
export function waitForWebSocket<T extends HandshakeSocket>(socket: T, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const consumeError = (): void => {};
    const removeWaiting = (): void => {
      socket.removeListener('open', opened); socket.removeListener('error', failed);
      socket.removeListener('unexpected-response', unexpected); socket.removeListener('close', closed);
    };
    const finish = (fault?: ProtocolFault): void => {
      if (settled) return;
      settled = true; removeWaiting(); signal.removeEventListener('abort', aborted);
      if (fault === undefined) resolve(socket); else reject(fault);
    };
    const opened = (): void => { if (signal.aborted) aborted(); else finish(); };
    const failed = (error: unknown): void => {
      const fault = new ProtocolFault(isCertificateFailure(error) ? 'tls' : 'network');
      const code = networkErrorCode(error);
      if (code !== undefined) Object.assign(fault, { code });
      finish(signal.aborted ? faultForAbort(signal) : fault);
    };
    const closed = (): void => finish(signal.aborted ? faultForAbort(signal) : new ProtocolFault('network'));
    const aborted = (): void => {
      finish(faultForAbort(signal));
      if (socket.readyState === 1) socket.close(); else if (socket.readyState !== 3) socket.terminate();
    };
    const unexpected = (request: { destroy(): unknown }, response: HandshakeResponse): void => {
      const header = response.headers['www-authenticate'];
      const challenge = typeof header === 'string' ? header : Array.isArray(header) ? header.join(', ') : null;
      const status = response.statusCode ?? 0;
      finish(signal.aborted ? faultForAbort(signal) : new SocketHandshakeFault(status, challenge !== null && challenge.length <= 4096 ? challenge : null));
      // 注册 unexpected-response 后 ws 不会自动处理失败；销毁请求，避免留下 CONNECTING 载体。
      response.destroy(); request.destroy(); if (socket.readyState !== 3) socket.terminate();
    };
    // terminate 可能迟到触发 error；在最终 close 前保留空消费者，避免主进程未处理异常。
    socket.on('error', consumeError);
    socket.once('close', () => { signal.removeEventListener('abort', aborted); socket.removeListener('error', consumeError); });
    socket.once('open', opened); socket.once('error', failed); socket.once('unexpected-response', unexpected); socket.once('close', closed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted(); else if (socket.readyState === 1) opened(); else if (socket.readyState === 3) closed();
  });
}
