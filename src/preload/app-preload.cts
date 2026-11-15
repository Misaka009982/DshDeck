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
  stopRemote: context => invoke('app:stop-remote', context),
  answer: input => invoke('app:answer', input),
  syncNow: context => invoke('app:sync-now', context),
  loadOlder: context => invoke('app:load-older', context),
  confirmRead: input => invoke('app:confirm-read', input),
  updateSettings: settings => invoke('app:update-settings', settings),
  openFallback: id => invoke('app:open-fallback', id),
  closeFallback: () => invoke('app:close-fallback'),
  choosePetPath: kind => invoke('app:choose-pet-path', kind),
  setDemo: enabled => invoke('app:set-demo', enabled),
  onOpenSettings: listener => {
    const receive = (): void => listener();
    ipcRenderer.on('app:open-settings', receive);
    return () => { ipcRenderer.removeListener('app:open-settings', receive); };
  },
};
contextBridge.exposeInMainWorld('dshDeck', Object.freeze(bridge));
