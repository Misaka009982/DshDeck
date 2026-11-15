import type { ServerConfig, ServerInput, ServerSnapshot, ConnectionState, ProbeSampleInput, ProbeSampleResult, SessionBrief, WorkspaceBrief } from '../../shared/contracts.js';
import { ProtocolFault, toPublicFailure } from '../../shared/faults.js';
import { normalizeServerInput } from '../../shared/server-config.js';
import { ServerStore } from '../config/server-store.js';
import type { ServerSession } from './server-session.js';
import { ProtocolProbe, validateSampleInput } from '../../../tools/poc/protocol-probe.js';

export interface AuthWindowHandle { focus(): void; close(): void }
export interface AuthWindowCallbacks {
  finished(): Promise<void>;
  cancelled(): void;
}
export type AuthWindowFactory = (config: ServerConfig, session: ServerSession, callbacks: AuthWindowCallbacks) => AuthWindowHandle;
interface ProbeHandle {
  connect(): Promise<{ workspaces: readonly WorkspaceBrief[]; sessions: readonly SessionBrief[] }>;
  sample(input: ProbeSampleInput): Promise<ProbeSampleResult>;
  stopSample(): void;
  dispose(): void;
}
export type ProbeFactory = (session: ServerSession, generation: number, signal: AbortSignal, failed: (fault: ProtocolFault) => void) => ProbeHandle;
interface ServerRuntime {
  config: ServerConfig;
  session: ServerSession;
  state: ConnectionState;
  generation: number;
  controller: AbortController | undefined;
  probe: ProbeHandle | undefined;
  browser: AuthWindowHandle | undefined;
  workspaces: readonly WorkspaceBrief[];
  sessions: readonly SessionBrief[];
  failure: ServerSnapshot['failure'];
  sample: ProbeSampleResult | null;
}

/** 就绪以 RPC 目录和 WS 业务 baseline 为准，不检查 Cookie 的有无来猜成功。 */
export class AuthService {
  private readonly runtimes = new Map<string, ServerRuntime>();
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed(): void { for (const listener of this.listeners) listener(); }

  constructor(
    private readonly store: ServerStore,
    private readonly createSession: (config: ServerConfig) => ServerSession,
    private readonly createBrowser: AuthWindowFactory,
    private readonly createProbe: ProbeFactory = (session, generation, signal, failed) => new ProtocolProbe(session.transport(signal), generation, signal, failed),
  ) {}

  async initialize(): Promise<void> {
    await this.store.load();
    for (const config of this.store.all()) this.runtimes.set(config.id, this.runtime(config));
    this.changed();
  }

  list(): readonly ServerSnapshot[] { return [...this.runtimes.values()].map(runtime => this.snapshot(runtime)); }
  serverSession(id: string): ServerSession { return this.get(id).session; }

  async add(input: ServerInput): Promise<ServerSnapshot> {
    const config = await this.store.add(input);
    const runtime = this.runtime(config);
    this.runtimes.set(config.id, runtime);
    this.changed();
    return this.snapshot(runtime);
  }

  async edit(id: string, input: ServerInput): Promise<ServerSnapshot> {
    const runtime = this.get(id);
    const normalized = normalizeServerInput(input);
    const changedScope = normalized.baseUrl !== runtime.config.baseUrl;
    if (changedScope) this.invalidate(runtime);
    const config = await this.store.edit(id, normalized);
    const current = this.get(id);
    if (config.authProfileId !== current.config.authProfileId) {
      this.invalidate(current);
      const replacement = this.runtime(config);
      replacement.generation = current.generation;
      current.session.clearVolatileCredentials();
      this.runtimes.set(id, replacement);
      this.changed();
      return this.snapshot(replacement);
    }
    current.config = config;
    this.changed();
    return this.snapshot(current);
  }

  async connect(id: string, openBrowserOnAuthFailure = true): Promise<ServerSnapshot> {
    const runtime = this.get(id);
    if (runtime.browser !== undefined) { runtime.browser.focus(); return this.snapshot(runtime); }
    this.invalidate(runtime);
    const generation = runtime.generation;
    const controller = new AbortController();
    runtime.controller = controller;
    runtime.state = 'probing';
    this.changed();
    let carrierFailure: ProtocolFault | undefined;
    try {
      const probe = this.createProbe(runtime.session, generation, controller.signal, fault => {
        if (!this.current(runtime, generation)) return;
        carrierFailure = fault;
        if (runtime.state === 'probing') { controller.abort(); return; }
        this.invalidate(runtime);
        runtime.state = stateForFault(fault);
        runtime.failure = toPublicFailure(fault);
        this.changed();
      });
      runtime.probe = probe;
      const proof = await probe.connect();
      if (!this.current(runtime, generation) || controller.signal.aborted) throw new ProtocolFault('cancelled');
      runtime.workspaces = proof.workspaces;
      runtime.sessions = proof.sessions;
      runtime.state = 'readonly-ready';
      this.changed();
      return this.snapshot(runtime);
    } catch (error) {
      if (!this.current(runtime, generation)) throw new ProtocolFault('cancelled');
      const fault = carrierFailure ?? (error instanceof ProtocolFault ? error : new ProtocolFault('network'));
      this.invalidate(runtime);
      runtime.state = stateForFault(fault);
      runtime.failure = toPublicFailure(fault);
      if (openBrowserOnAuthFailure && (fault.kind === 'auth-required' || fault.kind === 'login-response')) {
        this.authenticate(id);
      }
      this.changed();
      return this.snapshot(runtime);
    }
  }

  authenticate(id: string): void {
    const runtime = this.get(id);
    if (runtime.browser !== undefined) { runtime.browser.focus(); return; }
    this.invalidate(runtime);
    const generation = runtime.generation;
    runtime.state = 'authenticating';
    try {
      runtime.browser = this.createBrowser(runtime.config, runtime.session, {
        finished: async () => {
          if (!this.current(runtime, generation)) throw new ProtocolFault('cancelled');
          runtime.browser = undefined;
          // 认证视图已由窗口 owner 关闭；本轮失败不自动再次弹窗形成登录循环。
          await this.connect(id, false);
        },
        cancelled: () => {
          if (!this.current(runtime, generation)) return;
          this.invalidate(runtime);
          runtime.state = 'cancelled';
          this.changed();
        },
      });
      this.changed();
    } catch (error) {
      runtime.state = 'failed';
      runtime.failure = toPublicFailure(error);
      this.changed();
      throw error;
    }
  }

  disconnect(id: string): ServerSnapshot {
    const runtime = this.get(id);
    this.invalidate(runtime);
    runtime.state = 'idle';
    this.changed();
    return this.snapshot(runtime);
  }

  async runSample(id: string, input: ProbeSampleInput): Promise<ProbeSampleResult> {
    validateSampleInput(input);
    const runtime = this.get(id);
    if (runtime.state !== 'readonly-ready' || runtime.probe === undefined) throw new ProtocolFault('auth-required');
    if (!runtime.sessions.some(session => session.sessionId === input.sessionId)) throw new ProtocolFault('forbidden');
    const generation = runtime.generation;
    const result = await runtime.probe.sample(input);
    if (!this.current(runtime, generation)) throw new ProtocolFault('cancelled');
    runtime.sample = result;
    this.changed();
    return result;
  }

  stopSample(id: string): void { this.get(id).probe?.stopSample(); }

  dispose(): void { for (const runtime of this.runtimes.values()) this.invalidate(runtime); }

  private get(id: string): ServerRuntime {
    const runtime = this.runtimes.get(id);
    if (runtime === undefined) throw new ProtocolFault('not-found');
    return runtime;
  }

  private current(runtime: ServerRuntime, generation: number): boolean {
    return this.runtimes.get(runtime.config.id) === runtime && runtime.generation === generation;
  }

  private invalidate(runtime: ServerRuntime): void {
    runtime.generation++;
    const probe = runtime.probe;
    const browser = runtime.browser;
    runtime.controller?.abort();
    runtime.controller = undefined;
    runtime.probe = undefined;
    runtime.browser = undefined;
    probe?.dispose();
    browser?.close();
    runtime.workspaces = [];
    runtime.sessions = [];
    runtime.failure = null;
    runtime.sample = null;
    runtime.state = 'idle';
  }

  private runtime(config: ServerConfig): ServerRuntime {
    return {
      config, session: this.createSession(config), state: 'idle', generation: 0,
      controller: undefined, probe: undefined, browser: undefined,
      workspaces: [], sessions: [], failure: null, sample: null,
    };
  }

  private snapshot(runtime: ServerRuntime): ServerSnapshot {
    return {
      config: { ...runtime.config }, state: runtime.state, generation: runtime.generation,
      workspaces: runtime.workspaces.map(workspace => ({ ...workspace, sessionIds: [...workspace.sessionIds] })),
      sessions: runtime.sessions.map(session => ({ ...session })),
      failure: runtime.failure === null ? null : { ...runtime.failure },
      sample: runtime.sample === null ? null : { ...runtime.sample },
    };
  }
}

function stateForFault(fault: ProtocolFault): ConnectionState {
  if (fault.kind === 'auth-required' || fault.kind === 'login-response') return 'auth-required';
  if (fault.kind === 'forbidden') return 'denied';
  if (['protocol', 'unsupported', 'not-found'].includes(fault.kind)) return 'incompatible';
  if (fault.kind === 'cancelled') return 'cancelled';
  return 'failed';
}
