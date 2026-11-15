import { BrowserWindow, WebContentsView, dialog } from 'electron';
import type { ServerConfig } from '../../shared/contracts.js';
import type { ServerSession } from '../auth/server-session.js';
import type { BasicAuthBroker } from '../auth/basic-auth-broker.js';
import { isHttpNavigation } from '../../shared/server-config.js';
import { remoteWebPreferences } from './security-options.js';
import { closeRemotePage } from './close-remote-page.js';

/** 兼容路径由用户明确选择；原网页独立无 IPC，不被当作原生聚合完成。 */
export class FallbackView {
  private current: { serverId: string; window: BrowserWindow; view: WebContentsView; release: () => void } | undefined;
  constructor(private readonly parent: BrowserWindow, private readonly basicAuth: BasicAuthBroker,
    private readonly suspend: (serverId: string) => void, private readonly resume: (serverId: string) => void) {}
  async open(config: ServerConfig, session: ServerSession): Promise<void> {
    if (this.current?.serverId === config.id && !this.current.window.isDestroyed()) { this.current.window.focus(); return; }
    const answer = await dialog.showMessageBox(this.parent, {
      type: 'question', title: '打开兼容网页', message: `打开 ${config.alias} 的原始 dsh 页面？`,
      detail: '兼容网页会使用原站点自己的实时传输和交互；其初始化行为不属于 DshDeck 被动读取保证。原生正文同步会暂停，关闭后恢复。',
      buttons: ['打开', '取消'], defaultId: 1, cancelId: 1,
    });
    if (answer.response !== 0 || this.parent.isDestroyed()) return;
    await this.close();
    this.suspend(config.id);
    const window = new BrowserWindow({ width: 1120, height: 820, minWidth: 760, minHeight: 520, parent: this.parent, autoHideMenuBar: true,
      title: `兼容网页 · ${config.alias}`, webPreferences: remoteWebPreferences(session.partition) });
    const view = new WebContentsView({ webPreferences: remoteWebPreferences(session.partition) });
    const release = session.allowCompatibilityContents(view.webContents.id);
    const origin = new URL(config.baseUrl).origin;
    this.basicAuth.bind(view.webContents, window, config.authProfileId, new Set([origin]));
    const navigation = (event: { preventDefault(): void }, url: string): void => { if (!isHttpNavigation(url) || new URL(url).origin !== origin) event.preventDefault(); };
    view.webContents.on('will-navigate', navigation); view.webContents.on('will-redirect', navigation);
    view.webContents.on('will-attach-webview', event => event.preventDefault());
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.contentView.addChildView(view);
    const layout = (): void => { if (!window.isDestroyed()) { const { width, height } = window.getContentBounds(); view.setBounds({ x: 0, y: 0, width, height }); } };
    window.on('resize', layout); layout();
    const current = { serverId: config.id, window, view, release }; this.current = current;
    window.once('closed', () => {
      release();
      void closeRemotePage(view.webContents).finally(() => {
        if (this.current === current) { this.current = undefined; this.resume(config.id); }
      });
    });
    await session.ready();
    await view.webContents.loadURL(config.baseUrl).catch(() => {});
  }
  async close(): Promise<void> {
    const current = this.current; if (current === undefined) return;
    this.current = undefined; current.release();
    if (!current.window.isDestroyed()) current.window.contentView.removeChildView(current.view);
    await closeRemotePage(current.view.webContents);
    if (!current.window.isDestroyed()) current.window.destroy();
    this.resume(current.serverId);
  }
}
