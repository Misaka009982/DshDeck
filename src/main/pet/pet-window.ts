// SPDX-License-Identifier: AGPL-3.0-or-later
// 移植来源：CLI-Manager/pet-e/src/main.ts，2026-11-16 改为 DshDeck 同进程安全窗口；原作者权利及许可见 NOTICE.txt 和 LICENSE。
import { BrowserWindow, nativeTheme, screen, session, shell } from 'electron';
import type { Session } from 'electron';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProtocolFault } from '../../shared/faults.js';
import { DEFAULT_PET_DISPLAY, petWindowGeometry } from '../../shared/pet-display.js';
import type { PetDisplaySettings } from '../../shared/pet-display.js';
import { PET_APP_SCHEME, PET_ASSET_SCHEME, PET_PAGE_URL } from '../../shared/pet-view.js';
import type { PetViewConfig, PetViewSnapshot } from '../../shared/pet-view.js';
import { localWebPreferences } from '../windows/security-options.js';
import type { WindowAssets } from '../windows/window-assets.js';
import type { IpcRegistry } from '../security/ipc-registry.js';
import type { DiagnosticLogger } from '../logging/diagnostic-logger.js';
import type { PetAsset } from './pet-assets.js';

interface PetWindowHooks {
  readonly ready: () => void;
  readonly action: (value: unknown) => Promise<void>;
  readonly position: (value: { readonly x: number; readonly y: number }) => Promise<void>;
  readonly closed: () => void;
  readonly failed: (error: unknown) => void;
}
/** 仅本地主框架有宠物 bridge；素材协议只返回已验证的一张 WebP，没有路径参数或联网能力。 */
export class PetWindow {
  private readonly partition = `dshdeck-pet-${randomUUID()}`;
  private readonly browserSession: Session;
  private window: BrowserWindow | undefined;
  private config: PetViewConfig = { language: 'zh-CN', visible: true, theme: 'dark', settings: { ...DEFAULT_PET_DISPLAY }, pet: null };
  private snapshot: PetViewSnapshot | undefined;
  private asset: PetAsset | undefined;
  private spriteBytes: Buffer | undefined;
  private spriteRevision = 0;
  private assetEpoch = 0;
  private windowEpoch = 0;
  private rendererReady = false;
  private stopping = false;
  private disposed = false;
  private geometryKey = '';
  private hostFullscreen = false;
  private theme: 'system' | 'light' | 'dark' = 'system';
  private moveTimer: ReturnType<typeof setTimeout> | undefined;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSoundAt = -Infinity;
  private programmaticPosition: { x: number; y: number } | undefined;
  private programmaticUntil = 0;
  private readonly displayChanged = (): void => { this.geometryKey = ''; this.applyConfig(); };
  private readonly themeChanged = (): void => { this.applyConfig(); };

  constructor(private readonly assets: WindowAssets, private readonly ipc: IpcRegistry, private readonly hooks: PetWindowHooks, private readonly logger?: DiagnosticLogger) {
    this.browserSession = session.fromPartition(this.partition, { cache: false });
    this.browserSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
    this.browserSession.setPermissionCheckHandler(() => false);
    const files = new Map([
      ['/index.html', join(assets.rendererRoot, 'pet.html')], ['/pet.css', join(assets.rendererRoot, 'pet.css')],
      ['/pet.js', join(assets.rendererRoot, '../../dist/renderer/pet.js')],
    ]);
    this.browserSession.protocol.handle(PET_APP_SCHEME, async request => {
      const url = new URL(request.url); const path = files.get(url.pathname);
      if (request.method !== 'GET' || url.hostname !== 'app' || url.username !== '' || url.password !== '' || url.search !== '' || path === undefined) return new Response(null, { status: 404 });
      const body = await readFile(path);
      return new Response(new Uint8Array(body), { headers: { 'content-type': path.endsWith('.html') ? 'text/html; charset=utf-8' : path.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } });
    });
    this.browserSession.protocol.handle(PET_ASSET_SCHEME, request => {
      const url = new URL(request.url);
      if (request.method !== 'GET' || url.hostname !== 'sprite' || url.pathname !== '/current' || url.username !== '' || url.password !== ''
        || [...url.searchParams.keys()].some(key => key !== 'v') || url.searchParams.get('v') !== String(this.spriteRevision) || this.spriteBytes === undefined) return new Response(null, { status: 404 });
      return new Response(new Uint8Array(this.spriteBytes), { headers: { 'content-type': 'image/webp', 'cache-control': 'no-store' } });
    });
    this.browserSession.webRequest.onBeforeRequest((details, done) => {
      const url = new URL(details.url);
      done({ cancel: url.protocol !== `${PET_APP_SCHEME}:` && url.protocol !== `${PET_ASSET_SCHEME}:` });
    });
    screen.on('display-added', this.displayChanged); screen.on('display-removed', this.displayChanged); screen.on('display-metrics-changed', this.displayChanged);
    nativeTheme.on('updated', this.themeChanged);
  }
  active(): boolean { return this.window !== undefined && !this.window.isDestroyed(); }
  configure(settings: PetDisplaySettings, theme: 'system' | 'light' | 'dark'): void {
    if (theme === this.theme && JSON.stringify(settings) === JSON.stringify(this.config.settings)) return;
    this.theme = theme; this.config = { ...this.config, settings }; this.applyConfig();
  }
  fullscreen(value: boolean): void { this.hostFullscreen = value; this.applyConfig(); }
  async setAsset(asset: PetAsset): Promise<void> {
    const epoch = ++this.assetEpoch; const file = await open(asset.spritePath, 'r');
    let bytes: Buffer;
    try {
      const info = await file.stat(); if (!info.isFile() || info.size < 30 || info.size > 20 * 1024 * 1024) throw new ProtocolFault('budget');
      bytes = Buffer.alloc(info.size); let position = 0;
      while (position < bytes.length) { const result = await file.read(bytes, position, bytes.length - position, position); if (result.bytesRead === 0) throw new ProtocolFault('unsupported'); position += result.bytesRead; }
      if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') throw new ProtocolFault('unsupported');
    } finally { await file.close(); }
    if (this.disposed || epoch !== this.assetEpoch) throw new ProtocolFault('cancelled');
    this.spriteBytes = bytes; this.asset = asset; this.spriteRevision++; this.applyConfig();
  }
  async start(snapshot: PetViewSnapshot): Promise<void> {
    if (this.disposed || this.asset === undefined || this.spriteBytes === undefined) throw new ProtocolFault('not-found');
    this.snapshot = snapshot;
    if (this.active()) { this.publish(snapshot); return; }
    const epoch = ++this.windowEpoch;
    const win = new BrowserWindow({ width: 380, height: 540, show: false, title: 'DshDeck · 宠物', transparent: true, frame: false,
      resizable: false, maximizable: false, minimizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
      hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { ...localWebPreferences(this.partition, join(this.assets.preloadRoot, 'pet-preload.cjs')), session: this.browserSession, devTools: false },
    });
    this.window = win; this.rendererReady = false; this.geometryKey = ''; win.setMenuBarVisibility(false); win.setIgnoreMouseEvents(true, { forward: true });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault()); win.webContents.on('will-attach-webview', event => event.preventDefault());
    win.webContents.on('render-process-gone', () => { if (this.window === win) this.hooks.failed(new ProtocolFault('network')); });
    win.on('unresponsive', () => { if (this.window === win) this.hooks.failed(new ProtocolFault('network')); });
    win.on('move', () => this.moved(win));
    win.on('close', () => this.capturePosition());
    win.once('closed', () => {
      if (this.window !== win) return;
      this.window = undefined; this.rendererReady = false; this.clearTimers();
      if (!this.stopping && !this.disposed) this.hooks.closed();
    });
    this.ipc.bind(win, PET_PAGE_URL, {
      'pet:ready': () => {
        if (this.window !== win || epoch !== this.windowEpoch || this.snapshot === undefined) throw new ProtocolFault('cancelled');
        this.rendererReady = true; clearTimeout(this.startupTimer); this.startupTimer = undefined;
        this.hooks.ready(); this.applyConfig();
        return { config: this.config, snapshot: this.snapshot };
      },
      'pet:mouse-interactive': value => {
        if (typeof value !== 'boolean') throw new ProtocolFault('protocol');
        if (this.window !== win || win.isDestroyed()) throw new ProtocolFault('cancelled');
        win.setIgnoreMouseEvents(!value, { forward: true });
      },
      'pet:action': value => {
        if (this.window !== win || !this.rendererReady || win.isDestroyed()) throw new ProtocolFault('cancelled');
        return this.hooks.action(value);
      },
    });
    this.applyConfig();
    this.startupTimer = setTimeout(() => { if (this.window === win && !this.rendererReady) this.hooks.failed(new ProtocolFault('timeout')); }, 10000);
    try { await win.loadURL(PET_PAGE_URL); }
    catch (error) { if (this.window === win && epoch === this.windowEpoch) throw error; }
  }
  publish(snapshot: PetViewSnapshot): void {
    const previous = this.snapshot; this.snapshot = snapshot;
    if (!this.active() || !this.rendererReady) return;
    if (this.config.settings.soundEnabled && (snapshot.tasks.some(task => task.color === 'yellow' && !previous?.tasks.some(old => old.id === task.id && old.color === 'yellow'))
      || this.config.settings.notificationsEnabled && snapshot.notification !== null && snapshot.notification.id !== previous?.notification?.id)) {
      // 提醒与任务状态可能紧邻到达；同一短突发只响一次，但每份快照仍照常传递。
      const now = performance.now();
      if (now - this.lastSoundAt >= 250) {
        this.lastSoundAt = now;
        try { shell.beep(); } catch (error) { this.logger?.fault('renderer-failed', error, { reason: 'pet-sound' }); }
      }
    }
    // 声音节流不取消状态快照，250ms 内的相邻通知只聚合提示音。
    this.window?.webContents.send('pet:snapshot', snapshot);
  }
  stop(): void {
    this.windowEpoch++; this.assetEpoch++; this.capturePosition(); this.stopping = true;
    const win = this.window; this.window = undefined; this.rendererReady = false; this.clearTimers();
    if (win !== undefined && !win.isDestroyed()) win.destroy();
    this.stopping = false; this.spriteBytes = undefined; this.asset = undefined;
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.stop();
    this.browserSession.protocol.unhandle(PET_APP_SCHEME); this.browserSession.protocol.unhandle(PET_ASSET_SCHEME);
    screen.removeListener('display-added', this.displayChanged); screen.removeListener('display-removed', this.displayChanged); screen.removeListener('display-metrics-changed', this.displayChanged);
    nativeTheme.removeListener('updated', this.themeChanged);
  }
  private applyConfig(): void {
    const win = this.window;
    this.config = { ...this.config, visible: !(this.hostFullscreen && this.config.settings.autoHideFullscreen),
      theme: this.theme === 'system' ? nativeTheme.shouldUseDarkColors ? 'dark' : 'light' : this.theme,
      pet: this.asset === undefined ? null : { ...this.asset, spritePath: `${PET_ASSET_SCHEME}://sprite/current?v=${this.spriteRevision}` } };
    if (win === undefined || win.isDestroyed()) return;
    const position = this.config.settings.position;
    const display = position === null ? screen.getPrimaryDisplay() : screen.getDisplayNearestPoint(position);
    const geometry = petWindowGeometry(this.config.settings, display.workArea); const key = JSON.stringify([this.config.settings.size, position, display.id, display.workArea]);
    if (this.geometryKey !== key) {
      this.geometryKey = key; const previous = win.getBounds();
      if (JSON.stringify(previous) !== JSON.stringify(geometry.bounds)) {
        this.programmaticPosition = { x: geometry.bounds.x, y: geometry.bounds.y }; this.programmaticUntil = Date.now() + 1000; win.setBounds(geometry.bounds, false);
      }
      win.webContents.setZoomFactor(geometry.scale);
    }
    win.setAlwaysOnTop(this.config.settings.alwaysOnTop, 'floating'); win.setMovable(!this.config.settings.lockPosition);
    if (this.rendererReady && this.config.visible) win.showInactive(); else { win.setIgnoreMouseEvents(true, { forward: true }); win.hide(); }
    if (this.rendererReady) win.webContents.send('pet:config', this.config);
  }
  private moved(win: BrowserWindow): void {
    if (this.window !== win || win.isDestroyed() || this.config.settings.lockPosition) return;
    const [x, y] = win.getPosition(); const expected = this.programmaticPosition;
    if (expected !== undefined && Date.now() < this.programmaticUntil && Math.abs(expected.x - x) <= 2 && Math.abs(expected.y - y) <= 2) return;
    this.programmaticPosition = undefined; clearTimeout(this.moveTimer);
    this.moveTimer = setTimeout(() => {
      this.moveTimer = undefined; if (this.window !== win || win.isDestroyed()) return;
      const [x, y] = win.getPosition(); const geometry = petWindowGeometry({ ...this.config.settings, position: { x, y } }, screen.getDisplayMatching(win.getBounds()).workArea);
      this.programmaticPosition = { x: geometry.bounds.x, y: geometry.bounds.y }; this.programmaticUntil = Date.now() + 1000;
      win.setBounds(geometry.bounds, false); win.webContents.setZoomFactor(geometry.scale);
      this.savePosition({ x: geometry.bounds.x, y: geometry.bounds.y });
    }, 150);
  }
  private capturePosition(): void {
    const win = this.window; if (win === undefined || win.isDestroyed()) return;
    const [x, y] = win.getPosition(); this.savePosition({ x, y });
  }
  private savePosition(position: { x: number; y: number }): void {
    if (this.config.settings.position?.x === position.x && this.config.settings.position.y === position.y) return;
    void this.hooks.position(position).catch(error => this.logger?.fault('window-state-failed', error));
  }
  private clearTimers(): void { clearTimeout(this.moveTimer); clearTimeout(this.startupTimer); this.moveTimer = undefined; this.startupTimer = undefined; }
}
