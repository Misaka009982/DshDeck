import type { WebPreferences } from 'electron';

/** 远程内容没有任何本地 IPC preload，也不能取得 Node 或弱化的浏览器权限。 */
export function remoteWebPreferences(partition: string): WebPreferences {
  return {
    partition,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    navigateOnDragDrop: false,
    spellcheck: false,
  };
}

export function localWebPreferences(partition: string, preload: string): WebPreferences {
  return { ...remoteWebPreferences(partition), preload };
}
