import { app, dialog } from 'electron';
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

app.setName('DshDeck');
let auth: AuthService | undefined;
let workbench: WorkbenchService | undefined;
let ipc: IpcRegistry | undefined;
let credentials: CredentialStore | undefined;
// 安装包只包含正式工作台；只读 PoC 继续保留为本地开发入口。
const poc = !app.isPackaged && process.argv.includes('--poc');

void app.whenReady().then(async () => {
  const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const assets: WindowAssets = {
    rendererRoot: join(projectRoot, 'src', 'renderer'),
    preloadRoot: fileURLToPath(new URL('../preload/', import.meta.url)),
  };
  const registry = new IpcRegistry(); ipc = registry;
  const store = new CredentialStore(); credentials = store;
  const basicAuth = new BasicAuthBroker(store, assets, registry);
  const service = new AuthService(
    new ServerStore(join(app.getPath('userData'), 'servers.json')),
    config => new ServerSession(config, store),
    (config, session, callbacks) => openAuthWindow(config, session, callbacks, assets, registry, basicAuth),
    poc ? undefined : (session, generation, signal, failed) => {
      if (workbench === undefined) throw new ProtocolFault('unsupported');
      return workbench.createAdapter(session, generation, signal, failed);
    },
  );
  auth = service;
  if (!poc) {
    const preferences = new Preferences(join(app.getPath('userData'), 'preferences.json'), () => workbench?.preferencesChanged());
    workbench = new WorkbenchService(service, preferences);
    await workbench.initialize();
  }
  await service.initialize();
  if (poc || workbench === undefined) { await openMainWindow(assets, registry, service); return; }
  const deck = workbench;
  let pet: PetCompanion | undefined;
  const window = await openMainWindow(assets, registry, service, { workbench: deck, basicAuth,
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
}).catch(() => {
  dialog.showErrorBox('DshDeck 初始化失败', '请检查构建产物、已准备的依赖和非敏感配置。错误不会回显认证材料，本次不会自动创建远程任务。');
  app.quit();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  workbench?.dispose(); auth?.dispose(); ipc?.dispose();
  if (auth !== undefined && credentials !== undefined) for (const server of auth.list()) credentials.clear(server.config.authProfileId);
});
