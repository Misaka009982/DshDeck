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
import { validatePetAsset, validatePetRuntime } from './pet-assets.js';
import type { PetAsset } from './pet-assets.js';

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
  private notification: unknown = null;
  private state: PetStatus['state'] = 'disabled';
  private message = '未启用本机宠物。';
  private enabling: Promise<void> | undefined;
  private readonly actions = new Set<string>();
  private disposed = false;
  constructor(private readonly preferences: Preferences, private readonly hooks: PetHooks) {}
  status(): PetStatus { return { state: this.state, ...this.preferences.petPaths(), message: this.message }; }
  async choosePath(kind: 'runtime' | 'resources', parent: BrowserWindow): Promise<void> {
    const result = await dialog.showOpenDialog(parent, { title: kind === 'runtime' ? '选择现有 pet-e 项目目录' : '选择已授权 WebP 宠物资源目录', properties: ['openDirectory'] });
    const path = result.filePaths[0]; if (result.canceled || path === undefined) return;
    if (kind === 'runtime') await validatePetRuntime(path); else await validatePetAsset(path);
    const paths = this.preferences.petPaths();
    this.stop();
    await this.preferences.setPetPaths(kind === 'runtime' ? path : paths.runtimeRoot, kind === 'resources' ? path : paths.resourceRoot);
    if (this.preferences.settings().petEnabled) await this.setEnabled(true);
    this.hooks.changed();
  }
  setEnabled(enabled: boolean): Promise<void> {
    if (!enabled) { this.stop(); this.state = 'disabled'; this.message = '宠物已禁用，远程任务与关注标记未改变。'; this.hooks.changed(); return Promise.resolve(); }
    if (this.child !== undefined || this.enabling !== undefined || this.disposed) return this.enabling ?? Promise.resolve();
    const work = this.start().catch(() => { this.state = 'unavailable'; this.message = '本机 pet-e 或 WebP 资源不可用；不会下载或降低校验。'; this.hooks.changed(); });
    this.enabling = work;
    return work.finally(() => { if (this.enabling === work) this.enabling = undefined; });
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

  private async start(): Promise<void> {
    const paths = this.preferences.petPaths();
    if (paths.runtimeRoot === null || paths.resourceRoot === null) throw new ProtocolFault('not-found');
    this.state = 'starting'; this.message = '正在校验本机 companion 与资源。'; this.hooks.changed();
    const [runtime, asset] = await Promise.all([validatePetRuntime(paths.runtimeRoot), validatePetAsset(paths.resourceRoot)]);
    if (this.disposed || !this.preferences.settings().petEnabled) return;
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
      this.send('config', { language: 'zh-CN', visible: true, settings: { ...petSettings(true), petId: this.asset?.id ?? null }, pet: this.asset ?? null, labels: { source: 'dsh', idle: '没有关注任务' } });
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
    const line = `${JSON.stringify({ protocolVersion: 1, instanceId: this.instanceId, generation: this.generation, revision: ++this.hostRevision,
      type: 'shutdown', payload: { reason: 'DshDeck 已结束宠物展示，不影响远程任务。' } })}\n`;
    // 结束协议和 stdin，等待子端自然退出；不 kill，不递归经过失败的发送队列。
    if (child.stdin.writable) child.stdin.end(line);
  }
}
