import type { AuthService } from '../auth/auth-service.js';
import type { ServerSession } from '../auth/server-session.js';
import type { AnswerInput, ConversationView, PendingInteraction, PetStatus, ReadConfirmation, SendTextInput, ServerRow, ServerScope, SessionContext, SessionRow, TaskProjection, WorkbenchSnapshot, WireEvent } from '../../shared/domain.js';
import { countTasks, preferenceKey, resultKey, sessionKey } from '../../shared/domain.js';
import { ProtocolFault, toPublicFailure } from '../../shared/faults.js';
import type { PublicFailure } from '../../shared/faults.js';
import { Preferences } from '../storage/preferences.js';
import { DirectoryStore } from './directory-store.js';
import { FocusRouter } from './focus-router.js';
import { projectTasks, SessionStateStore } from './session-state.js';
import { SessionCache } from '../sync/session-cache.js';
import { SessionReconciler } from '../sync/session-reconciler.js';
import { SyncScheduler } from '../sync/sync-scheduler.js';
import { DshWebAdapter } from '../protocol/dsh-web-adapter.js';
import { MockAdapter } from '../protocol/mock-adapter.js';
import { terminalFromEvent } from '../protocol/wire-values.js';
import type { AdapterCallbacks, AdapterSubscription, WorkbenchAdapter } from '../protocol/adapter.js';
import type { DiagnosticLogger } from '../logging/diagnostic-logger.js';

interface Binding { readonly adapter: WorkbenchAdapter; readonly scope: ServerScope; readonly signal: AbortSignal }
interface Foreground { readonly context: SessionContext; readonly controller: AbortController; subscription: AdapterSubscription | undefined }
interface SendLedger { readonly text: string; state: 'sending' | 'accepted' | 'uncertain' }
export interface PetPort {
  status(): PetStatus;
  publish(tasks: readonly TaskProjection[]): void;
  setEnabled(enabled: boolean): Promise<void>;
  dispose(): void;
}
export interface NotificationPort { consume(tasks: readonly TaskProjection[]): void; dispose(): void }

/** main 是目录、任务、缓存、路由和输入的唯一权威；renderer 不持有网络或认证接口。 */
export class WorkbenchService {
  readonly directory = new DirectoryStore();
  readonly state = new SessionStateStore();
  readonly focus = new FocusRouter(this.directory);
  readonly cache: SessionCache;
  private readonly reconciler: SessionReconciler;
  private readonly scheduler: SyncScheduler;
  private readonly bindings = new Map<string, Binding>();
  private readonly drafts = new Map<string, string>();
  private readonly pending = new Map<string, readonly PendingInteraction[]>();
  private readonly failures = new Map<string, PublicFailure>();
  private readonly sends = new Map<string, SendLedger>();
  private readonly initializedReads = new Set<string>();
  private readonly reconnects = new Map<string, { attempt: number; timer: ReturnType<typeof setTimeout> }>();
  private readonly connected = new Set<string>();
  private readonly suspendedDetails = new Set<string>();
  private readonly recoveryAttempts = new Map<string, number>();
  private lastInterval = 10;
  private readonly unsubscribed: () => void;
  private revision = 1;
  private lastSelection: SessionContext | null = null;
  private foreground: Foreground | undefined;
  private disposed = false;
  private demo = false;
  private demoGeneration = 0;
  private tasks: readonly TaskProjection[] = [];
  private pet: PetPort | undefined;
  private notifications: NotificationPort | undefined;
  private windowState: () => { visible: boolean; focused: boolean } = () => ({ visible: false, focused: false });

  constructor(private readonly auth: AuthService, readonly preferences: Preferences, private readonly logger?: DiagnosticLogger) {
    this.cache = new SessionCache(64 * 1024 * 1024, () => this.changed());
    this.reconciler = new SessionReconciler(this.cache, context => this.acceptCacheFacts(context));
    this.scheduler = new SyncScheduler(async (context, signal) => {
      const binding = this.binding(context);
      try { await this.reconciler.synchronize(context, binding.adapter, AbortSignal.any([signal, binding.signal])); }
      catch (error) { this.bodyFailed(context, error); throw error; }
    });
    this.unsubscribed = auth.subscribe(() => this.authChanged());
  }
  async initialize(): Promise<void> { await this.preferences.load(); this.scheduler.setIntervalSeconds(this.preferences.settings().syncIntervalSeconds); this.scheduler.start(); this.changed(); }
  setWindowState(read: () => { visible: boolean; focused: boolean }): void { this.windowState = read; }
  attachPet(pet: PetPort): void { this.pet = pet; this.changed(); }
  attachNotifications(notifications: NotificationPort): void { this.notifications = notifications; this.changed(); }
  preferencesChanged(): void {
    const interval = this.preferences.settings().syncIntervalSeconds;
    if (interval !== this.lastInterval) { this.lastInterval = interval; this.scheduler.setIntervalSeconds(interval); }
    void this.pet?.setEnabled(this.preferences.settings().petEnabled).catch(() => this.changed());
    this.changed();
  }

  createAdapter(session: ServerSession, generation: number, signal: AbortSignal, carrierFailed: (fault: ProtocolFault) => void): WorkbenchAdapter {
    const scope = { serverId: session.config.id, authProfileId: session.config.authProfileId, generation };
    this.beginScope(scope);
    const callbacks = this.callbacks(scope, fault => { carrierFailed(fault); this.handleFault(scope, fault); });
    const adapter = new DshWebAdapter(scope, session.businessTransport(signal), callbacks, signal);
    this.bindings.set(scope.serverId, { adapter, scope, signal });
    this.changed();
    return adapter;
  }

  snapshot(sinceRevision?: number): WorkbenchSnapshot | null {
    if (sinceRevision === this.revision) return null;
    const selected = this.selection();
    const snapshots = [...this.auth.list()];
    if (this.demo) snapshots.push({
      config: { id: 'demo', authProfileId: 'demo-profile', alias: '演示服务器（合成数据）', baseUrl: 'https://demo.invalid/' },
      generation: this.demoGeneration, state: 'readonly-ready', workspaces: [], sessions: [], failure: null, sample: null,
    });
    const servers: ServerRow[] = snapshots.map(server => {
      const sessions = this.directory.sessions(server.config.id).map(summary => this.row(server.config.id, server.config.authProfileId, summary.sessionId)).filter((row): row is SessionRow => row !== undefined);
      const taskSet = this.tasks.filter(task => task.serverId === server.config.id);
      const workspaces = this.directory.workspaces(server.config.id);
      const assigned = new Set(workspaces.flatMap(workspace => workspace.sessionIds));
      const tree = workspaces.map(workspace => ({ ...workspace,
        sessions: workspace.sessionIds.flatMap(id => { const session = sessions.find(session => session.sessionId === id); return session === undefined ? [] : [session]; }),
        counts: countTasks(taskSet.filter(task => workspace.sessionIds.includes(task.sessionId))),
      }));
      return { ...server, tree, unassigned: sessions.filter(session => !assigned.has(session.sessionId)), counts: countTasks(taskSet),
        protocolProfile: server.config.id === 'demo' ? 'synthetic' : '0.2.2-rc.3', deploymentVerified: false };
    });
    return {
      revision: this.revision, servers, tasks: this.tasks, counts: countTasks(this.tasks), selected,
      conversation: selected === null ? null : this.conversation(selected), settings: this.preferences.settings(),
      pet: this.pet?.status() ?? { state: 'disabled', ...this.preferences.petPaths(), message: '未启用本机宠物。' }, demo: this.demo,
    };
  }
  async connect(serverId: string): Promise<import('../../shared/contracts.js').ServerSnapshot> {
    this.clearReconnect(serverId); this.recoveryAttempts.delete(serverId);
    return this.auth.connect(serverId);
  }
  authenticate(serverId: string): void { this.clearReconnect(serverId); this.auth.authenticate(serverId); }
  disconnect(serverId: string): import('../../shared/contracts.js').ServerSnapshot {
    this.clearReconnect(serverId); this.connected.delete(serverId);
    this.pause(serverId, false);
    return this.auth.disconnect(serverId);
  }
  select(context: SessionContext): WorkbenchSnapshot {
    const selected = this.focus.select(context);
    this.lastSelection = selected;
    this.cache.protect(selected);
    this.stopForeground();
    this.reconciler.cancel(selected);
    this.updateTargets();
    // 不等待 HTTP/WS 再返回：命中缓存时先给 UI 本地正文，然后异步补齐。
    void this.startForeground(selected).catch(error => this.bodyFailed(selected, error));
    this.changed();
    return this.requireSnapshot();
  }
  selectedContext(): SessionContext | null { return this.selection(); }
  refreshPresentation(): void { this.changed(); }
  validateContext(context: SessionContext): void { this.focus.validate(context); }
  validateScope(serverId: string, authProfileId: string, generation: number): void {
    const current = this.auth.list().find(server => server.config.id === serverId);
    if (current === undefined || current.config.authProfileId !== authProfileId || current.generation !== generation) throw new ProtocolFault('cancelled');
  }
  taskSnapshot(): readonly TaskProjection[] { return this.tasks; }
  suspendServerDetails(serverId: string): void { this.suspendedDetails.add(serverId); this.scheduler.pauseServer(serverId); this.reconciler.cancelServer(serverId); if (this.foreground?.context.serverId === serverId) this.stopForeground(); }
  resumeServerDetails(serverId: string): void { if (this.disposed) return; this.suspendedDetails.delete(serverId); const context = this.focus.current(); if (context?.serverId === serverId) this.select(context); this.changed(); }
  async setFollowed(context: SessionContext, followed: boolean): Promise<void> {
    this.focus.validate(context);
    await this.preferences.updateSession(this.pref(context), value => ({ ...value, followed }));
    this.changed();
  }
  async setManualUnread(context: SessionContext, unread: boolean): Promise<void> {
    this.focus.validate(context);
    await this.preferences.updateSession(this.pref(context), value => ({ ...value, manualUnread: unread }));
    this.changed();
  }
  setDraft(context: SessionContext, text: string): void {
    if (typeof text !== 'string' || text.length > 65536 || !this.scopeCurrent(context)) throw new ProtocolFault('protocol');
    if (this.drafts.size >= 1000 && !this.drafts.has(this.pref(context))) throw new ProtocolFault('budget');
    this.drafts.set(this.pref(context), text);
    this.changed();
  }
  async send(input: SendTextInput): Promise<void> {
    this.assertSelected(input.context);
    const binding = this.binding(input.context);
    if (binding.adapter.source !== 'live') throw new ProtocolFault('unsupported');
    const id = JSON.stringify([this.pref(input.context), input.requestId]);
    const previous = this.sends.get(id);
    if (previous !== undefined) {
      if (previous.text !== input.text) throw new ProtocolFault('conflict');
      if (previous.state === 'accepted') return;
      throw new ProtocolFault('uncertain');
    }
    if (this.sends.size >= 1000) throw new ProtocolFault('budget');
    this.sends.set(id, { text: input.text, state: 'sending' }); this.changed();
    try {
      await binding.adapter.send(input, binding.signal);
      const entry = this.sends.get(id); if (entry !== undefined) entry.state = 'accepted';
      if (this.drafts.get(this.pref(input.context)) === input.text) this.drafts.set(this.pref(input.context), '');
      this.failures.delete(this.pref(input.context));
    } catch (error) {
      const entry = this.sends.get(id); if (entry !== undefined) entry.state = 'uncertain';
      this.bodyFailed(input.context, error);
      throw error;
    } finally { this.changed(); }
  }
  async stop(context: SessionContext): Promise<void> {
    this.assertSelected(context);
    const binding = this.binding(context);
    await binding.adapter.stop(context.sessionId, binding.signal);
  }
  async answer(input: AnswerInput): Promise<void> {
    this.assertSelected(input.context);
    const binding = this.binding(input.context);
    await binding.adapter.answer(input, binding.signal);
  }
  syncNow(context: SessionContext): void {
    this.focus.validate(context);
    if (this.selection() !== null && sameSession(this.selection() as SessionContext, context)) {
      void this.reconciler.synchronize(context, this.binding(context).adapter, this.binding(context).signal).catch(error => this.bodyFailed(context, error));
    } else this.scheduler.request(context);
  }
  async loadOlder(context: SessionContext): Promise<void> {
    this.focus.validate(context);
    const cached = this.cache.get(context);
    const before = cached?.events[0]?.seq;
    if (cached === undefined || before === undefined || before === 0 || !cached.hasMore) return;
    const binding = this.binding(context);
    const page = await binding.adapter.history(context.sessionId, before, cached.cursor, binding.signal);
    if (!this.scopeCurrent(context)) throw new ProtocolFault('cancelled');
    this.cache.applyPage(context, page);
  }
  async confirmRead(input: ReadConfirmation): Promise<void> {
    if (!input.visible || !input.focused) return;
    const window = this.windowState();
    if (!window.visible || !window.focused) return;
    this.assertSelected(input.context);
    const cached = this.cache.get(input.context);
    if (cached === undefined || cached.hasGap || input.throughSeq > cached.cursor || input.throughSeq < 0) return;
    const facts = this.state.get(input.context.serverId, input.context.sessionId);
    const result = facts?.terminal;
    await this.preferences.updateSession(this.pref(input.context), value => ({
      ...value, readSeq: Math.max(value.readSeq, input.throughSeq), manualUnread: false,
      acknowledgedResult: result !== null && result !== undefined && result.seq <= input.throughSeq ? resultKey(result) : value.acknowledgedResult,
    }));
    this.changed();
  }
  async clearResult(serverId: string, sessionId: string, resultId: string): Promise<void> {
    const context = this.focus.resolve(serverId, sessionId);
    const facts = this.state.get(serverId, sessionId);
    if (context === undefined || facts?.terminal === null || facts?.terminal === undefined || resultKey(facts.terminal) !== resultId || facts.running) throw new ProtocolFault('cancelled');
    await this.preferences.updateSession(this.pref(context), value => ({ ...value, acknowledgedResult: resultId }));
    this.changed();
  }
  jump(serverId: string, sessionId: string): void {
    const context = this.focus.resolve(serverId, sessionId);
    if (context === undefined) throw new ProtocolFault('not-found');
    this.select(context);
  }
  async setDemo(enabled: boolean): Promise<void> {
    if (enabled === this.demo) return;
    this.demo = enabled;
    if (enabled) {
      const scope = { serverId: 'demo', authProfileId: 'demo-profile', generation: ++this.demoGeneration };
      this.beginScope(scope);
      const controller = new AbortController();
      const adapter = new MockAdapter(scope, this.callbacks(scope, fault => this.handleFault(scope, fault)));
      this.bindings.set(scope.serverId, { adapter, scope, signal: controller.signal });
      await adapter.connect();
    } else {
      this.bindings.get('demo')?.adapter.dispose(); this.bindings.delete('demo');
      this.directory.revoke('demo'); this.state.clear('demo'); this.cache.revoke('demo'); this.pending.delete('demo');
      if (this.lastSelection?.serverId === 'demo') { this.stopForeground(); this.lastSelection = null; this.focus.clear('demo'); }
    }
    this.changed();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.unsubscribed(); this.stopForeground();
    this.scheduler.dispose(); this.reconciler.dispose(); this.pet?.dispose(); this.notifications?.dispose();
    for (const binding of this.bindings.values()) binding.adapter.dispose();
    for (const id of this.reconnects.keys()) this.clearReconnect(id);
    this.bindings.clear(); this.cache.clear(); this.drafts.clear(); this.pending.clear(); this.sends.clear();
  }

  private beginScope(scope: ServerScope): void {
    this.scheduler.pauseServer(scope.serverId); this.reconciler.cancelServer(scope.serverId);
    this.directory.begin(scope); this.state.beginScope(scope); this.pending.delete(scope.serverId); this.cache.markStale(scope.serverId);
  }
  private callbacks(scope: ServerScope, failed: (fault: ProtocolFault) => void): AdapterCallbacks {
    return {
      workspaces: frame => {
        if (!this.scopeCurrent(scope)) return;
        this.directory.applyWorkspaces(scope, frame);
        for (const facts of this.state.all()) if (facts.serverId === scope.serverId && this.directory.session(scope.serverId, facts.sessionId) === undefined) {
          this.state.revoke(scope, facts.sessionId); this.cache.remove({ ...scope, sessionId: facts.sessionId, workspaceId: null });
        }
        for (const session of this.directory.sessions(scope.serverId)) this.state.setArchived(scope, session.sessionId, this.directory.archived(scope.serverId, session.sessionId));
        this.changed();
      },
      sessions: sessions => {
        if (!this.scopeCurrent(scope)) return;
        this.directory.replaceSessions(scope, sessions);
        for (const session of sessions) this.state.upsert(scope, session);
        for (const facts of this.state.all()) if (facts.serverId === scope.serverId && this.directory.session(scope.serverId, facts.sessionId) === undefined) this.state.revoke(scope, facts.sessionId);
        this.changed();
      },
      removed: sessionId => {
        if (!this.scopeCurrent(scope)) return;
        this.directory.removeSession(scope, sessionId); this.state.revoke(scope, sessionId);
        const context = { ...scope, workspaceId: null, sessionId };
        this.reconciler.cancel(context); this.cache.remove(context);
        this.failures.set(this.pref(context), toPublicFailure(new ProtocolFault('not-found')));
        if (this.foreground?.context.sessionId === sessionId && this.foreground.context.serverId === scope.serverId) this.stopForeground();
        this.changed();
      },
      running: (sessionId, running) => {
        if (!this.scopeCurrent(scope)) return;
        this.state.setRunning(scope, sessionId, running); this.changed();
      },
      state: (sessionId, state) => {
        if (!this.scopeCurrent(scope)) return;
        const pending = this.pending.get(scope.serverId)?.filter(item => item.sessionId === sessionId).map(item => item.id) ?? [];
        this.state.setState(scope, sessionId, { cursor: state.cursor, active: state.active, running: state.running,
          pendingIds: pending.length > 0 ? pending : state.pendingInput.map((kind, index) => `state:${kind}:${index}`) });
        this.primeRead(scope, sessionId, state.cursor); this.changed();
      },
      pending: pending => {
        if (!this.scopeCurrent(scope)) return;
        this.pending.set(scope.serverId, pending);
        for (const session of this.directory.sessions(scope.serverId)) this.state.setPending(scope, session.sessionId, pending.filter(item => item.sessionId === session.sessionId).map(item => item.id));
        this.changed();
      },
      event: (sessionId, event, live) => this.acceptEvent({ ...scope, workspaceId: null, sessionId }, event, live),
      failed,
    };
  }
  private async startForeground(context: SessionContext): Promise<void> {
    const binding = this.binding(context);
    const controller = new AbortController();
    const foreground: Foreground = { context, controller, subscription: undefined };
    this.foreground = foreground;
    const signal = AbortSignal.any([controller.signal, binding.signal]);
    const subscription = await binding.adapter.follow(context.sessionId, {
      snapshot: snapshot => {
        if (signal.aborted || !this.scopeCurrent(context)) return;
        this.cache.applySnapshot(context, snapshot);
        this.failures.delete(this.pref(context));
        this.acceptCacheFacts(context);
        void this.reconciler.repair(context, binding.adapter, signal).catch(error => this.bodyFailed(context, error));
      },
      event: event => {
        if (signal.aborted || !this.scopeCurrent(context)) return;
        this.cache.applyEvent(context, event); this.acceptEvent(context, event, true);
        if (this.cache.get(context)?.hasGap) void this.reconciler.repair(context, binding.adapter, signal).catch(error => this.bodyFailed(context, error));
      },
      assistant: frame => { if (!signal.aborted && this.scopeCurrent(context)) this.cache.applyAssistant(context, frame); },
      failed: error => this.bodyFailed(context, error),
    }, signal);
    if (signal.aborted || this.foreground !== foreground) subscription.cancel(); else foreground.subscription = subscription;
  }
  private stopForeground(): void { this.foreground?.controller.abort(); this.foreground?.subscription?.cancel(); this.foreground = undefined; }
  private acceptCacheFacts(context: SessionContext): void {
    if (!this.scopeCurrent(context)) return;
    const cached = this.cache.get(context); if (cached === undefined) return;
    const facts = this.state.get(context.serverId, context.sessionId);
    const baseline = facts?.baselineCursor;
    this.state.primeCursor(context, context.sessionId, cached.cursor);
    const latestStart = [...cached.events].reverse().find(event => event.type === 'turn/start');
    const latestEnd = [...cached.events].reverse().find(event => event.type === 'turn/end');
    if (latestStart !== undefined && (latestEnd === undefined || latestStart.seq > latestEnd.seq)) this.state.setRunning(context, context.sessionId, true);
    else if (latestEnd !== undefined && (!facts?.running || latestEnd.seq > (baseline ?? cached.cursor))) {
      this.acceptEvent(context, latestEnd, baseline !== null && baseline !== undefined && latestEnd.seq > baseline);
    }
    this.primeRead(context, context.sessionId, cached.cursor);
    this.changed();
  }
  private acceptEvent(context: SessionContext, event: WireEvent, live: boolean): void {
    if (!this.scopeCurrent(context)) return;
    const terminal = terminalFromEvent(event);
    if (terminal !== null) this.state.terminal(context, context.sessionId, terminal, live);
    this.changed();
  }
  private primeRead(scope: ServerScope, sessionId: string, cursor: number): void {
    const key = preferenceKey(scope.serverId, scope.authProfileId, sessionId);
    if (this.initializedReads.has(key)) return;
    this.initializedReads.add(key);
    void this.preferences.primeRead(key, cursor).then(() => this.changed(), () => { this.initializedReads.delete(key); });
  }
  private handleFault(scope: ServerScope, fault: ProtocolFault): void {
    const current = this.directory.scope(scope.serverId);
    if (current !== undefined && (current.authProfileId !== scope.authProfileId || current.generation !== scope.generation)) return;
    if (fault.kind !== 'cancelled') this.logger?.fault('carrier-failed', fault, { serverId: scope.serverId, generation: scope.generation });
    this.pause(scope.serverId, ['auth-required', 'forbidden', 'login-response'].includes(fault.kind));
    this.changed();
  }
  private pause(serverId: string, revoke: boolean): void {
    this.scheduler.pauseServer(serverId); this.reconciler.cancelServer(serverId);
    if (this.foreground?.context.serverId === serverId) this.stopForeground();
    if (revoke) {
      this.cache.revoke(serverId); this.directory.revoke(serverId); this.state.clear(serverId); this.pending.delete(serverId);
      if (this.lastSelection?.serverId === serverId) this.lastSelection = null;
      for (const key of this.drafts.keys()) if (JSON.parse(key)[0] === serverId) this.drafts.delete(key);
    } else { this.cache.markStale(serverId); this.directory.markStale(serverId); this.state.markStale(serverId); }
  }
  private authChanged(): void {
    if (this.disposed) return;
    for (const server of this.auth.list()) {
      const oldScope = this.directory.scope(server.config.id);
      if (oldScope !== undefined && oldScope.authProfileId !== server.config.authProfileId) this.pause(server.config.id, true);
      if (server.state === 'readonly-ready') {
        this.connected.add(server.config.id); this.clearReconnect(server.config.id); this.recoveryAttempts.delete(server.config.id);
        if (this.lastSelection?.serverId === server.config.id && this.lastSelection.authProfileId === server.config.authProfileId) {
          const resolved = this.focus.resolve(server.config.id, this.lastSelection.sessionId);
          if (resolved !== undefined && (this.foreground === undefined || !sameSession(this.foreground.context, resolved))) this.select(resolved);
        }
      } else if (server.state === 'authenticating') this.pause(server.config.id, false);
      else if (['auth-required', 'denied'].includes(server.state)) this.pause(server.config.id, true);
      else if (server.state === 'failed' || server.state === 'incompatible') {
        this.pause(server.config.id, false);
        if (server.failure?.kind === 'network' && this.connected.has(server.config.id)) this.scheduleReconnect(server.config.id);
      }
    }
    this.changed();
  }
  private scheduleReconnect(serverId: string): void {
    if (this.reconnects.has(serverId)) return;
    const attempt = (this.recoveryAttempts.get(serverId) ?? 0) + 1;
    if (attempt > 5) return;
    this.recoveryAttempts.set(serverId, attempt);
    const timer = setTimeout(() => {
      this.reconnects.delete(serverId);
      if (!this.disposed) void this.auth.connect(serverId, false).catch(() => {});
    }, Math.min(30000, 1000 * 2 ** attempt));
    this.reconnects.set(serverId, { attempt, timer });
  }
  private clearReconnect(serverId: string): void { const reconnect = this.reconnects.get(serverId); if (reconnect !== undefined) clearTimeout(reconnect.timer); this.reconnects.delete(serverId); }
  private bodyFailed(context: SessionContext, error: unknown): void {
    if (!this.scopeCurrent(context)) return;
    const failure = toPublicFailure(error);
    if (failure.kind !== 'cancelled') this.logger?.fault('read-failed', error, { serverId: context.serverId, generation: context.generation });
    this.failures.set(this.pref(context), failure);
    if (['forbidden', 'auth-required', 'login-response'].includes(failure.kind)) {
      this.directory.removeSession(context, context.sessionId); this.state.revoke(context, context.sessionId);
      this.reconciler.cancel(context); this.cache.remove(context);
      if (this.foreground !== undefined && sameSession(this.foreground.context, context)) this.stopForeground();
    } else this.cache.setFailure(context, error);
    this.changed();
  }
  private binding(context: ServerScope): Binding {
    const binding = this.bindings.get(context.serverId);
    if (binding === undefined || binding.signal.aborted || binding.scope.authProfileId !== context.authProfileId || binding.scope.generation !== context.generation) throw new ProtocolFault('auth-required');
    return binding;
  }
  private scopeCurrent(scope: ServerScope): boolean {
    const current = this.directory.scope(scope.serverId);
    return current?.authProfileId === scope.authProfileId && current.generation === scope.generation;
  }
  private selection(): SessionContext | null {
    const selected = this.focus.current();
    if (selected !== null) this.lastSelection = selected;
    return this.lastSelection === null ? null : { ...this.lastSelection };
  }
  private assertSelected(context: SessionContext): void {
    this.focus.validate(context);
    const current = this.selection();
    if (current === null || !sameSession(current, context)) throw new ProtocolFault('cancelled');
  }
  private row(serverId: string, authProfileId: string, sessionId: string): SessionRow | undefined {
    const summary = this.directory.session(serverId, sessionId);
    if (summary === undefined) return undefined;
    const facts = this.state.get(serverId, sessionId);
    const preference = this.preferences.session(preferenceKey(serverId, authProfileId, sessionId));
    const task = this.tasks.find(task => task.serverId === serverId && task.sessionId === sessionId);
    return { ...summary, title: facts?.title ?? summary.title ?? sessionId,
      followed: preference.followed, unread: preference.manualUnread || (facts?.baselineCursor !== null && (facts?.cursor ?? -1) > preference.readSeq),
      archived: this.directory.archived(serverId, sessionId), running: facts?.running ?? summary.running,
      pendingCount: facts?.pendingIds.length ?? 0, task: task?.color ?? null, freshness: facts?.freshness ?? 'stale' };
  }
  private conversation(context: SessionContext): ConversationView {
    const cachedEntry = this.cache.get(context);
    const server = this.auth.list().find(server => server.config.id === context.serverId);
    const locked = server !== undefined && (server.state === 'authenticating' || server.state === 'auth-required' || server.state === 'denied'
      || server.config.authProfileId !== context.authProfileId);
    const cached = locked ? undefined : cachedEntry;
    const binding = this.bindings.get(context.serverId);
    const connected = binding !== undefined && !binding.signal.aborted && this.directory.ready(context.serverId);
    const failure = this.failures.get(this.pref(context)) ?? cached?.failure ?? null;
    const ledgers = [...this.sends.entries()].filter(([key]) => JSON.parse(key)[0] === this.pref(context));
    const last = ledgers[ledgers.length - 1]?.[1];
    return {
      context, title: this.state.get(context.serverId, context.sessionId)?.title ?? context.sessionId,
      status: cached === undefined ? failure === null ? 'loading' : 'error' : cached.hasGap ? 'gap' : !connected || cached.freshness === 'stale' ? 'stale' : this.foreground !== undefined && sameSession(this.foreground.context, context) ? 'live' : 'cached',
      events: cached?.events ?? [], assistant: cached?.assistant ?? { revision: 0, activeAttempt: null }, cursor: cached?.cursor ?? -1,
      hasMore: cached?.hasMore ?? false, hasGap: cached?.hasGap ?? false, syncedAt: cached?.syncedAt ?? null,
      syncing: cached?.syncing ?? (cached === undefined && failure === null), draft: this.drafts.get(this.pref(context)) ?? '', failure,
      pending: this.pending.get(context.serverId)?.filter(item => item.sessionId === context.sessionId) ?? [], sendState: last?.state ?? 'idle',
    };
  }
  private updateTargets(): void {
    const targets = this.state.all().flatMap(facts => {
      const context = this.directory.resolve(facts.serverId, facts.sessionId);
      return context === undefined || !facts.accessible || this.suspendedDetails.has(facts.serverId) ? [] : [{ context, running: facts.running, pending: facts.pendingIds.length > 0 }];
    });
    this.scheduler.update(targets, this.selection());
  }
  private changed(): void {
    if (this.disposed) return;
    this.revision++;
    this.tasks = projectTasks(this.state.all(), key => this.preferences.session(key));
    this.updateTargets();
    const liveTasks = this.tasks.filter(task => this.bindings.get(task.serverId)?.adapter.source === 'live');
    this.notifications?.consume(liveTasks); this.pet?.publish(liveTasks);
  }
  private pref(context: SessionContext): string { return preferenceKey(context.serverId, context.authProfileId, context.sessionId); }
  private requireSnapshot(): WorkbenchSnapshot { return this.snapshot() as WorkbenchSnapshot; }
}
function sameSession(left: SessionContext, right: SessionContext): boolean { return sessionKey(left.serverId, left.sessionId) === sessionKey(right.serverId, right.sessionId) && left.authProfileId === right.authProfileId && left.generation === right.generation; }
