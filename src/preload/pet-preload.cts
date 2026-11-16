// SPDX-License-Identifier: AGPL-3.0-or-later
// 移植自 CLI-Manager/pet-e/src/preload.cts，2026-11-16 改为 DshDeck 独立宠物视图；许可与原作者权利见 NOTICE.txt 和 LICENSE。
import type { IpcResult } from '../shared/contracts.js';
import type { PetBridge, PetViewConfig, PetViewSnapshot } from '../shared/pet-view.js';
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');
function invoke<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  return ipcRenderer.invoke(channel, ...args).catch(() => ({ ok: false, error: { kind: 'network', message: '宠物本地接口暂不可用。' } })) as Promise<IpcResult<T>>;
}
function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const receive = (_event: Electron.IpcRendererEvent, value: T): void => listener(value);
  ipcRenderer.on(channel, receive); return () => ipcRenderer.removeListener(channel, receive);
}
const bridge: PetBridge = {
  ready: () => invoke('pet:ready'), setMouseInteractive: value => invoke('pet:mouse-interactive', value), action: value => invoke('pet:action', value),
  onConfig: listener => subscribe<PetViewConfig>('pet:config', listener), onSnapshot: listener => subscribe<PetViewSnapshot>('pet:snapshot', listener),
};
contextBridge.exposeInMainWorld('dshDeckPet', Object.freeze(bridge));
