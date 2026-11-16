import { BrowserWindow, clipboard, dialog, Menu, screen, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ProtocolFault, requireId, requireKeys, requireRecord } from '../../shared/faults.js';
import { normalizeServerInput } from '../../shared/server-config.js';
import { parseContext } from '../../shared/domain.js';
import { parseAppearance, parseAppearancePatch } from '../../shared/appearance.js';
import { parseWebViewport } from '../../shared/session-web.js';
import { restoreWindowState } from '../../shared/window-state.js';
import type { WindowStateStore } from './window-state.js';
import type { WorkbenchCommand } from '../../shared/workbench-commands.js';
import { validateSampleInput } from '../../../tools/poc/protocol-probe.js';
import { parseAnswerInput, parseReadConfirmation, parseSendText, requireBoolean } from '../security/workbench-input.js';
import { parseGoalActionInput, parseSelectModelInput } from '../security/native-input.js';
import { parseFilePathRead, parseFileReadScope } from '../security/file-input.js';
import { parseJobReadScope, parseJobViewRead } from '../security/job-input.js';
import { AuthService } from '../auth/auth-service.js';
import type { BasicAuthBroker } from '../auth/basic-auth-broker.js';
import type { CredentialStore } from '../auth/credential-store.js';
import { promptCredential } from './credential-window.js';
import type { WorkbenchService } from '../state/workbench-service.js';
import { IpcRegistry } from '../security/ipc-registry.js';
import { SessionWebView } from './session-web-view.js';
import type { BackgroundService } from '../appearance/background-service.js';
import type { WebLayoutSnapshots } from '../browser/web-layout-snapshot.js';
import { localWebPreferences } from './security-options.js';
import { showLicenses } from '../legal/license-service.js';
import type { WindowAssets } from './window-assets.js';
import type { DiagnosticLogger } from '../logging/diagnostic-logger.js';

export interface MainWindowOptions {
  readonly workbench: WorkbenchService;
  readonly basicAuth: BasicAuthBroker;
  readonly diagnostics: DiagnosticLogger;
  readonly credentials: CredentialStore;
  readonly background: BackgroundService;
  readonly layouts: WebLayoutSnapshots;
  readonly windowState: WindowStateStore;
  readonly choosePetPath: (kind: 'resources', parent: BrowserWindow) => Promise<void>;
  readonly selectPet: (id: string) => Promise<void>;
  readonly rescanPets: () => Promise<void>;
}
export async function openMainWindow(assets: WindowAssets, ipc: IpcRegistry, auth: AuthService, options?: MainWindowOptions): Promise<BrowserWindow> {
  const primary = screen.getPrimaryDisplay();
  const restored = restoreWindowState(options?.windowState.get() ?? null, [primary.workArea,
    ...screen.getAllDisplays().filter(display => display.id !== primary.id).map(display => display.workArea)]);
  const window = new BrowserWindow({
    ...restored.bounds, minWidth: restored.minWidth, minHeight: restored.minHeight,
    show: false, title: options === undefined ? 'DshDeck · 只读 PoC' : 'DshDeck', autoHideMenuBar: true,
    webPreferences: localWebPreferences('dshdeck-workbench-ui', join(assets.preloadRoot, 'app-preload.cjs')),
  });
  options?.windowState.bind(window);
  if (restored.maximized) window.maximize();
  const workbench = options?.workbench;
  const web = options === undefined ? undefined : new SessionWebView(window, assets.preloadRoot, auth, options.workbench, options.basicAuth, options.diagnostics);
  const confirmWebExit = async (): Promise<boolean> => {
    const current = web?.status();
    if (current?.state === 'ready' && options !== undefined) {
      const pending = options.workbench.state.all().some(facts => facts.serverId === current.serverId && facts.pendingIds.length > 0 && (current.context === null || facts.sessionId === current.context.sessionId));
      if (pending) {
        const answer = await dialog.showMessageBox(window, { type: 'question', title: '离开原网页', message: '当前会话有待处理的问题或审批，继续离开原网页？',
          detail: '离开可能将交互交还服务端后续处理；程序不会代答或批准，也不会停止远程任务。建议先在原网页处理完成。', buttons: ['继续离开', '保留原网页'], defaultId: 1, cancelId: 1 });
        return answer.response === 0;
      }
    }
    return true;
  };
  const closeWeb = async (): Promise<boolean> => { if (!await confirmWebExit()) return false; await web?.close(); return true; };
  workbench?.setWindowState(() => ({ visible: !window.isDestroyed() && window.isVisible() && !window.isMinimized(), focused: !window.isDestroyed() && window.isFocused() }));
  const pagePath = join(assets.rendererRoot, options === undefined ? 'index.html' : 'workbench.html');
  ipc.bind(window, pathToFileURL(pagePath).href, {
    'app:list-servers': () => auth.list(),
    'app:add-server': input => auth.add(normalizeServerInput(input)),
    'app:edit-server': async (id, input) => {
      const serverId = requireId(id); const normalized = normalizeServerInput(input); const saved = auth.list().find(server => server.config.id === serverId);
      const changedIdentity = saved?.config.baseUrl !== normalized.baseUrl || (saved?.config.proxyMode ?? 'system') !== (normalized.proxyMode ?? 'system');
      if (changedIdentity && web?.status().serverId === serverId && !await closeWeb()) throw new ProtocolFault('cancelled');
      return auth.edit(serverId, normalized);
    },
    'app:connect-server': async id => { const serverId = requireId(id); if (web?.status().serverId === serverId && !await closeWeb()) throw new ProtocolFault('cancelled'); return workbench === undefined ? auth.connect(serverId) : workbench.connect(serverId); },
    'app:authenticate-server': async id => { const serverId = requireId(id); if (web?.status().serverId === serverId && !await closeWeb()) throw new ProtocolFault('cancelled'); return workbench === undefined ? auth.authenticate(serverId) : workbench.authenticate(serverId); },
    'app:disconnect-server': async id => { const serverId = requireId(id); if (web?.status().serverId === serverId && !await closeWeb()) throw new ProtocolFault('cancelled'); return workbench === undefined ? auth.disconnect(serverId) : workbench.disconnect(serverId); },
    'app:run-sample': (id, input) => { validateSampleInput(input); return auth.runSample(requireId(id), input); },
    'app:stop-sample': id => auth.stopSample(requireId(id)),
    ...(options === undefined ? {} : {
      'app:workbench': (revision: unknown) => {
        if (revision !== undefined && (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)) throw new ProtocolFault('protocol');
        return options.workbench.snapshot(revision as number | undefined);
      },
      'app:select-session': async (input: unknown) => {
        const context = parseContext(input); options.workbench.validateContext(context);
        const current = web?.status(); const target = current?.context;
        const same = target !== null && target !== undefined && target.serverId === context.serverId && target.authProfileId === context.authProfileId
          && target.generation === context.generation && target.sessionId === context.sessionId;
        if (current?.state === 'ready' && !same && !await confirmWebExit()) throw new ProtocolFault('cancelled');
        options.workbench.select(context); web?.refresh(); return options.workbench.snapshot();
      },
      'app:set-followed': (context: unknown, value: unknown) => options.workbench.setFollowed(parseContext(context), requireBoolean(value)),
      'app:set-manual-unread': (context: unknown, value: unknown) => options.workbench.setManualUnread(parseContext(context), requireBoolean(value)),
      'app:set-draft': (context: unknown, value: unknown) => { if (typeof value !== 'string') throw new ProtocolFault('protocol'); options.workbench.setDraft(parseContext(context), value); },
      'app:send-text': (input: unknown) => options.workbench.send(parseSendText(input)),
      'app:model-catalog': (context: unknown, refresh: unknown) => options.workbench.modelCatalog(parseContext(context), refresh === undefined ? false : requireBoolean(refresh)),
      'app:command-catalog': (context: unknown, refresh: unknown) => options.workbench.commandCatalog(parseContext(context), refresh === undefined ? false : requireBoolean(refresh)),
      'app:select-model': (input: unknown) => options.workbench.selectModel(parseSelectModelInput(input)),
      'app:goal-action': (input: unknown) => options.workbench.goalAction(parseGoalActionInput(input), async () => {
        const answer = await dialog.showMessageBox(window, { type: 'question', title: '清除会话目标', message: '清除当前会话的目标？',
          detail: '此操作修改服务器的目标状态，不删除会话或项目文件；不会自动停止正在运行的任务。', buttons: ['清除目标', '取消'], defaultId: 1, cancelId: 1 });
        return answer.response === 0;
      }),
      'app:execute-command': (input: unknown) => options.workbench.executeCommand(parseSendText(input), async name => {
        const answer = await dialog.showMessageBox(window, { type: 'question', title: '执行服务器命令', message: `执行 /${name} 命令？`,
          detail: '命令由服务器或插件实现，可能修改会话状态；选择菜单只填入命令，确认后才提交一次，不会因失败自动重发。', buttons: ['执行命令', '取消'], defaultId: 1, cancelId: 1 });
        return answer.response === 0;
      }),
      'app:file-workspace': (input: unknown) => options.workbench.fileWorkspace(parseFileReadScope(input)),
      'app:file-directory': (input: unknown) => options.workbench.fileDirectory(parseFilePathRead(input, true)),
      'app:file-preview': (input: unknown) => options.workbench.filePreview(parseFilePathRead(input)),
      'app:release-files': (input: unknown) => options.workbench.releaseFiles(parseFileReadScope(input)),
      'app:job-view': (input: unknown) => options.workbench.jobView(parseJobViewRead(input)),
      'app:release-jobs': (input: unknown) => options.workbench.releaseJobs(parseJobReadScope(input)),
      'app:check-network': (id: unknown) => auth.checkNetwork(requireId(id)),
      'app:stop-remote': (context: unknown) => options.workbench.stop(parseContext(context)),
      'app:answer': (input: unknown) => options.workbench.answer(parseAnswerInput(input)),
      'app:sync-now': (context: unknown) => options.workbench.syncNow(parseContext(context)),
      'app:load-older': (context: unknown) => options.workbench.loadOlder(parseContext(context)),
      'app:confirm-read': (input: unknown) => options.workbench.confirmRead(parseReadConfirmation(input)),
      'app:update-settings': async (settings: unknown, appearance: unknown) => {
        if (appearance !== undefined && parseAppearance(appearance).viewMode === 'native' && !await closeWeb()) return;
        await options.workbench.preferences.updateSettings(settings, appearance); web?.refresh(appearance !== undefined);
      },
      'app:open-fallback': async (id: unknown) => { const serverId = requireId(id); if (!await confirmWebExit()) throw new ProtocolFault('cancelled'); await web?.openServer(serverId); },
      'app:open-server-web': async (id: unknown) => { const serverId = requireId(id); if (!await confirmWebExit()) throw new ProtocolFault('cancelled'); await web?.openWholeServer(serverId); },
      'app:close-fallback': async () => { await closeWeb(); },
      'app:update-appearance': async (input: unknown) => {
        const appearance = parseAppearancePatch(input); const oldMode = options.workbench.preferences.appearance().viewMode;
        if (appearance.viewMode === 'native' && !await closeWeb()) return;
        await options.workbench.preferences.updateAppearance(appearance); web?.refresh(oldMode !== options.workbench.preferences.appearance().viewMode);
      },
      'app:choose-background': () => options.background.choose(window),
      'app:clear-background': () => options.background.clear(),
      'app:set-web-viewport': (input: unknown) => web?.setViewport(parseWebViewport(input)),
      'app:toggle-web-sidebar': () => web?.toggleSidebar(),
      'app:show-web-files': () => web?.showFiles(),
      'app:show-web-conversation': () => web?.showConversation(),
      'app:cache-web-layout': () => {
        if (web === undefined) throw new ProtocolFault('unsupported');
        const contents = web.contentsForSnapshot();
        return options.layouts.cache(contents, () => { if (web.contentsForSnapshot() !== contents) throw new ProtocolFault('cancelled'); });
      },
      'app:open-web-layouts': async () => {
        await options.layouts.ensureDirectory();
        const error = await shell.openPath(options.layouts.directory); if (error !== '') throw new ProtocolFault('not-found');
      },
      'app:command-menu': () => {
        const state = web?.status();
        return commandMenu(window, { webReady: state?.state === 'ready', webOpen: state !== undefined && state.state !== 'closed', hasServer: state?.serverId != null || options.workbench.selectedContext() !== null });
      },
      'app:choose-pet-path': (kind: unknown) => { if (kind !== 'resources') throw new ProtocolFault('protocol'); return options.choosePetPath(kind, window); },
      'app:update-pet-display': (input: unknown) => options.workbench.preferences.updatePetDisplay(input),
      'app:open-licenses': () => showLicenses(window),
      'app:select-pet': (id: unknown) => options.selectPet(requireId(id)),
      'app:rescan-pets': () => options.rescanPets(),
      'app:basic-credential-info': (id: unknown) => {
        const server = auth.list().find(server => server.config.id === requireId(id));
        if (server === undefined) throw new ProtocolFault('not-found');
        return options.credentials.info(server.config.authProfileId, new URL(server.config.baseUrl).origin);
      },
      'app:edit-basic-credentials': async (id: unknown) => {
        const serverId = requireId(id); const server = auth.list().find(server => server.config.id === serverId);
        if (server === undefined) throw new ProtocolFault('not-found');
        const origin = new URL(server.config.baseUrl).origin; const scope = options.credentials.knownScope(server.config.authProfileId, origin);
        if (scope === undefined) throw new ProtocolFault('unsupported');
        const info = options.credentials.info(server.config.authProfileId, origin);
        const value = await promptCredential(window, { origin, realm: scope.realm, username: info.username ?? '', remembered: info.remembered,
          rememberAvailable: info.rememberAvailable, saveOnly: true, usernameLocked: true }, input => options.credentials.remember(scope, input, input.remember ?? false), assets, ipc);
        if (value !== undefined) { await auth.serverSession(serverId).browserSession.clearAuthCache(); options.basicAuth.reset(server.config.authProfileId); }
      },
      'app:forget-basic-credentials': async (id: unknown) => {
        const serverId = requireId(id); const server = auth.list().find(server => server.config.id === serverId);
        if (server === undefined) throw new ProtocolFault('not-found');
        const answer = await dialog.showMessageBox(window, { type: 'question', title: '忘记 HTTP 登录信息',
          message: '删除该服务器保存的 HTTP 账号密码？', detail: '只清理该服务器的 BasicAuth 保存与认证缓存；Cookie 和其他服务器不删除。',
          buttons: ['忘记', '取消'], defaultId: 1, cancelId: 1 });
        if (answer.response !== 0) return;
        await options.credentials.forget(server.config.authProfileId);
        await auth.serverSession(serverId).browserSession.clearAuthCache(); options.basicAuth.reset(server.config.authProfileId);
      },
      'app:set-demo': (value: unknown) => options.workbench.setDemo(requireBoolean(value)),
      'app:open-logs': async () => {
        await options.diagnostics.ensureDirectory();
        const error = await shell.openPath(options.diagnostics.directory);
        if (error !== '') throw new ProtocolFault('network');
      },
      'app:copy-diagnostics': async () => clipboard.writeText(await options.diagnostics.diagnosticReport()),
      'app:renderer-failure': (input: unknown) => {
        const failure = requireRecord(input); requireKeys(failure, ['kind'], ['line', 'column']);
        if (failure.kind !== 'error' && failure.kind !== 'unhandled-rejection') throw new ProtocolFault('protocol');
        for (const key of ['line', 'column'] as const) {
          const value = failure[key];
          if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 100000000)) throw new ProtocolFault('protocol');
        }
        options.diagnostics.record('error', 'renderer-failed', { reason: failure.kind,
          ...(typeof failure.line === 'number' ? { rendererLine: failure.line } : {}),
          ...(typeof failure.column === 'number' ? { rendererColumn: failure.column } : {}),
        });
      },
    }),
  });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show(); });
  window.once('closed', () => { void web?.dispose(); workbench?.dispose(); auth.dispose(); });
  await window.loadFile(pagePath);
  return window;
}
function commandMenu(window: BrowserWindow, state: { webReady: boolean; webOpen: boolean; hasServer: boolean }): Promise<WorkbenchCommand> {
  return new Promise(resolve => {
    let picked: WorkbenchCommand = 'none'; let finished = false;
    const finish = (): void => { if (finished) return; finished = true; window.removeListener('closed', finish); resolve(picked); };
    const item = (label: string, command: WorkbenchCommand, enabled = true): MenuItemConstructorOptions => ({ label, enabled, click: () => { picked = command; } });
    const menu = Menu.buildFromTemplate([
      item('设置', 'settings'), item('添加服务器', 'add-server'), { type: 'separator' },
      item('日志', 'logs'), item('复制诊断', 'copy-diagnostics'), { type: 'separator' },
      item('缓存原网页（脱敏功能区）', 'cache-layout', state.webReady), item('打开功能区快照目录', 'layout-folder'),
      item('显示／隐藏原网页侧栏', 'toggle-web-sidebar', state.webReady), item('关闭兼容页', 'close-web', state.webOpen),
      { type: 'separator' }, item('断开服务器', 'disconnect', state.hasServer),
    ]);
    window.once('closed', finish); menu.popup({ window, callback: finish });
  });
}
