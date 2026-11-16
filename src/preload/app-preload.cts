import { contextBridge, ipcRenderer } from 'electron';
import type { AppBridge, IpcResult } from '../shared/contracts.js';

// sandbox preload 只依赖 electron，不 require 本地业务模块。
function invoke<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  return ipcRenderer.invoke(channel, ...args).catch(() => ({
    ok: false, error: { kind: 'network', message: '本地受限接口暂不可用。' },
  })) as Promise<IpcResult<T>>;
}
const bridge: AppBridge = {
  listServers: () => invoke('app:list-servers'),
  addServer: input => invoke('app:add-server', input),
  editServer: (id, input) => invoke('app:edit-server', id, input),
  connectServer: id => invoke('app:connect-server', id),
  authenticateServer: id => invoke('app:authenticate-server', id),
  disconnectServer: id => invoke('app:disconnect-server', id),
  runSample: (id, input) => invoke('app:run-sample', id, input),
  stopSample: id => invoke('app:stop-sample', id),
  workbench: revision => invoke('app:workbench', revision),
  selectSession: context => invoke('app:select-session', context),
  setFollowed: (context, followed) => invoke('app:set-followed', context, followed),
  setManualUnread: (context, unread) => invoke('app:set-manual-unread', context, unread),
  setDraft: (context, text) => invoke('app:set-draft', context, text),
  sendText: input => invoke('app:send-text', input),
  modelCatalog: (context, refresh) => invoke('app:model-catalog', context, refresh),
  commandCatalog: (context, refresh) => invoke('app:command-catalog', context, refresh),
  selectModel: input => invoke('app:select-model', input),
  goalAction: input => invoke('app:goal-action', input),
  executeCommand: input => invoke('app:execute-command', input),
  stopRemote: context => invoke('app:stop-remote', context),
  answer: input => invoke('app:answer', input),
  syncNow: context => invoke('app:sync-now', context),
  loadOlder: context => invoke('app:load-older', context),
  confirmRead: input => invoke('app:confirm-read', input),
  updateSettings: (settings, appearance) => invoke('app:update-settings', settings, appearance),
  openFallback: id => invoke('app:open-fallback', id),
  openWholeServer: id => invoke('app:open-server-web', id),
  closeFallback: () => invoke('app:close-fallback'),
  choosePetPath: kind => invoke('app:choose-pet-path', kind),
  selectPet: id => invoke('app:select-pet', id),
  rescanPets: () => invoke('app:rescan-pets'),
  basicCredentialInfo: id => invoke('app:basic-credential-info', id),
  editBasicCredentials: id => invoke('app:edit-basic-credentials', id),
  forgetBasicCredentials: id => invoke('app:forget-basic-credentials', id),
  updateAppearance: input => invoke('app:update-appearance', input),
  chooseBackground: () => invoke('app:choose-background'),
  clearBackground: () => invoke('app:clear-background'),
  setWebViewport: input => invoke('app:set-web-viewport', input),
  cacheWebLayout: () => invoke('app:cache-web-layout'),
  openCommandMenu: () => invoke('app:command-menu'),
  toggleWebSidebar: () => invoke('app:toggle-web-sidebar'),
  showWebFiles: () => invoke('app:show-web-files'),
  showWebConversation: () => invoke('app:show-web-conversation'),
  openWebLayouts: () => invoke('app:open-web-layouts'),
  setDemo: enabled => invoke('app:set-demo', enabled),
  openLogs: () => invoke('app:open-logs'),
  copyDiagnostics: () => invoke('app:copy-diagnostics'),
  reportRendererFailure: input => invoke('app:renderer-failure', input),
  onOpenSettings: listener => {
    const receive = (): void => listener();
    ipcRenderer.on('app:open-settings', receive);
    return () => { ipcRenderer.removeListener('app:open-settings', receive); };
  },
};
contextBridge.exposeInMainWorld('dshDeck', Object.freeze(bridge));
