import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import { parseRemoteStreamClientMessage, parseRemoteStreamServerMessage } from '@deepseek-ai/dsh-api-gateway/stream-protocol';
import { ProtocolFault, remoteFault } from '../../shared/faults.js';
import { isCertificateFailure } from '../auth/tls-policy.js';
import { MuxRouter } from './mux-router.js';
import { assertReadRequest } from './read-policy.js';
import type { ReadRequest } from './read-policy.js';

export type StreamRole = 'directory' | 'detail' | 'state';
interface Subscription {
  readonly role: StreamRole;
  readonly unregister: () => void;
  readonly failed: (fault: ProtocolFault) => void;
}
export interface ReadSubscription { cancel(): void }

/** 一条认证物理 WS 上仅开放只读逻辑流；周期读取不会关闭物理 WS。 */
export class ReadOnlyMux {
  private readonly router = new MuxRouter();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (fault: ProtocolFault) => void;
  private closed = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly generation: number,
    private readonly onBytes: (role: StreamRole, bytes: number, item: boolean) => void = () => {},
    private readonly onClosed: (fault: ProtocolFault) => void = () => {},
  ) {
    this.router.beginGeneration(generation);
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    void this.ready.catch(() => {});
    socket.once('open', () => this.resolveReady());
    socket.on('message', (data, binary) => this.receive(data, binary));
    socket.on('error', error => this.fail(new ProtocolFault(isCertificateFailure(error) ? 'tls' : 'network')));
    socket.on('unexpected-response', (_request, response) => {
      const status = response.statusCode;
      response.destroy();
      this.fail(new ProtocolFault(status === 401 ? 'auth-required' : status === 403 ? 'forbidden' : 'unsupported'));
    });
    socket.once('close', () => this.fail(new ProtocolFault('network')));
    if (socket.readyState === WebSocket.OPEN) this.resolveReady();
    else if (socket.readyState !== WebSocket.CONNECTING) this.fail(new ProtocolFault('network'));
  }

  async waitUntilOpen(signal: AbortSignal, timeoutMs = 15000): Promise<void> {
    if (signal.aborted) throw new ProtocolFault('cancelled');
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fault?: ProtocolFault): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', aborted);
        if (fault !== undefined) reject(fault); else resolve();
      };
      const aborted = (): void => finish(new ProtocolFault('cancelled'));
      const timer = setTimeout(() => finish(new ProtocolFault('timeout')), timeoutMs);
      signal.addEventListener('abort', aborted, { once: true });
      this.ready.then(() => finish(), error => finish(error instanceof ProtocolFault ? error : new ProtocolFault('network')));
      if (signal.aborted) aborted();
    });
    if (this.closed) throw new ProtocolFault('network');
  }

  subscribe(request: ReadRequest, role: StreamRole, item: (value: unknown) => void, failed: (fault: ProtocolFault) => void): ReadSubscription {
    assertReadRequest(request);
    if (['session/list', 'session/events', 'session/state'].includes(request.endpoint)) throw new ProtocolFault('unsupported');
    return this.subscribeTrusted(request, role, item, failed);
  }

  protected subscribeTrusted(request: { readonly endpoint: string; readonly payload: unknown }, role: StreamRole, item: (value: unknown) => void, failed: (fault: ProtocolFault) => void): ReadSubscription {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) throw new ProtocolFault('network');
    const streamId = randomUUID();
    const cancel = (): void => this.cancel(streamId);
    const unregister = this.router.register(streamId, this.generation, frame => {
      if (frame.type === 'item') {
        try { item(frame.value); }
        catch (error) {
          cancel();
          failed(error instanceof ProtocolFault ? error : new ProtocolFault('protocol'));
        }
      } else {
        this.subscriptions.delete(streamId);
        unregister();
        failed(frame.type === 'error' ? remoteFault(frame.error.code) : new ProtocolFault('network'));
      }
    });
    this.subscriptions.set(streamId, { role, unregister, failed });
    try { this.send({ type: 'open', streamId, endpoint: request.endpoint, payload: request.payload }); }
    catch {
      this.subscriptions.delete(streamId);
      unregister();
      throw new ProtocolFault('network');
    }
    return { cancel };
  }

  async readOpening(request: ReadRequest, role: StreamRole, signal: AbortSignal): Promise<unknown> {
    await this.waitUntilOpen(signal);
    return new Promise((resolve, reject) => {
      let settled = false;
      let subscription: ReadSubscription | undefined;
      const finish = (value: unknown, fault?: ProtocolFault): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', aborted);
        subscription?.cancel();
        if (fault !== undefined) reject(fault); else resolve(value);
      };
      const aborted = (): void => finish(undefined, new ProtocolFault('cancelled'));
      const timer = setTimeout(() => finish(undefined, new ProtocolFault('timeout')), 15000);
      signal.addEventListener('abort', aborted, { once: true });
      try {
        subscription = this.subscribe(request, role, value => finish(value), fault => finish(undefined, fault));
      } catch (error) {
        finish(undefined, error instanceof ProtocolFault ? error : new ProtocolFault('network'));
      }
      if (signal.aborted) aborted();
    });
  }

  /** 只有用户断开、认证代次结束或物理故障才关闭该载体。 */
  dispose(): void {
    if (this.closed) return;
    this.closeSubscriptions(new ProtocolFault('cancelled'));
    this.socket.close(1000);
  }

  private receive(data: RawData, binary: boolean): void {
    if (this.closed) return;
    try {
      if (binary) throw new ProtocolFault('protocol');
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      const frame = parseRemoteStreamServerMessage(bytes.toString('utf8'));
      const subscription = this.subscriptions.get(frame.streamId);
      if (subscription !== undefined) this.onBytes(subscription.role, bytes.byteLength, frame.type === 'item');
      this.router.dispatch(frame, this.generation);
    } catch (error) {
      this.fail(error instanceof ProtocolFault ? error : new ProtocolFault('protocol'));
    }
  }

  private cancel(streamId: string): void {
    const subscription = this.subscriptions.get(streamId);
    if (subscription === undefined) return;
    this.subscriptions.delete(streamId);
    subscription.unregister();
    if (!this.closed && this.socket.readyState === WebSocket.OPEN) this.send({ type: 'cancel', streamId });
  }

  private send(value: unknown): void {
    const frame = parseRemoteStreamClientMessage(JSON.stringify(value));
    this.socket.send(JSON.stringify(frame), error => { if (error) this.fail(new ProtocolFault('network')); });
  }

  private fail(fault: ProtocolFault): void {
    if (this.closed) return;
    this.closeSubscriptions(fault);
    this.socket.close();
    this.onClosed(fault);
  }

  private closeSubscriptions(fault: ProtocolFault): void {
    this.closed = true;
    this.rejectReady(fault);
    const pending = [...this.subscriptions.values()];
    this.subscriptions.clear();
    for (const subscription of pending) {
      subscription.unregister();
      try { subscription.failed(fault); } catch { /* 单个消费方不能阻止其他读取释放。 */ }
    }
  }
}
