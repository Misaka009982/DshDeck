import type { PocTransport } from '../../../tools/poc/protocol-probe.js';
import type { AdapterCallbacks, AdapterSubscription, FollowCallbacks, WorkbenchAdapter } from './adapter.js';
import type { AnswerInput, FollowSnapshot, HistoryPage, SendTextInput, ServerScope } from '../../shared/domain.js';
import type { ProbeSampleInput, ProbeSampleResult } from '../../shared/contracts.js';
import type { DirectorySession } from '../state/directory-store.js';
import { ProtocolFault, requireId, requireKeys, requireRecord } from '../../shared/faults.js';
import { createReadRequest } from './read-policy.js';
import { promptRequest } from './business-policy.js';
import { parseSessionList, parseWorkspaceFrame } from './read-values.js';
import { parseAssistantFrame, parseFollowSnapshot, parseHistory, parsePassiveState, parseWireEvent } from './wire-values.js';
import { RemoteRpc } from './rpc.js';
import { RemoteMux } from './remote-stream.js';
import { PendingInteractions, parseEventFrame } from './pending-interaction.js';
import { nativeOwnsInteraction } from './interaction-ownership.js';
import type { WebInteractionOwner } from './interaction-ownership.js';
import { nativeRequest } from './native-policy.js';
import { parseModelCatalog, parseModelSelection, parseCommands, parseCommandExecution, parseGoalRef, parseGoalSnapshot } from '../../shared/native-controls.js';
import type { CommandDescriptor, CommandExecution, ModelCatalog, ModelSelection, SelectModelInput, GoalActionInput } from '../../shared/native-controls.js';
import { parseProjectionBaseline, parseProjectionFrame, ProjectionBuffer } from './native-projections.js';
import { parseJobFollow, parseJobRows } from '../../shared/jobs.js';
import type { JobOutputCallbacks, JobRowsCallbacks } from './adapter.js';

/** 固定公开协议适配器；目录/事件准入之后才接人工输入，不创建本地或远程 Agent。 */
export class DshWebAdapter implements WorkbenchAdapter {
  readonly source = 'live' as const;
  private readonly rpc: RemoteRpc;
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private readonly interactions: PendingInteractions;
  private mux: RemoteMux | undefined;
  private summaries: readonly DirectorySession[] = [];
  private disposed = false;
  private ready = false;
  private clientId: string | null = null;
  private statePolling = true;
  private polling: ReturnType<typeof setTimeout> | undefined;
  private refreshPending: Promise<void> | undefined;
  private readonly answers = new Map<string, AbortController>();
  private readonly deliveries = new Map<string, AbortController>();
  private readonly sent = new Map<string, { text: string; state: 'sending' | 'accepted' | 'uncertain' }>();
  private webOwner: WebInteractionOwner | null = null;
  private catalog: ModelCatalog | undefined;
  private catalogFlight: Promise<ModelCatalog> | undefined;
  private catalogEpoch = 0;
  private commandEpoch = 0;
  private readonly commandCatalogs = new Map<string, readonly CommandDescriptor[]>();
  private readonly commandFlights = new Map<string, Promise<readonly CommandDescriptor[]>>();

  constructor(readonly scope: ServerScope, private readonly transport: PocTransport, private readonly callbacks: AdapterCallbacks, lifetime: AbortSignal) {
    this.signal = AbortSignal.any([lifetime, this.controller.signal]);
    this.rpc = new RemoteRpc(transport.fetch);
    this.interactions = new PendingInteractions(scope, pending => {
      if (!this.disposed) this.callbacks.pending(pending);
    });
  }

  async connect() {
    await this.refreshSessions();
    const socket = await this.transport.openWebSocket(this.signal);
    if (this.signal.aborted) { socket.close(); throw new ProtocolFault('cancelled'); }
    const mux = new RemoteMux(socket, this.scope.generation, () => {}, fault => this.fail(fault));
    this.mux = mux;
    await mux.waitUntilOpen(this.signal);
    await this.openEvents(mux);
    const opening = parseWorkspaceFrame(await mux.readOpening(createReadRequest('workspace/follow'), 'directory', this.signal));
    if (opening.type !== 'baseline') throw new ProtocolFault('protocol');
    // 先安装长期目录流，再替换基线；第二个开场覆盖之前读到的短暂目录。
    await this.openWorkspaces(mux);
    this.ready = true;
    this.schedulePoll(0);
    return { workspaces: opening.value.items, sessions: this.summaries };
  }

  async follow(sessionId: string, callbacks: FollowCallbacks, signal: AbortSignal): Promise<AdapterSubscription> {
    const mux = this.requireMux();
    this.assertSession(sessionId);
    const combined = AbortSignal.any([this.signal, signal]);
    await mux.waitUntilOpen(combined);
    let opened = false;
    const subscriptions = new Set<AdapterSubscription>();
    const add = (subscription: AdapterSubscription): void => { if (combined.aborted) subscription.cancel(); else subscriptions.add(subscription); };
    const subscription = mux.subscribe(createReadRequest('session/follow', { sessionId, maxMessages: 40 }), 'detail', value => {
      const frame = requireRecord(value);
      if (!opened) {
        const snapshot = parseFollowSnapshot(value, sessionId);
        opened = true; callbacks.snapshot(snapshot);
        if (callbacks.projections !== undefined) void this.observeNativeProjections(sessionId, callbacks, combined, add);
        return;
      }
      if (frame.type === 'event') { requireKeys(frame, ['type', 'event']); callbacks.event(parseWireEvent(frame.event)); }
      else if (frame.type === 'assistant-stream') { requireKeys(frame, ['type', 'frame']); callbacks.assistant(parseAssistantFrame(frame.frame)); }
      else throw new ProtocolFault('protocol');
    }, callbacks.failed);
    add(subscription);
    const cancel = (): void => { for (const stream of subscriptions) stream.cancel(); subscriptions.clear(); };
    combined.addEventListener('abort', cancel, { once: true });
    if (combined.aborted) cancel();
    return { cancel: () => { combined.removeEventListener('abort', cancel); cancel(); } };
  }
  async opening(sessionId: string, signal: AbortSignal): Promise<FollowSnapshot> {
    this.assertSession(sessionId);
    const value = await this.requireMux().readOpening(createReadRequest('session/follow', { sessionId, maxMessages: 40 }), 'detail', AbortSignal.any([this.signal, signal]));
    return parseFollowSnapshot(value, sessionId);
  }
  async history(sessionId: string, beforeSeq: number, throughSeq: number, signal: AbortSignal): Promise<HistoryPage> {
    this.assertSession(sessionId);
    return parseHistory(await this.read(createReadRequest('session/events', { sessionId, maxMessages: 80, beforeSeq, throughSeq }), signal));
  }
  async send(input: SendTextInput, signal: AbortSignal): Promise<void> {
    this.assertReady(); this.assertContext(input.context); this.assertSession(input.context.sessionId);
    const key = JSON.stringify([input.context.sessionId, input.requestId]);
    const previous = this.sent.get(key);
    if (previous !== undefined) {
      if (previous.text !== input.text) throw new ProtocolFault('conflict');
      if (previous.state === 'accepted') return;
      // 即使用户再次点击，也不重新发送已进入网络、送达未知的请求。
      throw new ProtocolFault('uncertain');
    }
    if (this.sent.size >= 512) throw new ProtocolFault('budget');
    const request = promptRequest(input.context.sessionId, input.requestId, input.text);
    this.sent.set(key, { text: input.text, state: 'sending' });
    try {
      const result = requireRecord(await this.read(request, signal));
      requireKeys(result, ['accepted']);
      if (result.accepted !== true) throw new ProtocolFault('protocol');
      this.sent.set(key, { text: input.text, state: 'accepted' });
    } catch (error) {
      this.sent.set(key, { text: input.text, state: 'uncertain' });
      if (error instanceof ProtocolFault && ['forbidden', 'auth-required', 'not-found', 'unsupported'].includes(error.kind)) throw error;
      throw new ProtocolFault('uncertain');
    }
  }
  async stop(sessionId: string, signal: AbortSignal): Promise<void> {
    this.assertReady(); this.assertSession(sessionId);
    const result = requireRecord(await this.read({ endpoint: 'session/cancel', payload: { args: { request: { sessionId } } } }, signal));
    requireKeys(result, ['accepted']);
    if (result.accepted !== true) throw new ProtocolFault('protocol');
  }
  async answer(input: AnswerInput, signal: AbortSignal): Promise<void> {
    this.assertReady(); this.assertContext(input.context);
    if (this.answers.has(input.interactionId)) throw new ProtocolFault('uncertain');
    const prepared = this.interactions.prepare(input);
    const controller = new AbortController();
    this.answers.set(input.interactionId, controller);
    try {
      const { clientId, eventId, outcome } = prepared.result;
      await this.read({ endpoint: '$events/result', payload: { args: { clientId, eventId, outcome } } }, AbortSignal.any([signal, controller.signal]));
      prepared.commit();
    } catch (error) {
      if (controller.signal.aborted) throw new ProtocolFault('cancelled');
      throw error;
    } finally { this.answers.delete(input.interactionId); }
  }
  watchJobRows(sessionId: string, callbacks: JobRowsCallbacks, signal: AbortSignal): AdapterSubscription {
    this.assertReady(); this.assertSession(sessionId); const combined = AbortSignal.any([this.signal, signal]);
    if (combined.aborted) throw new ProtocolFault('cancelled');
    const stream = this.requireMux().jobRows(sessionId, value => { if (!combined.aborted) callbacks.item(parseJobRows(value, sessionId)); }, fault => { if (!combined.aborted) callbacks.failed(fault); });
    const cancel = (): void => stream.cancel(); combined.addEventListener('abort', cancel, { once: true });
    if (combined.aborted) cancel();
    return { cancel: () => { combined.removeEventListener('abort', cancel); cancel(); } };
  }
  followJob(sessionId: string, jobId: string, from: number | undefined, callbacks: JobOutputCallbacks, signal: AbortSignal): AdapterSubscription {
    this.assertReady(); this.assertSession(sessionId); const combined = AbortSignal.any([this.signal, signal]);
    if (combined.aborted) throw new ProtocolFault('cancelled');
    let stream: AdapterSubscription | undefined;
    stream = this.requireMux().jobOutput(sessionId, jobId, from, value => {
      if (combined.aborted) return; const frame = parseJobFollow(value, sessionId, jobId); callbacks.item(frame);
      if (frame.type === 'status') stream?.cancel();
    }, fault => { if (!combined.aborted) callbacks.failed(fault); });
    const cancel = (): void => stream?.cancel(); combined.addEventListener('abort', cancel, { once: true });
    if (combined.aborted) cancel();
    return { cancel: () => { combined.removeEventListener('abort', cancel); cancel(); } };
  }
  async modelCatalog(signal: AbortSignal, refresh = false): Promise<ModelCatalog> {
    this.assertReady();
    if (refresh) { this.catalog = undefined; this.catalogEpoch++; }
    if (this.catalog !== undefined) return this.catalog;
    if (!refresh && this.catalogFlight !== undefined) return this.catalogFlight;
    const epoch = this.catalogEpoch;
    const work = this.read(nativeRequest('session/modelCatalog', {}), signal).then(value => {
      const catalog = parseModelCatalog(value); if (!this.signal.aborted && epoch === this.catalogEpoch) this.catalog = catalog; return catalog;
    });
    this.catalogFlight = work;
    try { return await work; } finally { if (this.catalogFlight === work) this.catalogFlight = undefined; }
  }
  async commands(sessionId: string, signal: AbortSignal, refresh = false): Promise<readonly CommandDescriptor[]> {
    this.assertReady(); this.assertSession(sessionId);
    if (refresh) { this.commandCatalogs.delete(sessionId); this.commandEpoch++; }
    const cached = this.commandCatalogs.get(sessionId); if (cached !== undefined) return cached;
    const pending = this.commandFlights.get(sessionId); if (pending !== undefined && !refresh) return pending;
    const epoch = this.commandEpoch;
    const work = this.read(nativeRequest('commands/list', { agentId: sessionId }), signal).then(value => {
      const commands = parseCommands(value);
      if (!this.signal.aborted && epoch === this.commandEpoch) {
        if (this.commandCatalogs.size >= 128 && !this.commandCatalogs.has(sessionId)) this.commandCatalogs.delete(this.commandCatalogs.keys().next().value ?? '');
        this.commandCatalogs.set(sessionId, commands);
      }
      return commands;
    });
    this.commandFlights.set(sessionId, work);
    try { return await work; } finally { if (this.commandFlights.get(sessionId) === work) this.commandFlights.delete(sessionId); }
  }
  async selectModel(input: SelectModelInput, signal: AbortSignal): Promise<ModelSelection> {
    this.assertReady(); this.assertContext(input.context); this.assertSession(input.context.sessionId);
    const result = requireRecord(await this.read(nativeRequest('session/selectModel', { request: { sessionId: input.context.sessionId, ...input.selection } }), signal));
    requireKeys(result, ['selected']); return parseModelSelection(result.selected);
  }
  async goalAction(input: GoalActionInput, signal: AbortSignal): Promise<void> {
    this.assertReady(); this.assertContext(input.context); this.assertSession(input.context.sessionId);
    const action = input.action; const agentId = input.context.sessionId;
    const request = action.kind === 'create' ? nativeRequest('goals/create', { agentId, request: { objective: action.objective } })
      : action.kind === 'edit' ? nativeRequest('goals/edit', { agentId, ref: action.ref, request: { objective: action.objective } })
        : nativeRequest(action.kind === 'pause' ? 'goals/pause' : action.kind === 'resume' ? 'goals/resume' : 'goals/clear', { agentId, ref: action.ref });
    const result = await this.read(request, signal);
    if (action.kind === 'create') parseGoalRef(requireRecord(result).ref);
    else if (action.kind === 'clear') parseGoalRef(result);
    else parseGoalSnapshot(result);
  }
  async executeCommand(input: SendTextInput, signal: AbortSignal): Promise<CommandExecution> {
    this.assertReady(); this.assertContext(input.context); this.assertSession(input.context.sessionId);
    const line = input.text.trim(); const name = /^\/([^\s/]+)/u.exec(line)?.[1];
    const command = (await this.commands(input.context.sessionId, signal)).find(command => command.name === name);
    if (command === undefined || name === undefined) throw new ProtocolFault('unsupported');
    if (line.slice(name.length + 1).trim() !== '' && command.input === undefined) throw new ProtocolFault('unsupported');
    const result = await this.read(nativeRequest('commands/execute', { agentId: input.context.sessionId, line, submittedAttachments: [] }), signal);
    if (result === undefined) throw new ProtocolFault('not-found');
    return parseCommandExecution(result);
  }
  async sample(_input: ProbeSampleInput): Promise<ProbeSampleResult> { throw new ProtocolFault('unsupported'); }
  stopSample(): void {}
  setWebOwner(owner: WebInteractionOwner | null): void {
    if (this.interactions.all().some(pending => !nativeOwnsInteraction(owner, pending.sessionId))) throw new ProtocolFault('conflict');
    this.webOwner = owner === null ? null : { ...owner };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.ready = false;
    if (this.polling !== undefined) clearTimeout(this.polling);
    this.controller.abort(); this.rpc.dispose(); this.mux?.dispose(); this.interactions.dispose();
    for (const controller of this.answers.values()) controller.abort();
    for (const controller of this.deliveries.values()) controller.abort();
    this.answers.clear(); this.deliveries.clear(); this.sent.clear(); this.commandCatalogs.clear(); this.commandFlights.clear(); this.catalog = undefined;
  }

  private async observeNativeProjections(sessionId: string, callbacks: FollowCallbacks, signal: AbortSignal, add: (subscription: AdapterSubscription) => void): Promise<void> {
    let broken: ProtocolFault | undefined; let reported = false; let projectionStream: AdapterSubscription | undefined;
    const report = (fault: ProtocolFault): void => {
      broken = fault; projectionStream?.cancel();
      if (!signal.aborted && !reported) { reported = true; callbacks.projectionsFailed?.(fault); }
    };
    const buffer = new ProjectionBuffer(frame => { if (!signal.aborted && broken === undefined) callbacks.projections?.(frame); });
    try {
      await awaitOpening(signal, accept => {
        const stream = this.requireMux().projections(sessionId, value => {
          if (signal.aborted || broken !== undefined) return;
          const frame = parseProjectionFrame(value);
          if (frame.kind === 'ready') { if (accept.opened()) throw new ProtocolFault('protocol'); accept.ready(); }
          else { if (!accept.opened()) throw new ProtocolFault('protocol'); buffer.change(frame); }
        }, fault => { accept.failed(fault); report(fault); });
        projectionStream = stream; add(stream); return stream;
      });
      if (signal.aborted || broken !== undefined) return;
      const baseline = parseProjectionBaseline(await this.read(nativeRequest('session/projections', { request: { sessionId } }), signal));
      if (!signal.aborted && broken === undefined) buffer.baseline(baseline);
    } catch (error) { report(asFault(error)); }
  }

  private async openEvents(mux: RemoteMux): Promise<void> {
    await awaitOpening(this.signal, accept => mux.events(value => {
      const frame = parseEventFrame(value);
      if (frame.type === 'ready') {
        if (accept.opened()) throw new ProtocolFault('protocol');
        this.clientId = frame.clientId;
        this.interactions.ready(frame.clientId); accept.ready(); return;
      }
      if (!accept.opened()) throw new ProtocolFault('protocol');
      if (frame.type === 'cancel') {
        this.deliveries.get(frame.eventId)?.abort(); this.answers.get(frame.eventId)?.abort(); this.interactions.cancel(frame.eventId);
      }
      else if (frame.type === 'waterfall') {
        if (this.deliveries.has(frame.eventId)) throw new ProtocolFault('protocol');
        const controller = new AbortController(); this.deliveries.set(frame.eventId, controller);
        const deliverySignal = AbortSignal.any([this.signal, controller.signal]);
        void this.refreshSessions().then(async () => {
          if (deliverySignal.aborted) return;
          if (nativeOwnsInteraction(this.webOwner, frame.agentId) && this.summaries.some(session => session.sessionId === frame.agentId)) this.interactions.receive(frame);
          else if (this.clientId !== null) {
            // 与官方 Client 的无可解析 Agent Context 行为一致：只交还 Host 链，不批准或回答。
            await this.read({ endpoint: '$events/result', payload: { args: { clientId: this.clientId, eventId: frame.eventId, outcome: { kind: 'next' } } } }, deliverySignal);
          }
        }).catch(fault => { if (!deliverySignal.aborted) this.fail(asFault(fault)); }).finally(() => this.deliveries.delete(frame.eventId));
      }
      else this.notification(frame.event, frame.args);
    }, fault => { accept.failed(fault); if (accept.opened()) this.fail(fault); }));
  }
  private async openWorkspaces(mux: RemoteMux): Promise<void> {
    await awaitOpening(this.signal, accept => mux.subscribe(createReadRequest('workspace/follow'), 'directory', value => {
      const frame = parseWorkspaceFrame(value);
      if (!accept.opened() && frame.type !== 'baseline') throw new ProtocolFault('protocol');
      this.callbacks.workspaces(frame);
      if (!accept.opened()) accept.ready();
    }, fault => { accept.failed(fault); if (accept.opened()) this.fail(fault); }));
  }
  private notification(event: string, args: readonly unknown[]): void {
    if (event === 'api-session/status') {
      if (args.length !== 2 || typeof args[1] !== 'boolean') throw new ProtocolFault('protocol');
      this.callbacks.running(requireId(args[0]), args[1]);
      this.summaries = this.summaries.map(session => session.sessionId === args[0] ? { ...session, running: args[1] as boolean } : session);
    } else if (event === 'api-session/removed') {
      if (args.length !== 1) throw new ProtocolFault('protocol');
      const id = requireId(args[0]); this.summaries = this.summaries.filter(session => session.sessionId !== id); this.callbacks.removed(id);
    } else if (event === 'api-session/added' || event === 'api-session/activity') {
      void this.refreshSessions().catch(fault => this.fail(asFault(fault)));
    } else if (['llm/adapters-updated', 'llm/models-updated', 'settings/document-updated', 'credentials/record-updated', 'credentials/reference-updated'].includes(event)) {
      this.catalog = undefined; this.catalogFlight = undefined; this.catalogEpoch++;
    } else if (event === 'commands/change' || event === 'agent-preset/selected') {
      this.commandEpoch++; this.commandCatalogs.clear(); this.commandFlights.clear();
    }
    // 仅使目录缓存失效，不记录模型/凭据/插件通知内容，也不据工具报错推导整轮失败。
  }
  private async refreshSessions(): Promise<void> {
    if (this.refreshPending !== undefined) return this.refreshPending;
    const work = (async () => {
      this.summaries = parseSessionList(await this.read(createReadRequest('session/list'), this.signal));
      this.callbacks.sessions(this.summaries);
    })();
    this.refreshPending = work;
    try { await work; } finally { if (this.refreshPending === work) this.refreshPending = undefined; }
  }
  private schedulePoll(delay: number): void {
    if (this.signal.aborted || this.disposed) return;
    this.polling = setTimeout(() => { void this.pollStates().finally(() => this.schedulePoll(1500)); }, delay);
  }
  private async pollStates(): Promise<void> {
    if (!this.statePolling) return;
    const pending = this.interactions.all();
    const queue = this.summaries.filter(session => session.agentAvailable || session.running
      || pending.some(pending => pending.sessionId === session.sessionId));
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < queue.length && !this.signal.aborted) {
        const session = queue[next++]; if (session === undefined) return;
        try {
          const state = parsePassiveState(await this.read(createReadRequest('session/state', { sessionId: session.sessionId }), this.signal));
          this.callbacks.state(session.sessionId, state);
        } catch (error) {
          const fault = asFault(error);
          if (fault.kind === 'not-found') { this.summaries = this.summaries.filter(item => item.sessionId !== session.sessionId); this.callbacks.removed(session.sessionId); continue; }
          if (fault.kind === 'unsupported') { this.statePolling = false; return; }
          if (fault.kind !== 'cancelled') this.fail(fault);
          return;
        }
      }
    };
    await Promise.all([worker(), worker()]);
  }
  private read(request: import('./business-policy.js').BusinessRequest, signal: AbortSignal): Promise<unknown> {
    return this.rpc.call(request, AbortSignal.any([this.signal, signal, AbortSignal.timeout(15000)]));
  }
  private requireMux(): RemoteMux { if (this.mux === undefined || this.signal.aborted) throw new ProtocolFault('network'); return this.mux; }
  private assertReady(): void { if (!this.ready || this.signal.aborted) throw new ProtocolFault('auth-required'); }
  private assertSession(sessionId: string): void { if (!this.summaries.some(session => session.sessionId === sessionId)) throw new ProtocolFault('forbidden'); }
  private assertContext(context: ServerScope): void {
    if (context.serverId !== this.scope.serverId || context.authProfileId !== this.scope.authProfileId || context.generation !== this.scope.generation) throw new ProtocolFault('cancelled');
  }
  private fail(fault: ProtocolFault): void { if (!this.disposed && !this.signal.aborted) this.callbacks.failed(fault); }
}
function asFault(error: unknown): ProtocolFault { return error instanceof ProtocolFault ? error : new ProtocolFault('protocol'); }
interface OpeningAcceptor { opened(): boolean; ready(): void; failed(fault: ProtocolFault): void }
function awaitOpening(signal: AbortSignal, subscribe: (accept: OpeningAcceptor) => AdapterSubscription): Promise<void> {
  if (signal.aborted) return Promise.reject(new ProtocolFault('cancelled'));
  return new Promise((resolve, reject) => {
    let opened = false;
    let settled = false;
    let subscription: AdapterSubscription | undefined;
    const finished = (fault?: ProtocolFault): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', aborted);
      if (fault !== undefined) { subscription?.cancel(); reject(fault); } else resolve();
    };
    const aborted = (): void => finished(new ProtocolFault('cancelled'));
    const timer = setTimeout(() => finished(new ProtocolFault('timeout')), 15000);
    signal.addEventListener('abort', aborted, { once: true });
    try { subscription = subscribe({ opened: () => opened, ready: () => { opened = true; finished(); }, failed: fault => finished(fault) }); }
    catch (error) { finished(asFault(error)); }
    if (signal.aborted) aborted();
  });
}
