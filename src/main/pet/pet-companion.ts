import { randomUUID } from 'node:crypto';
import { dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import type { PetStatus, TaskProjection } from '../../shared/domain.js';
import { ProtocolFault, requireKeys, requireRecord } from '../../shared/faults.js';
import { parseNativePetAction } from '../../shared/pet-view.js';
import type { PetViewNotice } from '../../shared/pet-view.js';
import { Preferences } from '../storage/preferences.js';
import type { IpcRegistry } from '../security/ipc-registry.js';
import type { WindowAssets } from '../windows/window-assets.js';
import type { DiagnosticLogger } from '../logging/diagnostic-logger.js';
import { petSnapshot } from './pet-snapshot.js';
import type { PetAsset } from './pet-assets.js';
import { readPetChoice, scanPetLibrary } from './pet-library.js';
import type { PetLibrary } from './pet-library.js';
import { PetWindow } from './pet-window.js';

interface PetHooks {
  readonly changed: () => void; readonly jump: (task: TaskProjection) => void;
  readonly openSettings: () => void; readonly openLicenses: () => Promise<void>;
}
/** 本项目内置的单一宠物窗口；库与选择沿用旧设置，不再读取或启动外部运行器。 */
export class PetCompanion {
  private readonly instanceId = randomUUID();
  private readonly display: PetWindow;
  private generation = 0;
  private snapshotRevision = 0;
  private startEpoch = 0;
  private tasks: readonly TaskProjection[] = [];
  private taskFingerprint = '';
  private library: PetLibrary | undefined;
  private scanning: Promise<void> | undefined;
  private selectionQueue: Promise<void> = Promise.resolve();
  private selectionBusy = false;
  private notification: PetViewNotice | null = null;
  private state: PetStatus['state'] = 'disabled';
  private message = '未启用内置宠物。';
  private enabling: Promise<void> | undefined;
  private manualDisabled = false;
  private blockedOnFailure = false;
  private readonly actions = new Set<string>();
  private disposed = false;

  constructor(private readonly preferences: Preferences, private readonly hooks: PetHooks, assets: WindowAssets, ipc: IpcRegistry, private readonly logger?: DiagnosticLogger) {
    this.display = new PetWindow(assets, ipc, {
      ready: () => { if (this.disposed) return; this.state = 'running'; this.message = '内置宠物已开启，只展示关注会话并点击跳回。'; this.sendSnapshot(); this.hooks.changed(); },
      action: value => this.action(value), position: value => this.preferences.updatePetDisplay({ position: value }),
      closed: () => this.closeFromPet(), failed: error => this.failed(error),
    }, logger);
  }
  status(): PetStatus {
    return { state: this.state, ...this.preferences.petPaths(), display: this.preferences.petDisplay(), message: this.message,
      choices: this.library?.entries.map(({ id, name, available, message }) => ({ id, name, available, message })) ?? [],
      selectedPetId: this.selected()?.id ?? null, scanning: this.scanning !== undefined, truncated: this.library?.truncated ?? false };
  }
  async choosePath(kind: 'resources', parent: BrowserWindow): Promise<void> {
    if (kind !== 'resources') throw new ProtocolFault('unsupported');
    const result = await dialog.showOpenDialog(parent, { title: '选择宠物库根目录（也兼容单个宠物包）', properties: ['openDirectory'] });
    const path = result.filePaths[0]; if (result.canceled || path === undefined || this.disposed) return;
    await this.enqueue(async () => {
      const library = await scanPetLibrary(path); if (this.disposed) throw new ProtocolFault('cancelled');
      await this.preferences.setPetLibrary(path); if (this.disposed) return;
      this.library = library;
      try { await this.applySelection(); } catch (error) { if (!this.disposed) this.failed(error); throw error; }
      this.blockedOnFailure = false; this.hooks.changed();
    });
    if (this.preferences.settings().petEnabled) await this.setEnabled(true);
  }
  rescan(): Promise<void> {
    if (this.scanning !== undefined) return this.scanning;
    const work = this.enqueue(async () => {
      const path = this.preferences.petPaths().resourceRoot;
      if (path === null) { this.library = undefined; this.display.stop(); return; }
      try {
        const library = await scanPetLibrary(path);
        if (this.disposed || this.preferences.petPaths().resourceRoot !== path) return;
        this.library = library; await this.applySelection(); this.blockedOnFailure = false;
      } catch (error) {
        if (!this.disposed && this.preferences.petPaths().resourceRoot === path) { this.library = undefined; this.blockedOnFailure = true; this.display.stop(); this.state = 'unavailable'; this.message = '无法读取宠物库，请重新选择目录。'; this.logger?.fault('renderer-failed', error, { reason: 'pet-library' }); }
      }
    });
    this.scanning = work; this.hooks.changed();
    return work.finally(() => { if (this.scanning === work) { this.scanning = undefined; this.hooks.changed(); } });
  }
  selectPet(id: string): Promise<void> {
    return this.enqueue(async () => {
      const library = this.library;
      if (library === undefined || this.disposed) throw new ProtocolFault('not-found');
      const asset = await readPetChoice(library, id);
      if (this.library !== library || this.disposed) throw new ProtocolFault('cancelled');
      await this.preferences.setPetSelection(id); if (this.disposed) return; this.blockedOnFailure = false;
      if (this.display.active()) await this.updateWindowAsset(asset);
      this.hooks.changed();
    }).then(async () => { if (this.preferences.settings().petEnabled) await this.setEnabled(true); });
  }
  setEnabled(enabled: boolean): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!enabled) {
      this.startEpoch++; this.manualDisabled = false; this.blockedOnFailure = false; this.display.stop(); this.state = 'disabled';
      this.message = '宠物已禁用，远程任务与关注标记未改变。'; this.hooks.changed(); return Promise.resolve();
    }
    if (this.manualDisabled || this.blockedOnFailure || this.selectionBusy) return Promise.resolve();
    if (this.display.active()) { this.configure(); return Promise.resolve(); }
    if (this.enabling !== undefined) return this.enabling;
    const epoch = ++this.startEpoch; const requested = this.selectionFingerprint();
    const work = this.start(epoch).catch(error => { if (epoch === this.startEpoch && !this.disposed) this.failed(error); });
    this.enabling = work;
    return work.finally(() => {
      if (this.enabling !== work) return; this.enabling = undefined;
      if (!this.disposed && this.preferences.settings().petEnabled && !this.manualDisabled && !this.display.active() && (requested !== this.selectionFingerprint() || epoch !== this.startEpoch)) void this.setEnabled(true);
    });
  }
  publish(tasks: readonly TaskProjection[]): void {
    const fingerprint = JSON.stringify(tasks.map(task => [task.id, task.color, task.freshness, task.generation, task.resultId, task.title])); this.tasks = tasks;
    if (fingerprint === this.taskFingerprint) return; this.taskFingerprint = fingerprint;
    if (this.display.active()) this.sendSnapshot();
  }
  notify(value: unknown): void {
    try {
      const notice = requireRecord(value); requireKeys(notice, ['id', 'title', 'message', 'createdAt', 'expiresAt']);
      if (typeof notice.id !== 'string' || notice.id.length > 160 || typeof notice.title !== 'string' || notice.title.length > 160
        || typeof notice.message !== 'string' || notice.message.length > 512 || typeof notice.createdAt !== 'number' || !Number.isSafeInteger(notice.createdAt)
        || typeof notice.expiresAt !== 'number' || !Number.isSafeInteger(notice.expiresAt) || notice.expiresAt <= notice.createdAt || notice.expiresAt - notice.createdAt > 60000) return;
      this.notification = { id: notice.id, title: notice.title, message: notice.message, createdAt: notice.createdAt, expiresAt: notice.expiresAt };
      if (this.display.active()) this.sendSnapshot();
    } catch { /* 仅接收内部脱敏提醒；坏通知不扩大宠物权限或拖垮工作台。 */ }
  }
  fullscreen(value: boolean): void { this.display.fullscreen(value); }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.startEpoch++; this.display.dispose(); }

  private selected() {
    const id = this.preferences.petSelection();
    return id === null ? this.library?.entries.find(entry => entry.available) : this.library?.entries.find(entry => entry.id === id && entry.available);
  }
  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.selectionQueue.then(async () => { this.selectionBusy = true; try { await work(); } finally { this.selectionBusy = false; } });
    this.selectionQueue = next.catch(() => {}); return next;
  }
  private selectionFingerprint(): string { return JSON.stringify([this.preferences.petPaths(), this.preferences.petSelection()]); }
  private async applySelection(): Promise<void> {
    const library = this.library; const selected = this.selected();
    if (selected === undefined || library === undefined) {
      this.display.stop(); this.message = '宠物库中没有可用的当前选择，请选择可用 WebP 精灵包。';
      if (this.preferences.settings().petEnabled) this.state = 'unavailable'; return;
    }
    const asset = await readPetChoice(library, selected.id);
    if (this.library !== library || this.disposed) throw new ProtocolFault('cancelled');
    if (this.display.active()) await this.updateWindowAsset(asset);
    else this.message = `已扫描 ${library.entries.length} 只宠物，桌面只显示当前选择。${library.truncated ? '扫描达到安全上限。' : ''}`;
  }
  private async updateWindowAsset(asset: PetAsset): Promise<void> {
    try { await this.display.setAsset(asset); this.configure(); }
    catch (error) {
      if (!this.disposed && !(error instanceof ProtocolFault && error.kind === 'cancelled')) this.failed(error);
      throw error;
    }
  }
  private configure(): void { this.display.configure(this.preferences.petDisplay(), this.preferences.settings().theme); }
  private async start(epoch: number): Promise<void> {
    const path = this.preferences.petPaths().resourceRoot;
    if (path === null) throw new ProtocolFault('not-found');
    if (this.library?.sourceRoot !== path) await this.rescan();
    const library = this.library; const selected = this.selected();
    if (library === undefined || selected === undefined) throw new ProtocolFault('not-found');
    const requested = this.selectionFingerprint();
    this.state = 'starting'; this.message = '正在校验宠物资源并打开内置窗口。'; this.hooks.changed();
    const asset = await readPetChoice(library, selected.id);
    if (this.disposed || epoch !== this.startEpoch || !this.preferences.settings().petEnabled || requested !== this.selectionFingerprint()) return;
    await this.display.setAsset(asset);
    if (this.disposed || epoch !== this.startEpoch || !this.preferences.settings().petEnabled || requested !== this.selectionFingerprint()) { this.display.stop(); return; }
    this.generation++; this.actions.clear(); this.configure();
    await this.display.start(petSnapshot(this.instanceId, this.generation, ++this.snapshotRevision, this.tasks, this.notification));
  }
  private async action(value: unknown): Promise<void> {
    const action = parseNativePetAction(value, this.snapshotRevision);
    if (action.kind === 'close-pet') { this.closeFromPet(); return; }
    if (this.actions.has(action.actionId)) return;
    if (this.actions.size >= 2048) this.actions.delete(this.actions.values().next().value ?? '');
    this.actions.add(action.actionId);
    if (action.kind === 'open-settings') { this.hooks.openSettings(); return; }
    if (action.kind === 'open-licenses') { await this.hooks.openLicenses(); return; }
    if (action.kind !== 'open-task') throw new ProtocolFault('forbidden');
    const task = this.tasks.find(task => task.id === action.taskId);
    if (task === undefined || task.freshness !== 'fresh') throw new ProtocolFault('forbidden');
    this.hooks.jump(task);
  }
  private closeFromPet(): void {
    if (this.disposed) return; this.manualDisabled = true; this.startEpoch++; this.display.stop(); this.state = 'disabled';
    this.message = '宠物已关闭，主工作台和远程任务继续运行。'; this.hooks.changed();
    void this.preferences.updateSettings({ ...this.preferences.settings(), petEnabled: false }).catch(error => {
      this.message = '宠物已在本次运行中关闭，但关闭偏好未能保存；下次启动可能再次显示。'; this.logger?.fault('window-state-failed', error); this.hooks.changed();
    });
  }
  private sendSnapshot(): void { this.display.publish(petSnapshot(this.instanceId, this.generation, ++this.snapshotRevision, this.tasks, this.notification)); }
  private failed(error: unknown): void {
    // 位置或阅读偏好更新不能把失败窗口隐式重启；明确重新选择／重扫或关闭后启用才恢复。
    this.blockedOnFailure = true; this.display.stop(); this.state = error instanceof ProtocolFault && ['not-found', 'unsupported', 'budget'].includes(error.kind) ? 'unavailable' : 'failed';
    this.message = '内置宠物或本机 WebP 资源不可用。可重新选择资源／关闭后启用；主工作台继续运行。';
    this.logger?.fault('renderer-failed', error, { reason: 'pet-window' }); this.hooks.changed();
  }
}
