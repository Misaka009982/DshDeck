import { BrowserWindow, clipboard, shell } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ProtocolFault, requireId, requireKeys, requireRecord } from '../../shared/faults.js';
import { normalizeServerInput } from '../../shared/server-config.js';
import { parseContext } from '../../shared/domain.js';
import { validateSampleInput } from '../../../tools/poc/protocol-probe.js';
import { parseAnswerInput, parseReadConfirmation, parseSendText, requireBoolean } from '../security/workbench-input.js';
import { AuthService } from '../auth/auth-service.js';
import type { BasicAuthBroker } from '../auth/basic-auth-broker.js';
import type { WorkbenchService } from '../state/workbench-service.js';
import { IpcRegistry } from '../security/ipc-registry.js';
import { FallbackView } from './fallback-view.js';
import { localWebPreferences } from './security-options.js';
import type { WindowAssets } from './window-assets.js';
import type { DiagnosticLogger } from '../logging/diagnostic-logger.js';

export interface MainWindowOptions {
  readonly workbench: WorkbenchService;
  readonly basicAuth: BasicAuthBroker;
  readonly diagnostics: DiagnosticLogger;
  readonly choosePetPath: (kind: 'runtime' | 'resources', parent: BrowserWindow) => Promise<void>;
}
export async function openMainWindow(assets: WindowAssets, ipc: IpcRegistry, auth: AuthService, options?: MainWindowOptions): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1280, height: 860, minWidth: 860, minHeight: 620,
    show: false, title: options === undefined ? 'DshDeck · 只读 PoC' : 'DshDeck', autoHideMenuBar: true,
    webPreferences: localWebPreferences('dshdeck-workbench-ui', join(assets.preloadRoot, 'app-preload.cjs')),
  });
  const workbench = options?.workbench;
  const fallback = options === undefined ? undefined : new FallbackView(window, options.basicAuth,
    id => workbench?.suspendServerDetails(id), id => workbench?.resumeServerDetails(id));
  workbench?.setWindowState(() => ({ visible: !window.isDestroyed() && window.isVisible() && !window.isMinimized(), focused: !window.isDestroyed() && window.isFocused() }));
  const pagePath = join(assets.rendererRoot, options === undefined ? 'index.html' : 'workbench.html');
  ipc.bind(window, pathToFileURL(pagePath).href, {
    'app:list-servers': () => auth.list(),
    'app:add-server': input => auth.add(normalizeServerInput(input)),
    'app:edit-server': (id, input) => auth.edit(requireId(id), normalizeServerInput(input)),
    'app:connect-server': id => workbench === undefined ? auth.connect(requireId(id)) : workbench.connect(requireId(id)),
    'app:authenticate-server': id => workbench === undefined ? auth.authenticate(requireId(id)) : workbench.authenticate(requireId(id)),
    'app:disconnect-server': id => workbench === undefined ? auth.disconnect(requireId(id)) : workbench.disconnect(requireId(id)),
    'app:run-sample': (id, input) => { validateSampleInput(input); return auth.runSample(requireId(id), input); },
    'app:stop-sample': id => auth.stopSample(requireId(id)),
    ...(options === undefined ? {} : {
      'app:workbench': (revision: unknown) => {
        if (revision !== undefined && (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)) throw new ProtocolFault('protocol');
        return options.workbench.snapshot(revision as number | undefined);
      },
      'app:select-session': (context: unknown) => options.workbench.select(parseContext(context)),
      'app:set-followed': (context: unknown, value: unknown) => options.workbench.setFollowed(parseContext(context), requireBoolean(value)),
      'app:set-manual-unread': (context: unknown, value: unknown) => options.workbench.setManualUnread(parseContext(context), requireBoolean(value)),
      'app:set-draft': (context: unknown, value: unknown) => { if (typeof value !== 'string') throw new ProtocolFault('protocol'); options.workbench.setDraft(parseContext(context), value); },
      'app:send-text': (input: unknown) => options.workbench.send(parseSendText(input)),
      'app:stop-remote': (context: unknown) => options.workbench.stop(parseContext(context)),
      'app:answer': (input: unknown) => options.workbench.answer(parseAnswerInput(input)),
      'app:sync-now': (context: unknown) => options.workbench.syncNow(parseContext(context)),
      'app:load-older': (context: unknown) => options.workbench.loadOlder(parseContext(context)),
      'app:confirm-read': (input: unknown) => options.workbench.confirmRead(parseReadConfirmation(input)),
      'app:update-settings': (settings: unknown) => options.workbench.preferences.updateSettings(settings),
      'app:open-fallback': async (id: unknown) => {
        const serverId = requireId(id);
        const server = auth.list().find(server => server.config.id === serverId);
        if (server === undefined) throw new ProtocolFault('not-found');
        await fallback?.open(server.config, auth.serverSession(serverId));
      },
      'app:close-fallback': () => fallback?.close(),
      'app:choose-pet-path': (kind: unknown) => { if (kind !== 'runtime' && kind !== 'resources') throw new ProtocolFault('protocol'); return options.choosePetPath(kind, window); },
      'app:set-demo': (value: unknown) => options.workbench.setDemo(requireBoolean(value)),
      'app:open-logs': async () => {
        await options.diagnostics.ensureDirectory();
        const error = await shell.openPath(options.diagnostics.directory);
        if (error !== '') throw new ProtocolFault('network');
      },
      'app:copy-diagnostics': async () => clipboard.writeText(await options.diagnostics.diagnosticReport()),
      'app:renderer-failure': (input: unknown) => {
        const failure = requireRecord(input); requireKeys(failure, ['kind'], ['line', 'column']);
        if (failure.kind !== 'error' && failure.kind !== 'unhandled-rejection') throw new ProtocolFault('protocol');
        for (const key of ['line', 'column'] as const) {
          const value = failure[key];
          if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 100000000)) throw new ProtocolFault('protocol');
        }
        options.diagnostics.record('error', 'renderer-failed', { reason: failure.kind,
          ...(typeof failure.line === 'number' ? { rendererLine: failure.line } : {}),
          ...(typeof failure.column === 'number' ? { rendererColumn: failure.column } : {}),
        });
      },
    }),
  });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show(); });
  window.once('closed', () => { workbench?.dispose(); auth.dispose(); void fallback?.close(); });
  await window.loadFile(pagePath);
  return window;
}
