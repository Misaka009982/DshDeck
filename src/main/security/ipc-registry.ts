import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { ProtocolFault, toPublicFailure } from '../../shared/faults.js';
import { isTrustedIpcSender } from './ipc-policy.js';
import type { DiagnosticLogger } from '../logging/diagnostic-logger.js';

export const IPC_CHANNELS = [
  'app:list-servers', 'app:add-server', 'app:edit-server', 'app:connect-server',
  'app:authenticate-server', 'app:disconnect-server', 'app:run-sample', 'app:stop-sample',
  'app:workbench', 'app:select-session', 'app:set-followed', 'app:set-manual-unread', 'app:set-draft',
  'app:send-text', 'app:model-catalog', 'app:command-catalog', 'app:select-model', 'app:goal-action', 'app:execute-command', 'app:file-workspace', 'app:file-directory', 'app:file-preview', 'app:release-files', 'app:job-view', 'app:release-jobs', 'app:check-network', 'app:stop-remote', 'app:answer', 'app:sync-now', 'app:load-older', 'app:confirm-read',
  'app:update-settings', 'app:update-pet-display', 'app:open-licenses', 'app:open-fallback', 'app:close-fallback', 'app:choose-pet-path', 'app:select-pet', 'app:rescan-pets', 'app:set-demo',
  'app:open-logs', 'app:copy-diagnostics', 'app:renderer-failure',
  'app:basic-credential-info', 'app:edit-basic-credentials', 'app:forget-basic-credentials',
  'app:update-appearance', 'app:choose-background', 'app:clear-background', 'app:set-web-viewport',
  'app:cache-web-layout', 'app:command-menu', 'app:toggle-web-sidebar', 'app:show-web-files', 'app:show-web-conversation', 'app:open-web-layouts', 'app:open-server-web',
  'auth:describe', 'auth:page-state', 'auth:navigate', 'auth:finish', 'auth:cancel',
  'credential:describe', 'credential:submit', 'credential:cancel',
  'pet:ready', 'pet:mouse-interactive', 'pet:action',
] as const;
export type IpcChannel = typeof IPC_CHANNELS[number];
export type IpcHandlers = Partial<Record<IpcChannel, (...args: unknown[]) => unknown>>;
const QUIET_CHANNELS = new Set<IpcChannel>(['pet:ready', 'pet:mouse-interactive', 'app:workbench', 'app:list-servers', 'app:set-draft', 'app:confirm-read', 'app:renderer-failure', 'app:basic-credential-info', 'app:set-web-viewport', 'app:release-files', 'app:job-view', 'app:release-jobs', 'auth:describe', 'auth:page-state', 'credential:describe']);
interface Binding {
  readonly pageUrl: string;
  readonly handlers: IpcHandlers;
}

/** IPC 按具体本地窗口绑定；远程 WebContentsView 与子框架没有绑定。 */
export class IpcRegistry {
  private readonly bindings = new Map<number, Binding>();

  constructor(private readonly logger?: DiagnosticLogger) {
    for (const channel of IPC_CHANNELS) ipcMain.handle(channel, (event, ...args: unknown[]) => this.invoke(event, channel, args));
  }

  bind(window: BrowserWindow, pageUrl: string, handlers: IpcHandlers): void {
    const id = window.webContents.id;
    this.bindings.set(id, { pageUrl, handlers });
    window.once('closed', () => this.bindings.delete(id));
  }

  dispose(): void {
    for (const channel of IPC_CHANNELS) ipcMain.removeHandler(channel);
    this.bindings.clear();
  }

  private async invoke(event: IpcMainInvokeEvent, channel: IpcChannel, args: unknown[]): Promise<unknown> {
    try {
      const binding = this.bindings.get(event.sender.id);
      if (binding === undefined || event.senderFrame === null || !isTrustedIpcSender({
        webContentsId: event.sender.id,
        frameUrl: event.senderFrame.url,
        isMainFrame: event.senderFrame === event.sender.mainFrame,
      }, { webContentsId: event.sender.id, pageUrl: binding.pageUrl })) throw new ProtocolFault('forbidden');
      const handler = binding.handlers[channel];
      if (handler === undefined) throw new ProtocolFault('forbidden');
      const value = await handler(...args);
      // 不记录参数、返回值和轮询成功；凭据与正文始终留在各自权限边界。
      if (!QUIET_CHANNELS.has(channel)) this.logger?.record('info', 'ipc-complete', { operation: channel });
      return { ok: true, value };
    } catch (error) {
      this.logger?.fault('ipc-failed', error, { operation: channel });
      return { ok: false, error: toPublicFailure(error) };
    }
  }
}
