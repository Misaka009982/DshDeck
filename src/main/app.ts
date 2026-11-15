import { app, clipboard, dialog } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServerStore } from './config/server-store.js';
import { CredentialStore } from './auth/credential-store.js';
import { ServerSession } from './auth/server-session.js';
import { AuthService } from './auth/auth-service.js';
import { BasicAuthBroker } from './auth/basic-auth-broker.js';
import { IpcRegistry } from './security/ipc-registry.js';
import { Preferences } from './storage/preferences.js';
import { WorkbenchService } from './state/workbench-service.js';
import { PetCompanion } from './pet/pet-companion.js';
import { NotificationService } from './notifications/notification-service.js';
import { preferenceKey } from '../shared/domain.js';
import { ProtocolFault } from '../shared/faults.js';
import { openMainWindow } from './windows/main-window.js';
import { openAuthWindow } from './windows/auth-window.js';
import type { WindowAssets } from './windows/window-assets.js';
import { DiagnosticLogger } from './logging/diagnostic-logger.js';

app.setName('DshDeck');
const diagnostics = new DiagnosticLogger(join(app.getPath('userData'), 'logs'), {
  appVersion: app.getVersion(), electronVersion: process.versions.electron ?? 'unknown',
  nodeVersion: process.versions.node, chromeVersion: process.versions.chrome ?? 'unknown',
  platform: process.platform, arch: process.arch,
});
diagnostics.record('info', 'app-start');
process.on('uncaughtExceptionMonitor', error => diagnostics.emergency('main-fatal', error));
app.on('render-process-gone', (_event, contents, details) => diagnostics.record('error', 'renderer-gone', {
  viewType: contents.getType(), reason: details.reason, exitCode: details.exitCode,
}));
app.on('child-process-gone', (_event, details) => diagnostics.record('warn', 'child-process-gone', {
  processType: details.type, reason: details.reason, exitCode: details.exitCode,
}));
app.on('web-contents-created', (_event, contents) => {
  contents.on('preload-error', (_event, _preloadPath, error) => diagnostics.fault('renderer-failed', error, { reason: 'preload-error', viewType: contents.getType() }));
  contents.on('did-fail-load', (_event, errorCode, _description, _url, mainFrame) => {
    if (errorCode !== -3) diagnostics.record('warn', 'page-load-failed', { viewType: contents.getType(), errorCode, mainFrame });
  });
});
let auth: AuthService | undefined;
let workbench: WorkbenchService | undefined;
let ipc: IpcRegistry | undefined;
let credentials: CredentialStore | undefined;
let unsubscribeAuthLogs: (() => void) | undefined;
let closing = false;
let finalLogFlushed = false;
// 安装包只包含正式工作台；只读 PoC 继续保留为本地开发入口。
const poc = !app.isPackaged && process.argv.includes('--poc');

void app.whenReady().then(async () => {
  const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const assets: WindowAssets = {
    rendererRoot: join(projectRoot, 'src', 'renderer'),
    preloadRoot: fileURLToPath(new URL('../preload/', import.meta.url)),
  };
  const registry = new IpcRegistry(diagnostics); ipc = registry;
  const store = new CredentialStore(); credentials = store;
  const basicAuth = new BasicAuthBroker(store, assets, registry);
  const service = new AuthService(
    new ServerStore(join(app.getPath('userData'), 'servers.json')),
    config => new ServerSession(config, store, diagnostics),
    (config, session, callbacks) => openAuthWindow(config, session, callbacks, assets, registry, basicAuth, diagnostics),
    poc ? undefined : (session, generation, signal, failed) => {
      if (workbench === undefined) throw new ProtocolFault('unsupported');
      return workbench.createAdapter(session, generation, signal, failed);
    },
  );
  auth = service;
  const connectionStates = new Map<string, string>();
  unsubscribeAuthLogs = service.subscribe(() => {
    for (const server of service.list()) {
      const signature = JSON.stringify([server.generation, server.state, server.failure?.kind]);
      if (connectionStates.get(server.config.id) === signature) continue;
      connectionStates.set(server.config.id, signature);
      diagnostics.record(server.failure === null ? 'info' : 'warn', 'connection-state', {
        serverId: server.config.id, generation: server.generation, state: server.state,
        workspaceCount: server.workspaces.length, sessionCount: server.sessions.length,
        ...(server.failure === null ? {} : { failureKind: server.failure.kind }),
      });
    }
  });
  if (!poc) {
    const preferences = new Preferences(join(app.getPath('userData'), 'preferences.json'), () => workbench?.preferencesChanged());
    workbench = new WorkbenchService(service, preferences, diagnostics);
    await workbench.initialize();
  }
  await service.initialize();
  if (poc || workbench === undefined) { await openMainWindow(assets, registry, service); diagnostics.record('info', 'app-ready'); return; }
  const deck = workbench;
  let pet: PetCompanion | undefined;
  const window = await openMainWindow(assets, registry, service, { workbench: deck, basicAuth, diagnostics,
    choosePetPath: async (kind, parent) => { if (pet === undefined) throw new ProtocolFault('unsupported'); await pet.choosePath(kind, parent); },
  });
  const reveal = (): void => { if (!window.isDestroyed()) { window.show(); window.focus(); } };
  pet = new PetCompanion(deck.preferences, {
    changed: () => deck.refreshPresentation(),
    jump: task => { deck.validateScope(task.serverId, task.authProfileId, task.generation); deck.jump(task.serverId, task.sessionId); reveal(); },
    clear: async task => { if (task.resultId === null) throw new ProtocolFault('cancelled'); await deck.clearResult(task.serverId, task.sessionId, task.resultId); },
    openSettings: () => { reveal(); if (!window.isDestroyed()) window.webContents.send('app:open-settings'); },
  });
  deck.attachPet(pet);
  deck.attachNotifications(new NotificationService({
    enabled: () => deck.preferences.settings().notifications,
    visible: () => !window.isDestroyed() && window.isVisible() && !window.isMinimized() && window.isFocused(),
    selectedTaskId: () => { const selected = deck.selectedContext(); return selected === null ? null : preferenceKey(selected.serverId, selected.authProfileId, selected.sessionId); },
    jump: task => { deck.validateScope(task.serverId, task.authProfileId, task.generation); deck.jump(task.serverId, task.sessionId); reveal(); },
    petNotice: notice => pet?.notify(notice),
  }));
  await pet.setEnabled(deck.preferences.settings().petEnabled);
  diagnostics.record('info', 'app-ready');
}).catch(error => {
  diagnostics.emergency('startup-failed', error);
  const response = dialog.showMessageBoxSync({ type: 'error', title: 'DshDeck 初始化失败',
    message: '初始化失败，已生成脱敏诊断信息。',
    detail: '可复制诊断后反馈。报告不含认证材料、服务器地址或对话正文，本次不会自动创建远程任务。',
    buttons: ['复制诊断并关闭', '关闭'], defaultId: 0, cancelId: 1,
  });
  if (response === 0) clipboard.writeText(diagnostics.diagnosticText());
  app.quit();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (finalLogFlushed) return;
  event.preventDefault();
  if (closing) return;
  closing = true;
  unsubscribeAuthLogs?.();
  workbench?.dispose(); auth?.dispose(); ipc?.dispose();
  if (auth !== undefined && credentials !== undefined) for (const server of auth.list()) credentials.clear(server.config.authProfileId);
  diagnostics.record('info', 'app-quitting');
  void diagnostics.flush().then(() => { finalLogFlushed = true; app.quit(); });
});
