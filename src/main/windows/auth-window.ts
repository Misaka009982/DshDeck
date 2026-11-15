import { BrowserWindow, WebContentsView, dialog } from 'electron';
import type { WebContents } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ServerConfig } from '../../shared/contracts.js';
import { isHttpNavigation } from '../../shared/server-config.js';
import { ProtocolFault } from '../../shared/faults.js';
import type { AuthWindowCallbacks, AuthWindowHandle } from '../auth/auth-service.js';
import type { ServerSession } from '../auth/server-session.js';
import { BasicAuthBroker } from '../auth/basic-auth-broker.js';
import { IpcRegistry } from '../security/ipc-registry.js';
import { localWebPreferences, remoteWebPreferences } from './security-options.js';
import type { WindowAssets } from './window-assets.js';
import { closeRemotePage } from './close-remote-page.js';

/** 本地控制栏有窄 IPC；远程登录视图和 SSO 弹窗没有 preload。 */
export function openAuthWindow(
  config: ServerConfig,
  session: ServerSession,
  callbacks: AuthWindowCallbacks,
  assets: WindowAssets,
  ipc: IpcRegistry,
  basicAuth: BasicAuthBroker,
): AuthWindowHandle {
  const window = new BrowserWindow({
    width: 1000, height: 760, minWidth: 760, minHeight: 520,
    show: false, autoHideMenuBar: true, title: `登录 · ${config.alias}`,
    webPreferences: localWebPreferences('dshdeck-auth-ui', join(assets.preloadRoot, 'auth-preload.cjs')),
  });
  const view = new WebContentsView({ webPreferences: remoteWebPreferences(session.partition) });
  const popups = new Set<BrowserWindow>();
  const allowedOrigins = new Set([new URL(config.baseUrl).origin]);
  const pendingOrigins = new Set<string>();
  let completed = false;
  const pagePath = join(assets.rendererRoot, 'auth.html');
  window.contentView.addChildView(view);
  const layout = (): void => {
    if (window.isDestroyed() || view.webContents.isDestroyed()) return;
    const { width, height } = window.getContentBounds();
    view.setBounds({ x: 0, y: 146, width, height: Math.max(0, height - 146) });
  };
  window.on('resize', layout);
  layout();

  const endRemotePage = async (): Promise<void> => {
    for (const popup of popups) if (!popup.isDestroyed()) popup.destroy();
    popups.clear();
    if (!view.webContents.isDestroyed()) {
      if (!window.isDestroyed()) window.contentView.removeChildView(view);
      await closeRemotePage(view.webContents);
    }
  };
  const cancel = (): void => {
    if (completed) return;
    completed = true;
    const stopped = endRemotePage();
    if (!window.isDestroyed()) window.destroy();
    void stopped.then(() => callbacks.cancelled(), () => callbacks.cancelled());
  };

  const approveOrigin = async (url: string): Promise<boolean> => {
    if (!isHttpNavigation(url) || completed || window.isDestroyed()) return false;
    const origin = new URL(url).origin;
    if (allowedOrigins.has(origin)) return true;
    if (pendingOrigins.has(origin)) return false;
    pendingOrigins.add(origin);
    try {
      const result = await dialog.showMessageBox(window, {
        type: 'question', title: '确认登录跳转',
        message: `允许此次认证访问 ${origin}？`,
        detail: '只授权该登录目标，不共享本地工作台 IPC 或其他服务器的登录态。',
        buttons: ['允许', '取消'], defaultId: 1, cancelId: 1,
      });
      if (result.response !== 0 || completed) return false;
      allowedOrigins.add(origin);
      return true;
    } finally { pendingOrigins.delete(origin); }
  };

  const protectRemote = (contents: WebContents, parent: BrowserWindow): void => {
    basicAuth.bind(contents, parent, config.authProfileId, allowedOrigins);
    const navigate = (event: { preventDefault(): void }, url: string): void => {
      if (isHttpNavigation(url) && allowedOrigins.has(new URL(url).origin)) return;
      event.preventDefault();
      void approveOrigin(url).then(allowed => {
        if (allowed && !completed && !contents.isDestroyed()) void contents.loadURL(url).catch(() => {});
      });
    };
    contents.on('will-navigate', navigate);
    contents.on('will-redirect', navigate);
    contents.setWindowOpenHandler(({ url }) => {
      if (completed) return { action: 'deny' };
      if (!isHttpNavigation(url) || !allowedOrigins.has(new URL(url).origin)) {
        void approveOrigin(url).then(async allowed => {
          if (allowed && !window.isDestroyed() && !completed) await dialog.showMessageBox(window, {
            type: 'info', message: '登录目标已允许，请再次点击登录页面的弹窗按钮。', buttons: ['确定'],
          });
        });
        return { action: 'deny' };
      }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent, width: 820, height: 680, autoHideMenuBar: true,
          webPreferences: remoteWebPreferences(session.partition),
        },
      };
    });
    contents.on('did-create-window', popup => {
      if (completed) { popup.destroy(); return; }
      popups.add(popup);
      protectRemote(popup.webContents, popup);
      popup.once('closed', () => popups.delete(popup));
    });
    contents.on('will-attach-webview', event => event.preventDefault());
  };
  protectRemote(view.webContents, window);
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  ipc.bind(window, pathToFileURL(pagePath).href, {
    'auth:describe': () => ({ alias: config.alias, baseUrl: config.baseUrl }),
    'auth:navigate': async value => {
      if (typeof value !== 'string' || value.length > 8192 || !isHttpNavigation(value)) throw new ProtocolFault('protocol');
      // 一次性启动链接仅在此处使用，不保存、不回传主 UI、不拼到 API/WS。
      if (!await approveOrigin(value)) throw new ProtocolFault('cancelled');
      basicAuth.reset(config.authProfileId);
      if (completed || view.webContents.isDestroyed()) throw new ProtocolFault('cancelled');
      await view.webContents.loadURL(value).catch(() => { throw new ProtocolFault('network'); });
    },
    'auth:finish': async () => {
      if (completed) throw new ProtocolFault('cancelled');
      completed = true;
      await endRemotePage();
      if (!window.isDestroyed()) window.destroy();
      await callbacks.finished();
    },
    'auth:cancel': () => cancel(),
  });
  window.once('close', cancel);
  window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show(); });
  void window.loadFile(pagePath).catch(cancel);
  void view.webContents.loadURL(config.baseUrl).catch(() => {});
  return {
    focus: () => { if (!window.isDestroyed()) { window.show(); window.focus(); } },
    close: cancel,
  };
}
