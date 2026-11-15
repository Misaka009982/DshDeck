import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import type { PetStatus, TaskProjection } from '../../shared/domain.js';
import { ProtocolFault, requireKeys, requireRecord } from '../../shared/faults.js';
import { PET_MAX_LINE_BYTES, parsePetAction, parsePetEnvelope } from '../../shared/pet-protocol.js';
import { Preferences } from '../storage/preferences.js';
import { petSettings, petSnapshot } from './pet-snapshot.js';
import { validatePetRuntime } from './pet-assets.js';
import type { PetAsset } from './pet-assets.js';
import { readPetChoice, scanPetLibrary } from './pet-library.js';
import type { PetLibrary } from './pet-library.js';

interface PetHooks { readonly changed: () => void; readonly jump: (task: TaskProjection) => void; readonly clear: (task: TaskProjection) => Promise<void>; readonly openSettings: () => void }

/** 仅用户启用已验证本机 companion 时启动；无下载、任意命令、远程操作或正文转发。 */
export class PetCompanion {
  private readonly instanceId = randomUUID();
  private generation = 0;
  private hostRevision = 0;
  private childRevision = 0;
  private snapshotRevision = 0;
  private tasks: readonly TaskProjection[] = [];
  private taskFingerprint = '';
  private child: ChildProcessWithoutNullStreams | undefined;
  private asset: PetAsset | undefined;
  private library: PetLibrary | undefined;
  private scanning: Promise<void> | undefined;
  private selectionQueue: Promise<void> = Promise.resolve();
  private retiring: Promise<void> = Promise.resolve();
  private notification: unknown = null;
  private state: PetStatus['state'] = 'disabled';
  private message = '未启用本机宠物。';
  private enabling: Promise<void> | undefined;
  private readonly actions = new Set<string>();
  private disposed = false;
  constructor(private readonly preferences: Preferences, private readonly hooks: PetHooks) {}
  status(): PetStatus { return { state: this.state, ...this.preferences.petPaths(), message: this.message,
    choices: this.library?.entries.map(({ id, name, available, message }) => ({ id, name, available, message })) ?? [],
    selectedPetId: this.selected()?.id ?? null, scanning: this.scanning !== undefined, truncated: this.library?.truncated ?? false }; }
  async choosePath(kind: 'runtime' | 'resources', parent: BrowserWindow): Promise<void> {
    const result = await dialog.showOpenDialog(parent, { title: kind === 'runtime' ? '选择现有宠物运行器目录' : '选择宠物库根目录（也兼容单个宠物包）', properties: ['openDirectory'] });
    const path = result.filePaths[0]; if (result.canceled || path === undefined || this.disposed) return;
    if (kind === 'runtime') await validatePetRuntime(path);
    const library = kind === 'resources' ? await scanPetLibrary(path) : undefined;
    const paths = this.preferences.petPaths();
    await this.preferences.setPetPaths(kind === 'runtime' ? path : paths.runtimeRoot, kind === 'resources' ? path : paths.resourceRoot);
    if (library !== undefined) this.library = library;
    if (kind === 'runtime') this.stop();
    await this.applySelection();
    if (this.preferences.settings().petEnabled) await this.setEnabled(true);
    this.hooks.changed();
  }
  rescan(): Promise<void> {
    if (this.scanning !== undefined) return this.scanning;
    const path = this.preferences.petPaths().resourceRoot;
    const work = (async () => {
      if (path === null) { this.library = undefined; return; }
      try {
        const library = await scanPetLibrary(path);
        if (this.disposed || this.preferences.petPaths().resourceRoot !== path) return;
        this.library = library; await this.applySelection();
      } catch {
        if (this.preferences.petPaths().resourceRoot === path) { this.library = undefined; this.stop(); this.state = 'unavailable'; this.message = '无法读取宠物库，请重新选择目录。'; }
      }
    })();
    this.scanning = work; this.hooks.changed();
    return work.finally(() => { if (this.scanning === work) { this.scanning = undefined; this.hooks.changed(); } });
  }
  selectPet(id: string): Promise<void> {
    const work = this.selectionQueue.then(async () => {
      const library = this.library;
      if (library === undefined || this.disposed) throw new ProtocolFault('not-found');
      const asset = await readPetChoice(library, id);
      if (this.library !== library || this.disposed) throw new ProtocolFault('cancelled');
      await this.preferences.setPetSelection(id); this.asset = asset;
      if (this.child !== undefined) { this.sendConfig(); if (this.state === 'running') this.sendSnapshot(); }
      else if (this.preferences.settings().petEnabled) await this.setEnabled(true);
      this.hooks.changed();
    });
    this.selectionQueue = work.catch(() => {}); return work;
  }
  setEnabled(enabled: boolean): Promise<void> {
    if (!enabled) { this.stop(); this.state = 'disabled'; this.message = '宠物已禁用，远程任务与关注标记未改变。'; this.hooks.changed(); return Promise.resolve(); }
    if (this.child !== undefined || this.enabling !== undefined || this.disposed) return this.enabling ?? Promise.resolve();
    const requested = this.selectionFingerprint();
    const work = this.start().catch(() => { this.state = 'unavailable'; this.message = '本机宠物运行器或 WebP 资源不可用；不会下载或降低校验。'; this.hooks.changed(); });
    this.enabling = work;
    return work.finally(() => {
      if (this.enabling !== work) return;
      this.enabling = undefined;
      if (!this.disposed && this.preferences.settings().petEnabled && this.child === undefined && requested !== this.selectionFingerprint()) void this.setEnabled(true);
    });
  }
  publish(tasks: readonly TaskProjection[]): void {
    const fingerprint = JSON.stringify(tasks.map(task => [task.id, task.color, task.freshness, task.generation, task.resultId, task.title]));
    this.tasks = tasks;
    if (fingerprint === this.taskFingerprint) return;
    this.taskFingerprint = fingerprint;
    if (this.child !== undefined && this.state === 'running') this.sendSnapshot();
  }
  notify(notification: unknown): void { this.notification = notification; if (this.child !== undefined && this.state === 'running') this.sendSnapshot(); }
  dispose(): void { this.disposed = true; this.stop(); }

  private selected() {
    const id = this.preferences.petSelection();
    return id === null ? this.library?.entries.find(entry => entry.available) : this.library?.entries.find(entry => entry.id === id && entry.available);
  }
  private selectionFingerprint(): string { return JSON.stringify([this.preferences.petPaths(), this.preferences.petSelection()]); }
  private async applySelection(): Promise<void> {
    const selected = this.selected();
    if (selected === undefined || this.library === undefined) {
      this.asset = undefined; this.stop();
      this.message = '宠物库中没有可用的当前选择；请选择可用 WebP 精灵包。';
      if (this.preferences.settings().petEnabled) this.state = 'unavailable';
      return;
    }
    this.asset = await readPetChoice(this.library, selected.id);
    if (this.child !== undefined) this.sendConfig();
    else this.message = `已扫描 ${this.library.entries.length} 只宠物，桌面只展示当前选择。${this.library.truncated ? '扫描达到安全上限，未把结果当作完整库。' : ''}`;
  }
  private sendConfig(): void {
    this.send('config', { language: 'zh-CN', visible: true, settings: { ...petSettings(true), petId: this.asset?.id ?? null }, pet: this.asset ?? null, labels: { source: 'dsh', idle: '没有关注任务' } });
  }
  private async start(): Promise<void> {
    await this.retiring;
    const paths = this.preferences.petPaths();
    if (paths.runtimeRoot === null || paths.resourceRoot === null) throw new ProtocolFault('not-found');
    if (this.library?.sourceRoot !== paths.resourceRoot) await this.rescan();
    const selected = this.selected(); const library = this.library;
    if (selected === undefined || library === undefined) throw new ProtocolFault('not-found');
    const requested = this.selectionFingerprint();
    this.state = 'starting'; this.message = '正在校验本机宠物运行器与资源。'; this.hooks.changed();
    const [runtime, asset] = await Promise.all([validatePetRuntime(paths.runtimeRoot), readPetChoice(library, selected.id)]);
    if (this.disposed || !this.preferences.settings().petEnabled || requested !== this.selectionFingerprint()) return;
    this.generation++; this.hostRevision = 0; this.childRevision = 0; this.snapshotRevision = 0; this.actions.clear(); this.asset = asset;
    // 子进程不继承可能含模型密钥的整个环境；只保留 Chromium/Windows 所需位置。
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE']) if (process.env[key] !== undefined) env[key] = process.env[key];
    const child = spawn(runtime.executable, [runtime.entry, '--instance-id', this.instanceId, '--generation', String(this.generation)], { cwd: runtime.root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdin.on('error', () => { if (this.child === child) this.failed(); });
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.child !== child) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > PET_MAX_LINE_BYTES * 2) { this.failed(); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (line.trim() === '') continue;
        try { this.receive(line); } catch { this.failed(); return; }
      }
    });
    // 原始诊断可含本机路径，消费但不转发到 UI、日志或服务器。
    child.stderr.on('data', () => {});
    child.once('error', () => { if (this.child === child) this.failed(); });
    child.once('exit', () => { if (this.child === child) { this.child = undefined; this.state = 'failed'; this.message = '宠物已退出，主工作台继续运行。'; this.hooks.changed(); } });
  }
  private receive(line: string): void {
    const envelope = parsePetEnvelope(line, this.instanceId, this.generation, this.childRevision); this.childRevision = envelope.revision;
    if (envelope.type === 'hello') {
      const payload = requireRecord(envelope.payload); requireKeys(payload, ['runtimeVersion', 'appVersion']);
      if (typeof payload.runtimeVersion !== 'string' || typeof payload.appVersion !== 'string') throw new ProtocolFault('protocol');
      this.sendConfig();
    } else if (envelope.type === 'ready') {
      const payload = requireRecord(envelope.payload); requireKeys(payload, ['rendererReady']);
      if (payload.rendererReady !== true) throw new ProtocolFault('protocol');
      this.state = 'running'; this.message = '宠物已连接，只显示关注任务并提供会话跳转。'; this.sendSnapshot(); this.hooks.changed();
    } else if (envelope.type === 'diagnostic') { this.message = '宠物报告了诊断信息，主工作台不受影响。'; this.hooks.changed(); }
    else {
      const action = parsePetAction(envelope.payload, this.snapshotRevision);
      if (this.actions.has(action.actionId) || this.actions.size >= 2048) throw new ProtocolFault('cancelled');
      this.actions.add(action.actionId);
      if (action.kind === 'submit-action') { this.send('action-result', { actionId: action.actionId, accepted: false, confirmed: false, error: '首版不支持宠物作答或批准，请跳回主工作台。' }); return; }
      if (action.kind === 'close-pet') {
        void this.preferences.updateSettings({ ...this.preferences.settings(), petEnabled: false });
        void this.setEnabled(false); return;
      }
      if (action.kind === 'open-settings') { this.hooks.openSettings(); this.send('action-result', { actionId: action.actionId, accepted: true, confirmed: true }); return; }
      if (action.kind === 'window-state') { this.send('action-result', { actionId: action.actionId, accepted: true, confirmed: true }); return; }
      const task = this.tasks.find(task => task.id === action.taskId);
      if (task === undefined || task.freshness !== 'fresh') { this.send('action-result', { actionId: action.actionId, accepted: false, confirmed: false, error: '任务已过期或无权限。' }); return; }
      if (action.kind === 'open-task') { this.hooks.jump(task); this.send('action-result', { actionId: action.actionId, accepted: true, confirmed: true }); }
      else void this.hooks.clear(task).then(() => this.send('action-result', { actionId: action.actionId, accepted: true, confirmed: true }), () => this.send('action-result', { actionId: action.actionId, accepted: false, confirmed: false, error: '任务仍在运行或结果已改变。' }));
    }
  }
  private sendSnapshot(): void {
    const revision = this.hostRevision + 1;
    const snapshot = petSnapshot(this.instanceId, this.generation, revision, this.tasks, this.notification);
    this.snapshotRevision = revision; this.send('snapshot', snapshot);
  }
  private send(type: string, payload: unknown): void {
    const child = this.child; if (child === undefined || !child.stdin.writable) return;
    const line = `${JSON.stringify({ protocolVersion: 1, instanceId: this.instanceId, generation: this.generation, revision: ++this.hostRevision, type, payload })}\n`;
    if (Buffer.byteLength(line, 'utf8') > PET_MAX_LINE_BYTES || child.stdin.writableLength > PET_MAX_LINE_BYTES) { this.failed(); return; }
    child.stdin.write(line, error => { if (error && this.child === child) this.failed(); });
  }
  private failed(): void { this.state = 'failed'; this.message = '宠物协议或管道异常，已停止本地 companion 通信；主会话继续运行。'; this.stop(); this.hooks.changed(); }
  private stop(): void {
    const child = this.child; if (child === undefined) return;
    this.child = undefined;
    const ended = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => { child.once('close', () => resolve()); });
    this.retiring = Promise.all([this.retiring, ended]).then(() => {});
    const line = `${JSON.stringify({ protocolVersion: 1, instanceId: this.instanceId, generation: this.generation, revision: ++this.hostRevision,
      type: 'shutdown', payload: { reason: 'DshDeck 已结束宠物展示，不影响远程任务。' } })}\n`;
    // 结束协议和 stdin，等待子端自然退出；不 kill，不递归经过失败的发送队列。
    if (child.stdin.writable) child.stdin.end(line);
  }
}
