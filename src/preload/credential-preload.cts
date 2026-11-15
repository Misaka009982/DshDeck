import { contextBridge, ipcRenderer } from 'electron';
import type { CredentialBridge, IpcResult } from '../shared/contracts.js';

function invoke<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  return ipcRenderer.invoke(channel, ...args).catch(() => ({
    ok: false, error: { kind: 'network', message: '认证提示窗已结束或接口不可用。' },
  })) as Promise<IpcResult<T>>;
}
const bridge: CredentialBridge = {
  describe: () => invoke('credential:describe'),
  submit: input => invoke('credential:submit', input),
  cancel: () => invoke('credential:cancel'),
};
contextBridge.exposeInMainWorld('dshDeckCredential', Object.freeze(bridge));
