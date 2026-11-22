import type { AuthService } from '../auth/auth-service.js';
import type { ServerSession } from '../auth/server-session.js';
import type { ServerConfig } from '../../shared/contracts.js';
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
import { ReadAdmission } from '../sync/read-admission.js';
import { DshWebAdapter } from '../protocol/dsh-web-adapter.js';
import { MockAdapter } from '../protocol/mock-adapter.js';
import { terminalFromEvent } from '../protocol/wire-values.js';
import type { AdapterCallbacks, AdapterSubscription, WorkbenchAdapter } from '../protocol/adapter.js';
import type { DiagnosticLogger } from '../logging/diagnostic-logger.js';
import type { AppearanceView } from '../../shared/appearance.js';
import type { SessionWebState } from '../../shared/session-web.js';
import type { ModelCatalog, ModelSelection, SelectModelInput, GoalActionInput, CommandDescriptor, CommandExecution } from '../../shared/native-controls.js';
import { NativeActionLedger, NativeActionNotSent } from './native-action-ledger.js';
import { FileShareReader } from '../files/file-share-reader.js';
import type { FileDirectory, FilePathRead, FilePreview, FileReadScope, FileWorkspace } from '../../shared/files.js';
import { connectionIdentity, localConnectionDay } from '../storage/connection-intents.js';
import type { ConnectionIntentStore } from '../storage/connection-intents.js';
import { recoveryDelayMs } from '../../shared/recovery.js';
import type { RecoveryView } from '../../shared/recovery.js';
import type { JobPanelSnapshot, JobReadScope, JobViewRead } from '../../shared/jobs.js';
import { BackgroundJobsReader } from '../jobs/background-jobs-reader.js';

interface Binding { readonly adapter: WorkbenchAdapter; readonly scope: ServerScope; readonly signal: AbortSignal; readonly files?: FileShareReader }
interface FileViewBinding { readonly context: SessionContext; readonly controller: AbortController }
interface Foreground { readonly context: SessionContext; readonly controller: AbortController; readonly startedAt: number; subscription: AdapterSubscription | undefined; openingTimer: ReturnType<typeof setTimeout> | undefined }
interface ForegroundRecovery { readonly context: SessionContext; view: RecoveryView; timer: ReturnType<typeof setTimeout> | undefined }
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
  private readonly jobs: BackgroundJobsReader;
  private readonly admission = new ReadAdmission();
  private readonly bindings = new Map<string, Binding>();
  private readonly drafts = new Map<string, string>();
  private readonly pending = new Map<string, readonly PendingInteraction[]>();
  private readonly failures = new Map<string, PublicFailure>();
  private readonly sends = new Map<string, SendLedger>();
  private readonly nativeActions = new NativeActionLedger();
  private readonly fileViews = new Map<string, FileViewBinding>();
  private readonly releasedFileViews = new Set<string>();
  private readonly initializedReads = new Set<string>();
  private readonly reconnects = new Map<string, { attempt: number; timer: ReturnType<typeof setTimeout> }>();
  private readonly connected = new Map<string, { readonly authProfileId: string; readonly generation: number | null }>();
  private readonly wantedConnections = new Map<string, string>();
  private readonly manualConnectionDays = new Map<string, { readonly identity: string; readonly day: string }>();
  private readonly serverRecoveries = new Map<string, RecoveryView>();
  private foregroundRecovery: ForegroundRecovery | undefined;
  private foregroundAttempts = 0;
  private foregroundRecoveryStartedAt: number | undefined;
  private connectionsRestored = false;
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
  private appearance: { view(): AppearanceView } | undefined;
  private web: { status(): SessionWebState } | undefined;
  private webOwner: { readonly scope: ServerScope; readonly sessionId: string | null } | null = null;

  constructor(private readonly auth: AuthService, readonly preferences: Preferences, private readonly logger?: DiagnosticLogger, private readonly intents?: ConnectionIntentStore) {
    this.cache = new SessionCache(64 * 1024 * 1024, () => this.changed());
    this.reconciler = new SessionReconciler(this.cache, context => this.acceptCacheFacts(context));
    this.scheduler = new SyncScheduler(async (context, signal) => {
      const binding = this.binding(context);
      try { await this.reconciler.synchronize(context, binding.adapter, AbortSignal.any([signal, binding.signal])); }
      catch (error) { if (!signal.aborted && !binding.signal.aborted) this.bodyFailed(context, error, undefined, 'background'); throw error; }
    }, Date.now, context => this.admission.allow(context, 'background'));
    this.jobs = new BackgroundJobsReader(context => this.jobBinding(context), (context, endpoint, error) => {
      this.logger?.fault('read-failed', error, { serverId: context.serverId, generation: context.generation, endpoint, streamPurpose: 'jobs' });
    }, Date.now, context => this.admission.allow(context, 'jobs'));
    this.unsubscribed = auth.subscribe(() => this.authChanged());
  }
  async initialize(): Promise<void> { await this.preferences.load(); this.scheduler.setIntervalSeconds(this.preferences.settings().syncIntervalSeconds); this.scheduler.start(); this.changed(); }
  /** 每日首次不联网；只有同日本机已验证且未手动断开的身份才能启动恢复。 */
  resumeConnections(): void {
    if (this.connectionsRestored || this.disposed || this.intents === undefined) return;
    this.connectionsRestored = true;
    const servers = this.auth.list(); void this.intents.keepServers(servers.map(server => server.config)).catch(() => {});
    for (const server of servers) {
      if (server.state !== 'idle' || !this.intents.shouldResume(server.config)) continue;
      this.wantConnection(server.config.id); this.connected.set(server.config.id, { authProfileId: server.config.authProfileId, generation: null });
      this.recoveryAttempts.set(server.config.id, 1); this.setServerRecovery(server.config.id, { phase: 'connecting', attempt: 1, limit: null, retryAt: null });
      void this.auth.connect(server.config.id, false).catch(error => this.failedReconnectAttempt(server.config.id, 1, error));
    }
    this.changed();
  }
  setWindowState(read: () => { visible: boolean; focused: boolean }): void { this.windowState = read; }
  attachAppearance(port: { view(): AppearanceView }): void { this.appearance = port; this.changed(); }
  appearanceView(): AppearanceView | undefined { return this.appearance?.view(); }
  attachWeb(port: { status(): SessionWebState }): void { this.web = port; this.changed(); }
  hasNativePending(serverId: string, sessionId: string | null): boolean { return this.pending.get(serverId)?.some(pending => sessionId === null || pending.sessionId === sessionId) ?? false; }
  enterWeb(scope: ServerScope, sessionId: string | null): void {
    if (this.hasNativePending(scope.serverId, sessionId)) throw new ProtocolFault('conflict');
    const binding = this.bindings.get(scope.serverId);
    if (binding !== undefined && !binding.signal.aborted && binding.scope.authProfileId === scope.authProfileId && binding.scope.generation === scope.generation) binding.adapter.setWebOwner?.({ sessionId });
    this.webOwner = { scope: { ...scope }, sessionId }; this.admission.clear(scope.serverId);
    if (this.foregroundRecovery !== undefined && this.currentIsWebOwned(this.foregroundRecovery.context)) this.clearForegroundRecovery();
    if (this.foreground?.context.serverId === scope.serverId && (sessionId === null || this.foreground.context.sessionId === sessionId)) this.stopForeground();
    this.changed();
  }
  leaveWeb(scope: ServerScope): void {
    const owner = this.webOwner;
    if (owner === null || owner.scope.serverId !== scope.serverId || owner.scope.authProfileId !== scope.authProfileId || owner.scope.generation !== scope.generation) return;
    this.webOwner = null;
    const binding = this.bindings.get(scope.serverId);
    if (binding?.scope.authProfileId === scope.authProfileId && binding.scope.generation === scope.generation && !binding.signal.aborted) binding.adapter.setWebOwner?.(null);
    if (this.disposed) return;
    const context = this.focus.current();
    if (context !== null && this.foreground === undefined) void this.startForeground(context).catch(error => this.bodyFailed(context, error));
    this.changed();
  }
  clearSelection(): void { this.jobs.clearView(); this.cancelFileViews(); this.clearForegroundRecovery(); this.stopForeground(); this.focus.clear(); this.lastSelection = null; this.cache.protect(null); this.changed(); }
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
    const adapter = new DshWebAdapter(scope, session.businessTransport(signal, generation), callbacks, signal);
    const files = new FileShareReader((request, active) => session.readFileShare(request, active), signal);
    this.bindings.set(scope.serverId, { adapter, scope, signal, files });
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
      const recovery = this.serverRecoveries.get(server.config.id);
      return { ...server, tree, unassigned: sessions.filter(session => !assigned.has(session.sessionId)), counts: countTasks(taskSet),
        directoryReady: server.state === 'readonly-ready' && this.directory.ready(server.config.id), ...(recovery === undefined ? {} : { recovery: { ...recovery } }),
        protocolProfile: server.config.id === 'demo' ? 'synthetic' : '0.2.2-rc.3', deploymentVerified: false };
    });
    return {
      revision: this.revision, servers, tasks: this.tasks, counts: countTasks(this.tasks), selected,
      conversation: selected === null ? null : this.conversation(selected), settings: this.preferences.settings(),
      pet: this.pet?.status() ?? { state: 'disabled', ...this.preferences.petPaths(), display: this.preferences.petDisplay(), message: '未启用本机宠物。' }, demo: this.demo,
      ...(this.appearance === undefined ? {} : { appearance: this.appearance.view() }), ...(this.web === undefined ? {} : { web: this.web.status() }),
    };
  }
  async connect(serverId: string): Promise<import('../../shared/contracts.js').ServerSnapshot> {
    const config = this.wantConnection(serverId, localConnectionDay());
    this.clearReconnect(serverId); this.recoveryAttempts.delete(serverId);
    if (this.connected.get(serverId)?.authProfileId === config.authProfileId) this.setServerRecovery(serverId, { phase: 'connecting', attempt: 1, limit: null, retryAt: null });
    return this.auth.connect(serverId);
  }
  authenticate(serverId: string): void { this.wantConnection(serverId, localConnectionDay()); this.clearReconnect(serverId); this.auth.authenticate(serverId); }
  async disconnect(serverId: string): Promise<import('../../shared/contracts.js').ServerSnapshot> {
    const config = this.auth.list().find(server => server.config.id === serverId)?.config;
    if (config === undefined) throw new ProtocolFault('not-found');
    this.wantedConnections.delete(serverId); this.manualConnectionDays.delete(serverId); this.recoveryAttempts.delete(serverId);
    this.clearReconnect(serverId); this.connected.delete(serverId);
    const saved = this.intents?.disconnect(config);
    this.pause(serverId, false); const snapshot = this.auth.disconnect(serverId);
    try { await saved; } catch { throw new ProtocolFault('local-state'); }
    return snapshot;
  }
  select(context: SessionContext): WorkbenchSnapshot {
    this.validateContext(context);
    const previous = this.selection();
    const selected = this.focus.select(context);
    if (previous === null || !sameSession(previous, selected)) { this.cancelFileViews(); this.jobs.clearView(); }
    this.lastSelection = selected;
    this.cache.protect(selected);
    this.clearForegroundRecovery(); this.stopForeground();
    this.reconciler.cancel(selected);
    this.updateTargets();
    // 不等待 HTTP/WS 再返回：命中缓存时先给 UI 本地正文，然后异步补齐。
    if (!this.currentIsWebOwned(selected)) void this.startForeground(selected).catch(error => this.bodyFailed(selected, error));
    this.changed();
    return this.requireSnapshot();
  }
  selectedContext(): SessionContext | null { return this.selection(); }
  refreshPresentation(): void { this.changed(); }
  validateContext(context: SessionContext): void {
    if (context.serverId !== 'demo' || !this.demo) this.validateScope(context.serverId, context.authProfileId, context.generation);
    this.focus.validate(context);
  }
  validateScope(serverId: string, authProfileId: string, generation: number): void {
    const current = this.auth.list().find(server => server.config.id === serverId);
    if (current === undefined || current.config.authProfileId !== authProfileId || current.generation !== generation
      || current.state !== 'readonly-ready' || current.authenticationOpen) throw new ProtocolFault('cancelled');
  }
  taskSnapshot(): readonly TaskProjection[] { return this.tasks; }
  suspendServerDetails(serverId: string): void { this.cancelFileViews(serverId); if (this.foregroundRecovery?.context.serverId === serverId) this.clearForegroundRecovery(); this.suspendedDetails.add(serverId); this.scheduler.pauseServer(serverId); this.reconciler.cancelServer(serverId); if (this.foreground?.context.serverId === serverId) this.stopForeground(); }
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
    if (this.currentIsWebOwned(input.context)) throw new ProtocolFault('conflict');
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
  async modelCatalog(context: SessionContext, refresh = false): Promise<ModelCatalog> {
    const binding = this.nativeBinding(context);
    if (binding.adapter.modelCatalog === undefined) throw new ProtocolFault('unsupported');
    try { const value = await binding.adapter.modelCatalog(binding.signal, refresh); this.nativeBinding(context); return value; }
    catch (error) { this.nativeFailed(context, error, 'session/modelCatalog'); throw error; }
  }
  async commandCatalog(context: SessionContext, refresh = false): Promise<readonly CommandDescriptor[]> {
    const binding = this.nativeBinding(context);
    if (binding.adapter.commands === undefined) throw new ProtocolFault('unsupported');
    try { const value = await binding.adapter.commands(context.sessionId, this.nativeSignal(context, binding), refresh); this.nativeBinding(context); return value; }
    catch (error) { this.nativeFailed(context, error, 'commands/list'); throw error; }
  }
  async selectModel(input: SelectModelInput): Promise<ModelSelection> {
    const initial = this.nativeBinding(input.context); const signal = this.nativeSignal(input.context, initial);
    try {
      return await this.nativeActions.run(input.context, input.requestId, JSON.stringify(['model', input.selection]), async () => {
        const prepared = await this.prepareNative(async () => {
          this.assertNativeAction(input.context, signal);
          const binding = this.nativeBinding(input.context); const select = binding.adapter.selectModel;
          if (binding.adapter.modelCatalog === undefined || select === undefined) throw new ProtocolFault('unsupported');
          const catalog = await binding.adapter.modelCatalog(binding.signal); this.nativeBinding(input.context);
          const group = catalog.groups.find(group => group.id === input.selection.provider);
          const model = group?.models.find(model => model.id === input.selection.model);
          if (model === undefined || !catalog.routableProviders.includes(input.selection.provider)
            || input.selection.reasoningEffort !== undefined && !model.reasoning?.efforts.some(effort => effort.id === input.selection.reasoningEffort)) throw new ProtocolFault('unsupported');
          return { binding, select };
        });
        this.assertNativeAction(input.context, signal);
        const selected = await prepared.select.call(prepared.binding.adapter, input, signal); this.changed(); return selected;
      });
    } catch (error) { this.nativeFailed(input.context, error, 'session/selectModel'); throw error; }
  }
  async goalAction(input: GoalActionInput, confirmClear: () => Promise<boolean> = async () => false): Promise<void> {
    const initial = this.nativeBinding(input.context); const signal = this.nativeSignal(input.context, initial);
    try {
      await this.nativeActions.run(input.context, input.requestId, JSON.stringify(['goal', input.action]), async () => {
        const prepared = await this.prepareNative(async () => {
          const validate = () => {
            this.assertNativeAction(input.context, signal);
            const binding = this.nativeBinding(input.context); const goal = this.cache.get(input.context)?.native.values.goal; const change = binding.adapter.goalAction;
            if (goal === undefined || change === undefined) throw new ProtocolFault('unsupported');
            if (input.action.kind === 'create') { if (goal !== null) throw new ProtocolFault('conflict'); }
            else if (goal === null || goal.goal.id !== input.action.ref.id || goal.goal.revision !== input.action.ref.revision) throw new ProtocolFault('conflict');
            return { binding, change };
          };
          validate(); if (input.action.kind === 'clear' && !await confirmClear()) throw new NativeActionNotSent();
          return validate();
        });
        this.assertNativeAction(input.context, signal);
        await prepared.change.call(prepared.binding.adapter, input, signal); this.changed();
      });
    } catch (error) { this.nativeFailed(input.context, error, input.action.kind === 'create' ? 'goals/create' : input.action.kind === 'edit' ? 'goals/edit' : input.action.kind === 'pause' ? 'goals/pause' : input.action.kind === 'resume' ? 'goals/resume' : 'goals/clear'); throw error; }
  }
  async executeCommand(input: SendTextInput, confirm: (name: string) => Promise<boolean>): Promise<CommandExecution> {
    const initial = this.nativeBinding(input.context); const signal = this.nativeSignal(input.context, initial);
    try {
      return await this.nativeActions.run(input.context, input.requestId, JSON.stringify(['command', input.text]), async () => {
        const prepared = await this.prepareNative(async () => {
          this.assertNativeAction(input.context, signal);
          const binding = this.nativeBinding(input.context); const execute = binding.adapter.executeCommand;
          if (binding.adapter.commands === undefined || execute === undefined) throw new ProtocolFault('unsupported');
          const name = /^\/([^\s/]+)/u.exec(input.text.trim())?.[1];
          const command = (await binding.adapter.commands(input.context.sessionId, signal, true)).find(command => command.name === name);
          if (name === undefined || command === undefined || input.text.trim().slice(name.length + 1).trim() !== '' && command.input === undefined) throw new ProtocolFault('unsupported');
          this.assertNativeAction(input.context, signal);
          if (!await confirm(name)) throw new NativeActionNotSent();
          this.nativeBinding(input.context); return { binding, execute };
        });
        this.assertNativeAction(input.context, signal);
        const execution = await prepared.execute.call(prepared.binding.adapter, input, signal);
        if (execution.result.kind === 'success' && this.drafts.get(this.pref(input.context)) === input.text) this.drafts.set(this.pref(input.context), '');
        this.changed(); return execution;
      });
    } catch (error) { this.nativeFailed(input.context, error, 'commands/execute'); throw error; }
  }
  jobView(input: JobViewRead): JobPanelSnapshot | null { return this.jobs.read(input); }
  releaseJobs(input: JobReadScope): void { this.jobs.release(input); }
  fileWorkspace(input: FileReadScope): Promise<FileWorkspace> { return this.fileRead(input, (files, signal) => files.workspace(input.context.sessionId, signal), 'dsh-file-share/status'); }
  fileDirectory(input: FilePathRead): Promise<FileDirectory> { return this.fileRead(input, (files, signal) => files.directory(input.context.sessionId, input.path, signal), 'dsh-file-share/list'); }
  filePreview(input: FilePathRead): Promise<FilePreview> { return this.fileRead(input, (files, signal) => files.preview(input.context.sessionId, input.path, signal), 'dsh-file-share/preview'); }
  releaseFiles(input: FileReadScope): void {
    const key = this.fileViewKey(input); this.fileViews.get(key)?.controller.abort(); this.fileViews.delete(key); this.rememberFileRelease(key);
  }
  async stop(context: SessionContext): Promise<void> {
    this.assertSelected(context);
    const binding = this.binding(context);
    await binding.adapter.stop(context.sessionId, binding.signal);
  }
  async answer(input: AnswerInput): Promise<void> {
    if (this.currentIsWebOwned(input.context)) throw new ProtocolFault('conflict');
    this.assertSelected(input.context);
    const binding = this.binding(input.context);
    await binding.adapter.answer(input, binding.signal);
  }
  syncNow(context: SessionContext): void {
    this.focus.validate(context);
    if (this.selection() !== null && sameSession(this.selection() as SessionContext, context)) {
      if (!this.currentIsWebOwned(context) && this.foreground === undefined) {
        this.clearForegroundRecovery(); void this.startForeground(context).catch(error => this.bodyFailed(context, error)); this.changed(); return;
      }
      void this.reconciler.synchronize(context, this.binding(context).adapter, this.binding(context).signal, 'foreground').catch(error => this.bodyFailed(context, error, undefined, 'foreground'));
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
    this.disposed = true; this.unsubscribed(); this.clearForegroundRecovery(); this.stopForeground();
    this.scheduler.dispose(); this.reconciler.dispose(); this.jobs.dispose(); this.pet?.dispose(); this.notifications?.dispose();
    for (const binding of this.bindings.values()) binding.adapter.dispose();
    for (const id of this.reconnects.keys()) this.clearReconnect(id);
    this.bindings.clear(); this.cache.clear(); this.drafts.clear(); this.pending.clear(); this.sends.clear(); this.nativeActions.dispose();
    this.cancelFileViews(); this.releasedFileViews.clear(); this.serverRecoveries.clear(); this.wantedConnections.clear(); this.manualConnectionDays.clear(); this.connected.clear();
  }

  private beginScope(scope: ServerScope): void {
    this.jobs.invalidate(scope.serverId); this.cancelFileViews(scope.serverId);
    if (this.foregroundRecovery?.context.serverId === scope.serverId) this.clearForegroundRecovery();
    if (this.foreground?.context.serverId === scope.serverId) this.stopForeground();
    this.scheduler.pauseServer(scope.serverId); this.reconciler.cancelServer(scope.serverId);
    this.directory.begin(scope); this.state.beginScope(scope); this.pending.delete(scope.serverId); this.cache.beginScope(scope);
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
        for (const session of this.directory.sessions(scope.serverId)) {
          this.state.upsert(scope, session); this.state.setArchived(scope, session.sessionId, this.directory.archived(scope.serverId, session.sessionId));
        }
        for (const facts of this.state.all()) if (facts.serverId === scope.serverId && this.directory.session(scope.serverId, facts.sessionId) === undefined) {
          this.state.revoke(scope, facts.sessionId);
          const context = { ...scope, workspaceId: null, sessionId: facts.sessionId }; this.reconciler.cancel(context); this.cache.remove(context);
        }
        this.changed();
      },
      removed: sessionId => {
        if (!this.scopeCurrent(scope)) return;
        this.directory.removeSession(scope, sessionId); this.state.revoke(scope, sessionId); this.jobs.removed(scope.serverId, sessionId);
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
        const changed = this.state.setState(scope, sessionId, { cursor: state.cursor, active: state.active, running: state.running,
          pendingIds: pending.length > 0 ? pending : state.pendingInput.map((kind, index) => `state:${kind}:${index}`) });
        this.primeRead(scope, sessionId, state.cursor); if (changed) this.changed();
      },
      directoryHint: sessionId => {
        if (!this.scopeCurrent(scope)) return;
        this.state.markSessionStale(scope, sessionId);
        this.logger?.record('info', 'session-context', { serverId: scope.serverId, generation: scope.generation, contextReason: 'runtime-detached' });
        this.changed();
      },
      stateFailed: (sessionId, fault) => {
        if (!this.scopeCurrent(scope)) return;
        if (this.state.markSessionStale(scope, sessionId)) this.changed();
        this.logger?.fault('read-failed', fault, { serverId: scope.serverId, generation: scope.generation, endpoint: 'session/state',
          ...(fault.kind === 'not-found' ? { contextReason: 'passive-missing' as const } : {}) });
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
    if (this.currentIsWebOwned(context)) return;
    const binding = this.binding(context); this.admission.opening(context);
    const controller = new AbortController();
    const foreground: Foreground = { context, controller, subscription: undefined, openingTimer: undefined, startedAt: Date.now() };
    this.foreground = foreground;
    const signal = AbortSignal.any([controller.signal, binding.signal]);
    foreground.openingTimer = setTimeout(() => this.foregroundFailed(foreground, new ProtocolFault('timeout')), 15000);
    try {
      const subscription = await binding.adapter.follow(context.sessionId, {
        snapshot: snapshot => {
          if (signal.aborted || this.foreground !== foreground || !this.scopeCurrent(context)) return;
          if (foreground.openingTimer !== undefined) clearTimeout(foreground.openingTimer); foreground.openingTimer = undefined;
          this.cache.applySnapshot(context, snapshot); this.admission.ready(context); this.clearForegroundRecovery(false, true);
          this.failures.delete(this.pref(context)); this.acceptCacheFacts(context);
          void this.reconciler.repair(context, binding.adapter, signal).catch(error => this.bodyFailed(context, error, 'session/events', 'foreground'));
        },
        event: event => {
          if (signal.aborted || this.foreground !== foreground || !this.scopeCurrent(context)) return;
          this.cache.applyEvent(context, event); this.acceptEvent(context, event, true);
          if (this.cache.get(context)?.hasGap) void this.reconciler.repair(context, binding.adapter, signal).catch(error => this.bodyFailed(context, error, 'session/events', 'foreground'));
        },
        assistant: frame => { if (!signal.aborted && this.foreground === foreground && this.scopeCurrent(context)) this.cache.applyAssistant(context, frame); },
        projections: frame => {
          if (signal.aborted || this.foreground !== foreground || !this.scopeCurrent(context)) return;
          this.cache.applyProjections(context, frame);
          const title = this.cache.get(context)?.title;
          if (title !== null && title !== undefined) this.state.setTitle(context, context.sessionId, title.text, title.asOfSeq);
          this.changed();
        },
        projectionsFailed: error => { if (!signal.aborted && this.foreground === foreground && this.scopeCurrent(context)) { this.cache.setNativeFailure(context, error); if (error.kind !== 'cancelled') this.logger?.fault('read-failed', error, { serverId: context.serverId, generation: context.generation, endpoint: 'session/projections' }); } },
        failed: error => this.foregroundFailed(foreground, error),
      }, signal);
      if (signal.aborted || this.foreground !== foreground) subscription.cancel(); else foreground.subscription = subscription;
    } catch (error) { if (!signal.aborted && this.foreground === foreground) this.foregroundFailed(foreground, error); }
  }
  /** 只有真正失败的当前实时流可重试；旁路预缓存超时不能打断健康实时流。 */
  private foregroundFailed(foreground: Foreground, error: unknown): void {
    if (this.foreground !== foreground || foreground.controller.signal.aborted || !this.scopeCurrent(foreground.context)) return;
    const failure = toPublicFailure(error); if (failure.kind === 'cancelled') return;
    this.bodyFailed(foreground.context, error, 'session/follow', 'foreground');
    if (!['network', 'timeout'].includes(failure.kind) || this.currentIsWebOwned(foreground.context)) { this.clearForegroundRecovery(); if (this.foreground === foreground) this.stopForeground(); return; }
    const binding = this.bindings.get(foreground.context.serverId);
    if (binding === undefined || binding.signal.aborted || this.suspendedDetails.has(foreground.context.serverId)) return;
    if (Date.now() - foreground.startedAt > 30000) { this.foregroundAttempts = 0; this.foregroundRecoveryStartedAt = undefined; }
    this.stopForeground();
    const attempt = this.foregroundAttempts = Math.min(this.foregroundAttempts + 1, 1000000); const delay = recoveryDelayMs(attempt);
    const startedAt = this.foregroundRecoveryStartedAt ?? Date.now(); this.foregroundRecoveryStartedAt = startedAt;
    const recovery: ForegroundRecovery = { context: foreground.context, view: { phase: 'waiting', attempt, limit: null, retryAt: Date.now() + delay, startedAt }, timer: undefined };
    this.foregroundRecovery = recovery;
    this.logRecovery(foreground.context.serverId, foreground.context.generation, 'conversation', 'waiting', attempt, delay, startedAt);
    recovery.timer = setTimeout(() => {
      if (this.disposed || this.foregroundRecovery !== recovery) return;
      const selected = this.selection();
      if (selected === null || !sameSession(selected, recovery.context) || this.currentIsWebOwned(selected) || !this.scopeCurrent(selected)
        || this.suspendedDetails.has(selected.serverId) || !this.directory.ready(selected.serverId)) { this.clearForegroundRecovery(); return; }
      recovery.timer = undefined; recovery.view = { ...recovery.view, phase: 'connecting', retryAt: null };
      this.logRecovery(selected.serverId, selected.generation, 'conversation', 'connecting', attempt, 0, recovery.view.startedAt); this.changed();
      void this.startForeground(selected).catch(error => this.bodyFailed(selected, error));
    }, delay);
    this.changed();
  }
  private clearForegroundRecovery(resetAttempts = true, completed = false): void {
    const recovery = this.foregroundRecovery; this.foregroundRecovery = undefined;
    if (recovery?.timer !== undefined) clearTimeout(recovery.timer);
    if (recovery !== undefined) this.logRecovery(recovery.context.serverId, recovery.context.generation, 'conversation', completed ? 'ready' : 'cancelled', recovery.view.attempt, 0, recovery.view.startedAt);
    if (resetAttempts) { this.foregroundAttempts = 0; this.foregroundRecoveryStartedAt = undefined; this.admission.clear(); }
  }
  private stopForeground(): void {
    const foreground = this.foreground; this.foreground = undefined;
    if (foreground?.openingTimer !== undefined) clearTimeout(foreground.openingTimer);
    foreground?.controller.abort(); foreground?.subscription?.cancel();
    if (foreground !== undefined) this.cache.markNativeCached(foreground.context);
  }
  private acceptCacheFacts(context: SessionContext): void {
    if (!this.scopeCurrent(context)) return;
    const cached = this.cache.get(context); if (cached === undefined) return;
    const facts = this.state.get(context.serverId, context.sessionId);
    if (cached.title !== null) this.state.setTitle(context, context.sessionId, cached.title.text, cached.title.asOfSeq);
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
    this.jobs.invalidate(serverId, revoke); this.cancelFileViews(serverId);
    if (this.foregroundRecovery?.context.serverId === serverId) this.clearForegroundRecovery();
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
    const servers = this.auth.list(); void this.intents?.keepServers(servers.map(server => server.config)).catch(() => {});
    for (const server of servers) {
      const oldScope = this.directory.scope(server.config.id);
      if (oldScope !== undefined && oldScope.authProfileId !== server.config.authProfileId) { this.pause(server.config.id, true); this.connected.delete(server.config.id); }
      const wanted = this.wantedConnections.get(server.config.id);
      if (wanted !== undefined && wanted !== connectionIdentity(server.config)) {
        this.wantedConnections.delete(server.config.id); this.manualConnectionDays.delete(server.config.id); this.connected.delete(server.config.id); this.clearReconnect(server.config.id);
      }
      if (server.state === 'readonly-ready') {
        const previous = this.connected.get(server.config.id);
        const newlyVerified = previous?.authProfileId !== server.config.authProfileId || previous.generation !== server.generation;
        this.connected.set(server.config.id, { authProfileId: server.config.authProfileId, generation: server.generation }); this.clearReconnect(server.config.id, true); this.recoveryAttempts.delete(server.config.id);
        const manual = this.manualConnectionDays.get(server.config.id);
        if (manual !== undefined && manual.identity === connectionIdentity(server.config) && this.wantedConnections.get(server.config.id) === manual.identity) {
          this.manualConnectionDays.delete(server.config.id); void this.intents?.rememberVerified(server.config, manual.day).catch(() => {});
        }
        if (newlyVerified && this.lastSelection?.serverId === server.config.id && this.lastSelection.authProfileId === server.config.authProfileId) {
          const resolved = this.focus.resolve(server.config.id, this.lastSelection.sessionId);
          if (resolved !== undefined && (this.foreground === undefined || !sameSession(this.foreground.context, resolved))) this.select(resolved);
        }
      } else if (server.authenticationOpen || server.state === 'authenticating') { this.jobs.invalidate(server.config.id, true); this.clearReconnect(server.config.id); this.pause(server.config.id, false); }
      else if (['auth-required', 'denied'].includes(server.state)) {
        this.wantedConnections.delete(server.config.id); this.manualConnectionDays.delete(server.config.id); this.recoveryAttempts.delete(server.config.id); this.connected.delete(server.config.id);
        this.clearReconnect(server.config.id);
        if (wanted !== undefined) void this.intents?.disconnect(server.config).catch(() => {});
        this.pause(server.config.id, true);
      }
      else if (server.state === 'failed' || server.state === 'incompatible') {
        this.pause(server.config.id, false);
        if (server.failure !== null && ['network', 'timeout'].includes(server.failure.kind) && this.wantedConnections.get(server.config.id) === connectionIdentity(server.config)) this.scheduleReconnect(server.config.id);
        else this.clearReconnect(server.config.id);
      } else if (server.state === 'idle' || server.state === 'cancelled' || server.state === 'probing') {
        // 编辑入口/路线、取消登录或重新探测会使旧载体失效；缓存可显示，旧目录不再具有路由权限。
        if (oldScope !== undefined) this.pause(server.config.id, false);
      }
    }
    this.changed();
  }
  private wantConnection(serverId: string, day?: string): ServerConfig {
    const config = this.auth.list().find(server => server.config.id === serverId)?.config;
    if (config === undefined) throw new ProtocolFault('not-found');
    const identity = connectionIdentity(config); this.wantedConnections.set(serverId, identity);
    if (day !== undefined) this.manualConnectionDays.set(serverId, { identity, day });
    return config;
  }
  private scheduleReconnect(serverId: string): void {
    if (this.reconnects.has(serverId) || this.disposed) return;
    const config = this.auth.list().find(server => server.config.id === serverId)?.config;
    if (config === undefined || this.wantedConnections.get(serverId) !== connectionIdentity(config)) return;
    const attempt = Math.min((this.recoveryAttempts.get(serverId) ?? 0) + 1, 1000000); const delay = recoveryDelayMs(attempt);
    this.recoveryAttempts.set(serverId, attempt);
    this.setServerRecovery(serverId, { phase: 'waiting', attempt, limit: null, retryAt: Date.now() + delay });
    const timer = setTimeout(() => {
      this.reconnects.delete(serverId);
      if (this.disposed || this.wantedConnections.get(serverId) !== connectionIdentity(config)) return;
      this.setServerRecovery(serverId, { phase: 'connecting', attempt, limit: null, retryAt: null }); this.changed();
      // 网络重试只复用登录态，不自动弹出登录窗，也不重发任何人工写入。
      void this.auth.connect(serverId, false).catch(error => this.failedReconnectAttempt(serverId, attempt, error));
    }, delay);
    this.reconnects.set(serverId, { attempt, timer });
  }
  private failedReconnectAttempt(serverId: string, attempt: number, error: unknown): void {
    if (this.disposed || this.serverRecoveries.get(serverId)?.attempt !== attempt) return;
    if (['network', 'timeout'].includes(toPublicFailure(error).kind)) this.scheduleReconnect(serverId); else this.clearReconnect(serverId);
    this.changed();
  }
  private setServerRecovery(serverId: string, recovery: RecoveryView): void {
    const timed = { ...recovery, startedAt: recovery.startedAt ?? this.serverRecoveries.get(serverId)?.startedAt ?? Date.now() };
    this.serverRecoveries.set(serverId, timed);
    this.logRecovery(serverId, this.auth.list().find(server => server.config.id === serverId)?.generation ?? 0, 'server', timed.phase, timed.attempt,
      timed.retryAt === null ? 0 : Math.max(0, Math.min(30000, timed.retryAt - Date.now())), timed.startedAt);
  }
  private clearReconnect(serverId: string, completed = false): void {
    const reconnect = this.reconnects.get(serverId); if (reconnect !== undefined) clearTimeout(reconnect.timer); this.reconnects.delete(serverId);
    const recovery = this.serverRecoveries.get(serverId); this.serverRecoveries.delete(serverId);
    if (recovery !== undefined) this.logRecovery(serverId, this.auth.list().find(server => server.config.id === serverId)?.generation ?? 0, 'server', completed ? 'ready' : 'cancelled', recovery.attempt, 0, recovery.startedAt);
  }
  private logRecovery(serverId: string, generation: number, target: 'server' | 'conversation', phase: 'waiting' | 'connecting' | 'stopped' | 'ready' | 'cancelled', attempt: number, delay = 0, startedAt?: number): void {
    this.logger?.record('info', 'reconnect-state', { serverId, generation, recoveryTarget: target, recoveryPhase: phase, retryAttempt: attempt, retryDelayMs: delay,
      ...(startedAt === undefined ? {} : { recoveryElapsedMs: Math.max(0, Date.now() - startedAt) }) });
  }
  private bodyFailed(context: SessionContext, error: unknown, endpoint?: string, purpose?: 'foreground' | 'background'): void {
    if (!this.scopeCurrent(context)) return;
    const failure = toPublicFailure(error);
    if (failure.kind === 'cancelled') return;
    this.logger?.fault('read-failed', error, { serverId: context.serverId, generation: context.generation,
      ...(endpoint === undefined ? {} : { endpoint }), ...(purpose === undefined ? {} : { streamPurpose: purpose }),
      ...(['forbidden', 'auth-required', 'login-response'].includes(failure.kind) ? { contextReason: 'access-denied' as const } : {}) });
    this.failures.set(this.pref(context), failure);
    if (['forbidden', 'auth-required', 'login-response'].includes(failure.kind)) {
      this.directory.removeSession(context, context.sessionId); this.state.revoke(context, context.sessionId);
      this.reconciler.cancel(context); this.cache.remove(context);
      if (this.foreground !== undefined && sameSession(this.foreground.context, context)) this.stopForeground();
    } else this.cache.setFailure(context, error);
    this.changed();
  }
  private jobBinding(context: SessionContext): WorkbenchAdapter {
    if (this.disposed) throw new ProtocolFault('cancelled');
    // 先判定连接代次是否仍有效，再验证目录路由；恢复中的旧续租是取消，不是撤权。
    const binding = this.binding(context); this.assertSelected(context);
    if (binding.adapter.source !== 'live' || this.suspendedDetails.has(context.serverId)) throw new ProtocolFault('unsupported');
    return binding.adapter;
  }
  /** 文件读取不参与问答或审批，允许当前原网页 owner 同时保有人工交互。 */
  private fileBinding(context: SessionContext): Binding & { readonly files: FileShareReader } {
    this.assertSelected(context);
    const server = this.auth.list().find(server => server.config.id === context.serverId);
    if (server?.state !== 'readonly-ready' || server.authenticationOpen || this.suspendedDetails.has(context.serverId)) throw new ProtocolFault('auth-required');
    const binding = this.binding(context); const files = binding.files;
    if (files === undefined || binding.adapter.source !== 'live') throw new ProtocolFault('unsupported');
    return { ...binding, files };
  }
  private async fileRead<T>(input: FileReadScope, operation: (files: FileShareReader, signal: AbortSignal) => Promise<T>, endpoint: string): Promise<T> {
    const binding = this.fileBinding(input.context); const key = this.fileViewKey(input);
    if (this.releasedFileViews.has(key)) throw new ProtocolFault('cancelled');
    let view = this.fileViews.get(key);
    if (view === undefined) {
      if (this.fileViews.size >= 4) throw new ProtocolFault('budget');
      view = { context: input.context, controller: new AbortController() }; this.fileViews.set(key, view);
    }
    const signal = AbortSignal.any([binding.signal, view.controller.signal]);
    try {
      const result = await operation(binding.files, signal);
      if (signal.aborted || this.fileViews.get(key) !== view) throw new ProtocolFault('cancelled');
      this.fileBinding(input.context); return result;
    } catch (error) {
      if (toPublicFailure(error).kind !== 'cancelled') this.logger?.fault('read-failed', error, { serverId: input.context.serverId, generation: input.context.generation, endpoint });
      throw error;
    }
  }
  private fileViewKey(input: FileReadScope): string { return JSON.stringify([input.context.serverId, input.context.authProfileId, input.context.generation, input.context.sessionId, input.viewId]); }
  private rememberFileRelease(key: string): void {
    this.releasedFileViews.add(key);
    if (this.releasedFileViews.size > 256) { const oldest = this.releasedFileViews.values().next().value; if (oldest !== undefined) this.releasedFileViews.delete(oldest); }
  }
  private cancelFileViews(serverId?: string): void {
    for (const [key, view] of this.fileViews) if (serverId === undefined || view.context.serverId === serverId) { view.controller.abort(); this.fileViews.delete(key); this.rememberFileRelease(key); }
  }
  private async prepareNative<T>(prepare: () => T | Promise<T>): Promise<T> {
    try { return await prepare(); }
    catch (error) { throw new NativeActionNotSent(toPublicFailure(error).kind); }
  }
  private assertNativeAction(context: SessionContext, signal: AbortSignal): void {
    if (signal.aborted) throw new NativeActionNotSent();
    try { this.nativeBinding(context); }
    catch (error) { throw new NativeActionNotSent(toPublicFailure(error).kind); }
  }
  private nativeBinding(context: SessionContext): Binding {
    this.assertSelected(context);
    if (this.currentIsWebOwned(context)) throw new ProtocolFault('conflict');
    const binding = this.binding(context);
    if (binding.adapter.source !== 'live' || this.directory.session(context.serverId, context.sessionId)?.origin === 'subagent') throw new ProtocolFault('unsupported');
    return binding;
  }
  private nativeSignal(context: SessionContext, binding: Binding): AbortSignal {
    const foreground = this.foreground;
    return foreground !== undefined && sameSession(foreground.context, context) ? AbortSignal.any([binding.signal, foreground.controller.signal]) : binding.signal;
  }
  private nativeFailed(context: SessionContext, error: unknown, endpoint: string): void {
    if (this.scopeCurrent(context) && toPublicFailure(error).kind !== 'cancelled') this.logger?.fault('read-failed', error, { serverId: context.serverId, generation: context.generation, endpoint });
  }
  private binding(context: ServerScope): Binding {
    if (context.serverId !== 'demo' || !this.demo) this.validateScope(context.serverId, context.authProfileId, context.generation);
    const binding = this.bindings.get(context.serverId);
    if (binding === undefined || binding.signal.aborted || binding.scope.authProfileId !== context.authProfileId || binding.scope.generation !== context.generation) throw new ProtocolFault('auth-required');
    return binding;
  }
  private scopeCurrent(scope: ServerScope): boolean {
    const current = this.directory.scope(scope.serverId);
    return current?.authProfileId === scope.authProfileId && current.generation === scope.generation;
  }
  private selection(): SessionContext | null {
    const saved = this.lastSelection;
    if (saved !== null && this.directory.ready(saved.serverId)
      && this.directory.scope(saved.serverId)?.authProfileId === saved.authProfileId
      && (this.directory.session(saved.serverId, saved.sessionId) === undefined || this.directory.archived(saved.serverId, saved.sessionId))) {
      // 离线保留缓存；已确认删除或归档则撤销选择，不留可点击的旧人工输入。
      this.logger?.record('info', 'session-context', { serverId: saved.serverId, generation: this.directory.scope(saved.serverId)?.generation ?? saved.generation,
        contextReason: this.directory.archived(saved.serverId, saved.sessionId) ? 'archived' : 'directory-absent' });
      this.jobs.removed(saved.serverId, saved.sessionId); this.cancelFileViews(saved.serverId); this.clearForegroundRecovery(); this.stopForeground(); this.focus.clear(saved.serverId); this.lastSelection = null; this.cache.protect(null);
    }
    const selected = this.focus.current();
    if (selected !== null) this.lastSelection = selected;
    return this.lastSelection === null ? null : { ...this.lastSelection };
  }
  private currentIsWebOwned(context: SessionContext): boolean {
    const owner = this.webOwner;
    return owner !== null && owner.scope.serverId === context.serverId && owner.scope.authProfileId === context.authProfileId && owner.scope.generation === context.generation && (owner.sessionId === null || owner.sessionId === context.sessionId);
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
    return { ...summary, title: facts?.title ?? summary.title ?? (summary.blank ? '新会话' : '未命名会话'),
      followed: preference.followed, unread: preference.manualUnread || (facts?.baselineCursor !== null && (facts?.cursor ?? -1) > preference.readSeq),
      archived: this.directory.archived(serverId, sessionId), running: facts?.running ?? summary.running,
      pendingCount: facts?.pendingIds.length ?? 0, task: task?.color ?? null, freshness: facts?.freshness ?? 'stale' };
  }
  private conversation(context: SessionContext): ConversationView {
    const cachedEntry = this.cache.getForDisplay(context);
    const server = this.auth.list().find(server => server.config.id === context.serverId);
    const locked = server !== undefined && (server.authenticationOpen || server.state === 'authenticating' || server.state === 'auth-required' || server.state === 'denied'
      || server.config.authProfileId !== context.authProfileId);
    const cached = locked ? undefined : cachedEntry;
    const binding = this.bindings.get(context.serverId);
    const verified = this.connected.get(context.serverId);
    const connected = binding !== undefined && !binding.signal.aborted && this.directory.ready(context.serverId)
      && (context.serverId === 'demo' || verified?.authProfileId === context.authProfileId && verified.generation === context.generation);
    const failure = this.failures.get(this.pref(context)) ?? cached?.failure ?? null;
    const ledgers = [...this.sends.entries()].filter(([key]) => JSON.parse(key)[0] === this.pref(context));
    const last = ledgers[ledgers.length - 1]?.[1];
    return {
      context, title: this.row(context.serverId, context.authProfileId, context.sessionId)?.title ?? context.sessionId,
      status: cached === undefined ? failure === null ? 'loading' : 'error' : !connected || cached.freshness === 'stale' ? 'stale' : cached.hasGap ? 'gap' : this.foreground !== undefined && sameSession(this.foreground.context, context) && this.foreground.openingTimer === undefined ? 'live' : 'cached',
      events: cached?.events ?? [], assistant: cached?.assistant ?? { revision: 0, activeAttempt: null }, cursor: cached?.cursor ?? -1,
      hasMore: cached?.hasMore ?? false, hasGap: cached?.hasGap ?? false, syncedAt: cached?.syncedAt ?? null,
      syncing: cached?.syncing ?? (cached === undefined && failure === null), draft: this.drafts.get(this.pref(context)) ?? '', failure,
      ...(cached?.native === undefined ? {} : { native: cached.native }),
      ...(locked || this.foregroundRecovery === undefined || !sameSession(this.foregroundRecovery.context, context) ? {} : { recovery: { ...this.foregroundRecovery.view } }),
      pending: this.pending.get(context.serverId)?.filter(item => item.sessionId === context.sessionId) ?? [], sendState: last?.state ?? 'idle',
    };
  }
  private updateTargets(): void {
    const targets = this.state.all().flatMap(facts => {
      const context = this.directory.resolve(facts.serverId, facts.sessionId);
      const binding = this.bindings.get(facts.serverId); const verified = this.connected.get(facts.serverId);
      return context === undefined || binding === undefined || binding.signal.aborted || !facts.accessible || this.suspendedDetails.has(facts.serverId)
        || facts.serverId !== 'demo' && (verified?.authProfileId !== context.authProfileId || verified.generation !== context.generation)
        ? [] : [{ context, running: facts.running, pending: facts.pendingIds.length > 0 }];
    });
    const selected = this.selection();
    this.scheduler.update(targets, selected !== null && this.currentIsWebOwned(selected) ? null : selected);
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
