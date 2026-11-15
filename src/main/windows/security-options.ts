import type { WebPreferences } from 'electron';

/** 默认远程内容不装工作台 preload；专用定位观察器只能在隔离世界读写固定导航键。 */
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
