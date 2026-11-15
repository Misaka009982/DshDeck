import { BrowserWindow, WebContentsView, ipcMain } from 'electron';
import type { IpcMainEvent } from 'electron';
import { join } from 'node:path';
import type { ServerScope, SessionContext } from '../../shared/domain.js';
import type { SessionWebState, WebViewport } from '../../shared/session-web.js';
import { parseWebPageState, sameWebContext, webTargetArgument } from '../../shared/session-web.js';
import { ProtocolFault } from '../../shared/faults.js';
import type { AuthService } from '../auth/auth-service.js';
import type { BasicAuthBroker } from '../auth/basic-auth-broker.js';
import type { DiagnosticLogger } from '../logging/diagnostic-logger.js';
import type { WorkbenchService } from '../state/workbench-service.js';
import { remoteWebPreferences } from './security-options.js';
import { closeRemotePage } from './close-remote-page.js';

interface Entry {
  readonly view: WebContentsView; readonly scope: ServerScope; context: SessionContext | null; readonly serial: number;
  readonly baseUrl: string; readonly release: () => void; timer: ReturnType<typeof setTimeout> | undefined;
  ready: boolean; styleKey: string | undefined; styleSignature: string;
}
const CLOSED: SessionWebState = { state: 'closed', serverId: null, context: null, dark: false, message: '' };
const COMPACT_CSS = `body:not([data-dshdeck-show-sidebar]) [data-dshdeck-frame] { grid-template-columns:0px minmax(0px,1fr) var(--dshdeck-right-track,0px)!important; }
body:not([data-dshdeck-show-sidebar]) [data-dshdeck-sidebar],body:not([data-dshdeck-show-sidebar]) [data-shell-leading],body:not([data-dshdeck-show-sidebar]) [data-sidebar-mask] { display:none!important; }`;

/** 单一原网页载体；缓存先显示，旧网页物理关闭后才创建下一个，不持有工作台 IPC。 */
export class SessionWebView {
  private current: Entry | undefined;
  private value: SessionWebState = { ...CLOSED };
  private viewport: WebViewport = { x: 0, y: 80, width: 0, height: 0, visible: false };
  private queue: Promise<void> = Promise.resolve();
  private serial = 0;
  private desiredKey = '';
  private suppressedKey = '';
  private manualServer: string | null = null;
  private lastSelectionKey = '';
  private disposed = false;
  private readonly watch: ReturnType<typeof setInterval>;
  private readonly receive: (event: IpcMainEvent, value: unknown) => void;
  constructor(private readonly parent: BrowserWindow, private readonly preloadRoot: string, private readonly auth: AuthService,
    private readonly workbench: WorkbenchService, private readonly basicAuth: BasicAuthBroker, private readonly logger: DiagnosticLogger) {
    this.receive = (event, value) => this.pageState(event, value);
    ipcMain.on('session-web:state', this.receive);
    this.watch = setInterval(() => this.refresh(), 200);
    workbench.attachWeb(this);
  }
  status(): SessionWebState { return { ...this.value, context: this.value.context === null ? null : { ...this.value.context } }; }
  refresh(force = false): void {
    if (this.disposed || this.parent.isDestroyed()) return;
    const selected = this.workbench.selectedContext();
    const selectedKey = selected === null ? '' : JSON.stringify([selected.serverId, selected.authProfileId, selected.generation, selected.sessionId]);
    const entry = this.current;
    if (selected !== null && entry !== undefined && entry.context !== null && entry.serial === this.serial
      && entry.scope.serverId === selected.serverId && entry.scope.authProfileId === selected.authProfileId && entry.scope.generation === selected.generation
      && entry.context.sessionId === selected.sessionId && entry.context.workspaceId !== selected.workspaceId) {
      entry.context = { ...selected }; this.setState({ ...this.value, context: { ...selected } });
    }
    if (selectedKey !== this.lastSelectionKey) { this.manualServer = null; this.suppressedKey = ''; this.lastSelectionKey = selectedKey; }
    const mode = this.workbench.preferences.appearance().viewMode;
    const serverId = this.manualServer ?? (mode === 'web' && selected?.serverId !== 'demo' ? selected?.serverId ?? null : null);
    const server = serverId === null ? undefined : this.auth.list().find(server => server.config.id === serverId);
    const context = this.manualServer === null ? selected : null;
    const eligible = server !== undefined && !['authenticating', 'probing'].includes(server.state) && (context === null || server.state === 'readonly-ready' && context.authProfileId === server.config.authProfileId && context.generation === server.generation);
    const key = eligible ? JSON.stringify([server?.config.id, server?.config.authProfileId, server?.generation, context?.sessionId ?? null]) : '';
    if (!force && (key === this.desiredKey || key !== '' && key === this.suppressedKey)) { void this.applyAppearance(); return; }
    this.desiredKey = key; const serial = ++this.serial;
    this.current?.view.setVisible(false);
    this.setState(key === '' ? { ...CLOSED } : { state: 'loading', serverId, context, dark: false, message: '先显示原生缓存，正在定位原网页会话…' });
    this.queue = this.queue.then(async () => {
      await this.destroyCurrent();
      if (this.disposed || serial !== this.serial || key === '' || server === undefined) return;
      if (this.workbench.hasNativePending(server.config.id, context?.sessionId ?? null)) {
        this.failed(key, server.config.id, context, new ProtocolFault('conflict')); return;
      }
      try { await this.open(server.config.id, context, serial); }
      catch (error) {
        if (serial === this.serial) { await this.destroyCurrent(); this.failed(key, server.config.id, context, error); }
      }
    }).catch(error => { if (!this.disposed && serial === this.serial) this.failed(key, serverId, context, error); });
  }
  async openServer(serverId: string): Promise<void> {
    const server = this.auth.list().find(server => server.config.id === serverId);
    if (server === undefined) throw new ProtocolFault('not-found');
    const selected = this.workbench.selectedContext();
    if (selected?.serverId === serverId && server.state === 'readonly-ready') {
      await this.workbench.preferences.updateAppearance({ viewMode: 'web' });
      this.manualServer = null; this.suppressedKey = ''; this.refresh(true); return;
    }
    await this.openWholeServer(serverId);
  }
  async openWholeServer(serverId: string): Promise<void> {
    if (!this.auth.list().some(server => server.config.id === serverId)) throw new ProtocolFault('not-found');
    if (this.workbench.hasNativePending(serverId, null)) throw new ProtocolFault('conflict');
    this.workbench.clearSelection(); this.lastSelectionKey = ''; this.manualServer = serverId; this.suppressedKey = ''; this.refresh(true);
  }
  async close(): Promise<void> {
    this.suppressedKey = this.desiredKey; this.desiredKey = ''; this.manualServer = null; const serial = ++this.serial;
    this.current?.view.setVisible(false);
    this.queue = this.queue.then(() => this.destroyCurrent()); await this.queue;
    if (serial === this.serial) this.setState({ ...CLOSED });
  }
  setViewport(viewport: WebViewport): void { this.viewport = { ...viewport }; this.layout(); }
  async toggleSidebar(): Promise<void> {
    const entry = this.requireReady();
    await entry.view.webContents.executeJavaScript("document.body.toggleAttribute('data-dshdeck-show-sidebar'); void 0;", true);
  }
  async showFiles(): Promise<boolean> {
    const entry = this.requireReady();
    // 只点击导航区域的明确文件入口；找不到时保留原网页并提示手动打开，不猜文件 API。
    const result: unknown = await entry.view.webContents.executeJavaScript(`(() => {
      const labels = new Set(['文件','文件夹','项目文件','文件浏览器','Files','Project Files','File Explorer']);
      const controls = document.querySelectorAll('button[type="button"], [role="tab"]');
      for (const element of controls) {
        if (!(element instanceof HTMLElement) || !element.closest('nav,header,[role="tablist"]') || element.closest('form')) continue;
        if (element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('disabled')) continue;
        const label = (element.getAttribute('aria-label') || element.textContent || '').trim();
        const rect = element.getBoundingClientRect();
        if (label.length <= 32 && labels.has(label) && rect.width > 0 && rect.height > 0) { element.click(); return true; }
      }
      return false;
    })()`, true);
    return result === true;
  }
  async showConversation(): Promise<boolean> {
    const entry = this.requireReady();
    const value: unknown = await entry.view.webContents.executeJavaScript(`(() => {
      const labels = new Set(['对话','Conversation','Chat']);
      for (const button of document.querySelectorAll('[data-conversation-tabs] button[role="tab"]')) {
        const label = (button.textContent || '').trim(); if (label.length <= 32 && labels.has(label)) { button.click(); return true; }
      }
      return false;
    })()`, true); return value === true;
  }
  contentsForSnapshot(): Electron.WebContents { return this.requireReady().view.webContents; }
  async dispose(): Promise<void> {
    if (this.disposed) return; this.disposed = true; clearInterval(this.watch); ipcMain.removeListener('session-web:state', this.receive);
    await this.close();
  }
  private async open(serverId: string, context: SessionContext | null, serial: number): Promise<void> {
    const saved = this.auth.list().find(server => server.config.id === serverId); if (saved === undefined) throw new ProtocolFault('not-found');
    const session = this.auth.serverSession(serverId); await session.ready();
    if (this.disposed || this.parent.isDestroyed() || serial !== this.serial) throw new ProtocolFault('cancelled');
    this.workbench.validateScope(serverId, saved.config.authProfileId, saved.generation);
    if (context !== null) this.workbench.validateContext(context);
    const summary = context === null ? undefined : this.workbench.directory.session(serverId, context.sessionId);
    const parentId = summary?.origin === 'subagent' ? summary.parentSessionId : undefined;
    const view = new WebContentsView({ webPreferences: { ...remoteWebPreferences(session.partition),
      preload: join(this.preloadRoot, 'session-web-preload.cjs'), additionalArguments: [webTargetArgument(saved.config.baseUrl, context, parentId)] } });
    view.setBackgroundColor('#00000000'); view.setVisible(false);
    const entry: Entry = { view, serial, scope: { serverId, authProfileId: saved.config.authProfileId, generation: saved.generation }, context,
      baseUrl: saved.config.baseUrl, release: session.allowCompatibilityContents(view.webContents.id), timer: undefined, ready: false, styleKey: undefined, styleSignature: '' };
    this.current = entry;
    const origin = new URL(saved.config.baseUrl).origin;
    this.basicAuth.bind(view.webContents, this.parent, saved.config.authProfileId, new Set([origin]));
    const navigate = (event: { preventDefault(): void }, raw: string): void => {
      try { const url = new URL(raw); if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || !url.pathname.startsWith(new URL(entry.baseUrl).pathname)) event.preventDefault(); }
      catch { event.preventDefault(); }
    };
    view.webContents.on('will-navigate', navigate); view.webContents.on('will-redirect', navigate);
    view.webContents.on('will-attach-webview', event => event.preventDefault()); view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('preload-error', () => this.entryFailed(entry, new ProtocolFault('unsupported')));
    view.webContents.on('render-process-gone', () => this.entryFailed(entry, new ProtocolFault('network')));
    view.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (mainFrame && code !== -3) { this.logger.record('warn', 'page-load-failed', { serverId, mainFrame: true, errorCode: code, viewType: 'webContentsView' }); this.entryFailed(entry, new ProtocolFault('network')); }
    });
    this.parent.contentView.addChildView(view); this.layout();
    entry.timer = setTimeout(() => this.entryFailed(entry, new ProtocolFault('timeout')), 25000);
    // 不让加载 Promise 占住关闭队列；切换或就绪超时必须能直接销毁仍在加载的网页。
    void view.webContents.loadURL(saved.config.baseUrl).then(async () => {
      if (this.current !== entry || view.webContents.isDestroyed()) return;
      await this.applyAppearance();
      if (context === null && this.current === entry && !view.webContents.isDestroyed()) {
        await view.webContents.executeJavaScript("document.body?.setAttribute('data-dshdeck-show-sidebar',''); void 0;");
        this.makeReady(entry, this.value.dark);
      }
    }).catch(error => this.entryFailed(entry, error));
  }
  private pageState(event: IpcMainEvent, value: unknown): void {
    const entry = this.current; if (entry === undefined || entry.serial !== this.serial || event.sender.id !== entry.view.webContents.id || event.senderFrame === null || event.senderFrame !== event.sender.mainFrame || entry.view.webContents.isDestroyed()) return;
    try {
      const url = new URL(event.senderFrame.url); const base = new URL(entry.baseUrl);
      if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return;
      const page = parseWebPageState(value);
      if (entry.context !== null && page.sessionId !== entry.context.sessionId) {
        entry.view.setVisible(false);
        const next = page.sessionId === null ? undefined : this.workbench.directory.resolve(entry.scope.serverId, page.sessionId);
        if (next !== undefined) { this.workbench.select(next); this.refresh(); }
        else this.entryFailed(entry, new ProtocolFault('conflict'));
        return;
      }
      if (page.ready) this.makeReady(entry, page.dark);
    } catch (error) { this.entryFailed(entry, error); }
  }
  private makeReady(entry: Entry, dark: boolean): void {
    if (this.current !== entry || entry.serial !== this.serial || this.disposed) return;
    try {
      if (!entry.ready) {
        this.workbench.validateScope(entry.scope.serverId, entry.scope.authProfileId, entry.scope.generation);
        if (entry.context !== null) this.workbench.validateContext(entry.context);
        this.workbench.enterWeb(entry.scope, entry.context?.sessionId ?? null); entry.ready = true;
        if (entry.timer !== undefined) clearTimeout(entry.timer); entry.timer = undefined;
      }
      this.setState({ state: 'ready', serverId: entry.scope.serverId, context: entry.context, dark, message: '原网页会话；插件按服务器原站点显示。' });
      this.layout();
    } catch (error) { this.entryFailed(entry, error); }
  }
  private async destroyCurrent(): Promise<void> {
    const entry = this.current; if (entry === undefined) return; this.current = undefined;
    if (entry.timer !== undefined) clearTimeout(entry.timer); entry.view.setVisible(false);
    if (!this.parent.isDestroyed()) this.parent.contentView.removeChildView(entry.view);
    await closeRemotePage(entry.view.webContents); entry.release(); this.workbench.leaveWeb(entry.scope);
  }
  private entryFailed(entry: Entry, error: unknown): void {
    if (this.current !== entry || entry.serial !== this.serial || this.disposed) return;
    this.failed(this.desiredKey, entry.scope.serverId, entry.context, error); entry.view.setVisible(false);
    this.queue = this.queue.then(() => { if (this.current === entry) return this.destroyCurrent(); }).catch(error => { this.logger.fault('web-view-state', error, { webState: 'failed' }); });
  }
  private failed(key: string, serverId: string | null, context: SessionContext | null, error: unknown): void {
    this.suppressedKey = key;
    const conflict = error instanceof ProtocolFault && error.kind === 'conflict';
    this.logger.fault('web-view-state', error, { ...(serverId === null ? {} : { serverId }), webState: 'failed' });
    this.setState({ state: 'failed', serverId, context, dark: false, message: conflict ? '已有原生交互或导航目标尚未核实；先保留原生面板，处理后重开原网页。' : '原网页未能安全定位当前会话；先保留原生缓存，可重试或打开整站网页。' });
  }
  private setState(value: SessionWebState): void {
    if (JSON.stringify(this.value) === JSON.stringify(value)) return;
    this.value = value;
    this.logger.record(value.state === 'failed' ? 'warn' : 'info', 'web-view-state', { ...(value.serverId === null ? {} : { serverId: value.serverId }), webState: value.state });
    this.workbench.refreshPresentation();
  }
  private layout(): void {
    const entry = this.current; if (entry === undefined || this.parent.isDestroyed() || entry.view.webContents.isDestroyed()) return;
    if (entry.serial !== this.serial) { entry.view.setVisible(false); return; }
    const box = this.parent.getContentBounds(); const x = Math.min(this.viewport.x, box.width); const y = Math.max(70, Math.min(this.viewport.y, box.height));
    const width = Math.max(0, Math.min(this.viewport.width, box.width - x)); const height = Math.max(0, Math.min(this.viewport.height, box.height - y));
    entry.view.setBounds({ x, y, width, height }); entry.view.setVisible(entry.ready && this.viewport.visible && width > 0 && height > 0);
  }
  private requireReady(): Entry {
    const entry = this.current;
    if (entry === undefined || entry.serial !== this.serial || !entry.ready || entry.view.webContents.isDestroyed()) throw new ProtocolFault('unsupported');
    if (entry.context !== null) this.workbench.validateContext(entry.context);
    const context = this.workbench.selectedContext();
    if (entry.context !== null && !sameWebContext(entry.context, context)) throw new ProtocolFault('cancelled');
    const server = this.auth.list().find(server => server.config.id === entry.scope.serverId);
    if (server?.config.authProfileId !== entry.scope.authProfileId || server.generation !== entry.scope.generation) throw new ProtocolFault('cancelled');
    return entry;
  }
  private async applyAppearance(): Promise<void> {
    const entry = this.current; if (entry === undefined || entry.serial !== this.serial || entry.view.webContents.isDestroyed()) return;
    const appearance = this.workbench.appearanceView();
    const transparent = appearance?.settings.backgroundEnabled && appearance.image !== null && appearance.imageState === 'ready';
    const signature = JSON.stringify([transparent, appearance?.settings.sessionTransparency]); if (entry.styleSignature === signature) return;
    entry.styleSignature = signature;
    const extra = transparent ? `html,body { background:transparent!important; } body { --dsw-alias-bg-base:transparent!important; }` : '';
    try {
      const key = await entry.view.webContents.insertCSS(`${COMPACT_CSS}\n${extra}`);
      if (this.current !== entry || entry.view.webContents.isDestroyed()) return;
      if (entry.styleSignature !== signature) { await entry.view.webContents.removeInsertedCSS(key); return; }
      const old = entry.styleKey; entry.styleKey = key; if (old !== undefined) await entry.view.webContents.removeInsertedCSS(old);
    } catch (error) { if (this.current === entry && !entry.view.webContents.isDestroyed()) this.entryFailed(entry, error); }
  }
}
