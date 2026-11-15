import { BrowserWindow } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ProtocolFault, requireKeys, requireRecord } from '../../shared/faults.js';
import type { CredentialInput } from '../../shared/contracts.js';
import { IpcRegistry } from '../security/ipc-registry.js';
import { localWebPreferences } from './security-options.js';
import type { WindowAssets } from './window-assets.js';

/** 提示窗是独立本地页面，密码不会进入工作台 renderer。 */
export function promptCredential(
  parent: BrowserWindow,
  description: { origin: string; realm: string },
  accept: (input: CredentialInput) => void,
  assets: WindowAssets,
  ipc: IpcRegistry,
): Promise<CredentialInput | undefined> {
  return new Promise(resolve => {
    let settled = false;
    const window = new BrowserWindow({
      width: 440, height: 390, resizable: false, parent, modal: true,
      show: false, autoHideMenuBar: true, title: '服务器登录',
      webPreferences: localWebPreferences('dshdeck-credential-ui', join(assets.preloadRoot, 'credential-preload.cjs')),
    });
    const pagePath = join(assets.rendererRoot, 'credential.html');
    const finish = (input?: CredentialInput): void => {
      if (settled) return;
      settled = true;
      parent.removeListener('closed', cancelled);
      resolve(input);
      if (!window.isDestroyed()) window.destroy();
    };
    const cancelled = (): void => finish();
    ipc.bind(window, pathToFileURL(pagePath).href, {
      'credential:describe': () => ({ ...description }),
      'credential:submit': value => {
        const record = requireRecord(value);
        requireKeys(record, ['username', 'password']);
        if (typeof record.username !== 'string' || typeof record.password !== 'string') throw new ProtocolFault('protocol');
        const input = { username: record.username, password: record.password };
        accept(input);
        finish(input);
      },
      'credential:cancel': () => finish(),
    });
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show(); });
    window.once('closed', cancelled);
    parent.once('closed', cancelled);
    void window.loadFile(pagePath).catch(cancelled);
  });
}
