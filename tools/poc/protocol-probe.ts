import type WebSocket from 'ws';
import type { RpcFetch } from '@deepseek-ai/dsh-client-connection/client';
import type { ProbeSampleInput, ProbeSampleResult, SessionBrief, WorkspaceBrief } from '../../src/shared/contracts.js';
import { ProtocolFault, requireId, requireKeys, requireRecord } from '../../src/shared/faults.js';
import { ReadOnlyRpc } from '../../src/main/protocol/read-only-rpc.js';
import { ReadOnlyMux } from '../../src/main/protocol/read-only-mux.js';
import type { ReadSubscription } from '../../src/main/protocol/read-only-mux.js';
import { createReadRequest } from '../../src/main/protocol/read-policy.js';
import { parseSessionList, parseSessionSnapshotSummary, parseWorkspaceFrame } from '../../src/main/protocol/read-values.js';

export interface PocTransport {
  readonly fetch: RpcFetch;
  openWebSocket(signal: AbortSignal): Promise<WebSocket>;
}
interface Counters {
  httpBodyBytes: number;
  detailTextBytes: number;
  stateTextBytes: number;
  detailItems: number;
  stateItems: number;
  snapshotCount: number;
}
interface DirectoryProof {
  readonly workspaces: readonly WorkspaceBrief[];
  readonly sessions: readonly SessionBrief[];
}

/** 由 Electron main 使用；不是会自动登录或启动 dsh 的命令行脚本。 */
export class ProtocolProbe {
  private readonly rpc: ReadOnlyRpc;
  private mux: ReadOnlyMux | undefined;
  private counters: Counters | undefined;
  private sampling: AbortController | undefined;
  private manualStop = false;

  constructor(
    private readonly transport: PocTransport,
    private readonly generation: number,
    private readonly lifetime: AbortSignal,
    private readonly carrierFailed: (fault: ProtocolFault) => void,
  ) {
    this.rpc = new ReadOnlyRpc(transport.fetch, bytes => {
      if (this.counters !== undefined) this.counters.httpBodyBytes += bytes;
    });
  }

  async connect(): Promise<DirectoryProof> {
    const sessions = await this.sessionList(this.lifetime);
    const socket = await this.transport.openWebSocket(this.lifetime);
    if (this.lifetime.aborted) { socket.close(); throw new ProtocolFault('cancelled'); }
    this.mux = new ReadOnlyMux(socket, this.generation, (role, bytes, item) => {
      const counters = this.counters;
      if (counters === undefined) return;
      if (role === 'detail') { counters.detailTextBytes += bytes; if (item) counters.detailItems++; }
      if (role === 'state') { counters.stateTextBytes += bytes; if (item) counters.stateItems++; }
    }, this.carrierFailed);
    const opening = parseWorkspaceFrame(await this.mux.readOpening(createReadRequest('workspace/follow'), 'directory', this.lifetime));
    if (opening.type !== 'baseline') throw new ProtocolFault('protocol');
    if (this.lifetime.aborted) throw new ProtocolFault('cancelled');
    return { workspaces: opening.value.items, sessions };
  }

  async sample(input: ProbeSampleInput): Promise<ProbeSampleResult> {
    validateSampleInput(input);
    if (this.sampling !== undefined) throw new ProtocolFault('unsupported');
    if (this.mux === undefined || this.lifetime.aborted) throw new ProtocolFault('network');
    const mux = this.mux;
    const controller = new AbortController();
    this.sampling = controller;
    this.manualStop = false;
    const signal = AbortSignal.any([this.lifetime, controller.signal]);
    const counters: Counters = { httpBodyBytes: 0, detailTextBytes: 0, stateTextBytes: 0, detailItems: 0, stateItems: 0, snapshotCount: 0 };
    this.counters = counters;
    const started = performance.now();
    let elapsed = false;
    let failure: ProtocolFault | undefined;
    let stateSubscription: ReadSubscription | undefined;
    let detailSubscription: ReadSubscription | undefined;
    let lastCursor: number | null = null;
    let beforeAgentAvailable: boolean | null = null;
    let afterAgentAvailable: boolean | null = null;
    const timer = setTimeout(() => { elapsed = true; controller.abort(); }, input.durationSeconds * 1000);
    const failed = (fault: ProtocolFault): void => { failure = fault; controller.abort(); };
    const snapshot = (value: unknown): void => {
      const summary = parseSessionSnapshotSummary(value, input.sessionId);
      lastCursor = summary.cursor;
      counters.snapshotCount++;
    };
    try {
      const before = (await this.sessionList(signal)).find(item => item.sessionId === input.sessionId);
      if (before === undefined) throw new ProtocolFault('forbidden');
      beforeAgentAvailable = before.agentAvailable;
      const stateRequest = input.stateStream === 'control'
        ? createReadRequest('session/control') : createReadRequest('session/observeState', { sessionId: input.sessionId });
      stateSubscription = mux.subscribe(stateRequest, 'state', value => validateStateItem(value, input.stateStream), failed);
      const detail = createReadRequest('session/follow', { sessionId: input.sessionId, maxMessages: 20 });
      if (input.mode === 'realtime') {
        let opened = false;
        detailSubscription = mux.subscribe(detail, 'detail', value => {
          if (!opened) { snapshot(value); opened = true; return; }
          const frame = requireRecord(value);
          if (frame.type === 'event') {
            const event = requireRecord(frame.event);
            const seq = event.seq;
            if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) throw new ProtocolFault('protocol');
            if (lastCursor !== null && seq > lastCursor + 1) throw new ProtocolFault('protocol');
            lastCursor = Math.max(lastCursor ?? -1, seq);
          } else if (frame.type === 'assistant-stream') {
            const assistant = requireRecord(frame.frame);
            if (!['start', 'chunk', 'end'].includes(String(assistant.type))) throw new ProtocolFault('protocol');
            // assistant 瞬态帧只进入字节统计，不推进持久 cursor。
          } else throw new ProtocolFault('protocol');
        }, failed);
        await waitForAbort(signal);
      } else {
        while (!signal.aborted) {
          snapshot(await mux.readOpening(detail, 'detail', signal));
          await delay(input.intervalSeconds * 1000, signal);
        }
      }
    } catch (error) {
      if (!elapsed && !this.manualStop && failure === undefined) failure = error instanceof ProtocolFault ? error : new ProtocolFault('protocol');
    } finally {
      clearTimeout(timer);
      stateSubscription?.cancel();
      detailSubscription?.cancel();
    }
    // 收尾仍属于同一次采样；期间不得让新样本覆盖计数器，用户停止也要能取消它。
    const tail = new AbortController();
    this.sampling = tail;
    try {
      if (!this.lifetime.aborted && !this.manualStop && failure === undefined) {
        afterAgentAvailable = (await this.sessionList(AbortSignal.any([this.lifetime, tail.signal])))
          .find(item => item.sessionId === input.sessionId)?.agentAvailable ?? null;
      }
    } catch { afterAgentAvailable = null; }
    finally { this.counters = undefined; this.sampling = undefined; }
    if (this.lifetime.aborted) throw new ProtocolFault('cancelled');
    if (failure !== undefined && !this.manualStop) throw failure;
    if (!this.manualStop && (counters.snapshotCount === 0 || counters.stateItems === 0)) throw new ProtocolFault('timeout');
    return {
      ...counters, mode: input.mode, stateStream: input.stateStream,
      elapsedMs: Math.round(performance.now() - started), stopped: this.manualStop, lastCursor,
      beforeAgentAvailable, afterAgentAvailable,
      byteBasis: 'decoded-body-and-ws-text', sideEffectsVerified: false,
    };
  }

  stopSample(): void { this.manualStop = true; this.sampling?.abort(); }

  dispose(): void {
    this.stopSample();
    this.rpc.dispose();
    this.mux?.dispose();
    this.mux = undefined;
  }

  private async sessionList(signal: AbortSignal): Promise<readonly SessionBrief[]> {
    const timeout = AbortSignal.timeout(15000);
    try { return parseSessionList(await this.rpc.call(createReadRequest('session/list'), AbortSignal.any([signal, timeout]))); }
    catch (error) {
      if (timeout.aborted && !signal.aborted) throw new ProtocolFault('timeout');
      throw error;
    }
  }
}

export function validateSampleInput(value: unknown): asserts value is ProbeSampleInput {
  const input = requireRecord(value);
  requireKeys(input, ['sessionId', 'mode', 'stateStream', 'durationSeconds', 'intervalSeconds']);
  requireId(input.sessionId);
  if (input.mode !== 'realtime' && input.mode !== 'periodic') throw new ProtocolFault('protocol');
  if (input.stateStream !== 'observe-state' && input.stateStream !== 'control') throw new ProtocolFault('protocol');
  for (const [key, min, max] of [['durationSeconds', 5, 600], ['intervalSeconds', 1, 3600]] as const) {
    const number = input[key];
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < min || number > max) throw new ProtocolFault('protocol');
  }
}

function validateStateItem(value: unknown, stream: ProbeSampleInput['stateStream']): void {
  const frame = requireRecord(value);
  if (stream === 'observe-state') {
    requireKeys(frame, ['cursor', 'active', 'running', 'queue', 'pendingInput']);
    validCursor(frame.cursor);
    if (typeof frame.active !== 'boolean' || typeof frame.running !== 'boolean'
      || (frame.queue !== null && !Array.isArray(frame.queue)) || !Array.isArray(frame.pendingInput)
      || frame.pendingInput.some(item => !['approval', 'question', 'other'].includes(String(item)))) throw new ProtocolFault('protocol');
  } else if (frame.type === 'baseline') {
    requireKeys(frame, ['type', 'value']);
    const baseline = requireRecord(frame.value);
    requireKeys(baseline, ['projections']);
    const projections = requireRecord(baseline.projections);
    for (const value of Object.values(projections)) {
      const projection = requireRecord(value);
      requireKeys(projection, ['asOfSeq', 'values']);
      validCursor(projection.asOfSeq);
      requireRecord(projection.values);
    }
  } else if (frame.type === 'projection') {
    requireKeys(frame, ['type', 'sessionId', 'seq', 'changes']);
    requireId(frame.sessionId);
    validCursor(frame.seq);
    if (!Array.isArray(frame.changes)) throw new ProtocolFault('protocol');
    const keys = new Set<string>();
    for (const value of frame.changes) {
      const change = requireRecord(value);
      requireKeys(change, ['key', 'val']);
      const key = requireId(change.key);
      if (keys.has(key)) throw new ProtocolFault('protocol');
      keys.add(key);
    }
  } else throw new ProtocolFault('protocol');
}

function validCursor(value: unknown): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < -1 || Object.is(value, -0)) throw new ProtocolFault('protocol');
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}
