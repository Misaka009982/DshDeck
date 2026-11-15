import { contextBridge, ipcRenderer } from 'electron';
import type { AuthBridge, IpcResult } from '../shared/contracts.js';

function invoke<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  return ipcRenderer.invoke(channel, ...args).catch(() => ({
    ok: false, error: { kind: 'network', message: '认证控制页已结束或接口不可用。' },
  })) as Promise<IpcResult<T>>;
}
const bridge: AuthBridge = {
  describe: () => invoke('auth:describe'),
  navigate: url => invoke('auth:navigate', url),
  finish: () => invoke('auth:finish'),
  cancel: () => invoke('auth:cancel'),
};
contextBridge.exposeInMainWorld('dshDeckAuth', Object.freeze(bridge));
