import { appendFile, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConnectionState } from '../../shared/contracts.js';
import { ProtocolFault, isRecord } from '../../shared/faults.js';
import type { FaultKind } from '../../shared/faults.js';

export type LogLevel = 'info' | 'warn' | 'error';
export type LogEvent = 'app-start' | 'app-ready' | 'app-quitting' | 'startup-failed' | 'main-fatal'
  | 'connection-state' | 'ipc-complete' | 'ipc-failed' | 'read-failed' | 'carrier-failed'
  | 'renderer-gone' | 'renderer-failed' | 'child-process-gone' | 'page-load-failed';
export interface SoftwareInfo {
  readonly appVersion: string;
  readonly electronVersion: string;
  readonly nodeVersion: string;
  readonly chromeVersion: string;
  readonly platform: string;
  readonly arch: string;
}
export interface LogFields {
  readonly serverId?: string;
  readonly generation?: number;
  readonly state?: ConnectionState;
  readonly failureKind?: FaultKind | 'unexpected';
  readonly operation?: string;
  readonly workspaceCount?: number;
  readonly sessionCount?: number;
  readonly errorCode?: number;
  readonly exitCode?: number;
  readonly rendererLine?: number;
  readonly rendererColumn?: number;
  readonly mainFrame?: boolean;
  readonly reason?: string;
  readonly viewType?: string;
  readonly processType?: string;
  readonly errorName?: string;
  readonly frames?: readonly string[];
}
interface LogEntry {
  readonly at: string;
  readonly level: LogLevel;
  readonly event: LogEvent;
  readonly appVersion: string;
  readonly fields: Readonly<Record<string, unknown>>;
}
interface LogOptions { readonly enabled?: boolean; readonly maxFileBytes?: number; readonly backups?: number; readonly historyLimit?: number }
export const DEFAULT_LOG_OPTIONS = { enabled: true, maxFileBytes: 2 * 1024 * 1024, backups: 3, historyLimit: 120 } as const;
const EVENTS = new Set<LogEvent>(['app-start', 'app-ready', 'app-quitting', 'startup-failed', 'main-fatal', 'connection-state',
  'ipc-complete', 'ipc-failed', 'read-failed', 'carrier-failed', 'renderer-gone', 'renderer-failed', 'child-process-gone', 'page-load-failed']);
const STATES = new Set<ConnectionState>(['idle', 'authenticating', 'probing', 'readonly-ready', 'auth-required', 'denied', 'incompatible', 'failed', 'cancelled']);
const FAULTS = new Set<string>(['auth-required', 'forbidden', 'not-found', 'login-response', 'protocol', 'unsupported', 'network',
  'tls', 'cancelled', 'budget', 'timeout', 'conflict', 'uncertain', 'unexpected']);
const OPERATIONS = new Set(['app:list-servers', 'app:add-server', 'app:edit-server', 'app:connect-server',
  'app:authenticate-server', 'app:disconnect-server', 'app:run-sample', 'app:stop-sample', 'app:workbench', 'app:select-session',
  'app:set-followed', 'app:set-manual-unread', 'app:set-draft', 'app:send-text', 'app:stop-remote', 'app:answer', 'app:sync-now',
  'app:load-older', 'app:confirm-read', 'app:update-settings', 'app:open-fallback', 'app:close-fallback', 'app:choose-pet-path',
  'app:set-demo', 'app:open-logs', 'app:copy-diagnostics', 'app:renderer-failure', 'auth:describe', 'auth:navigate', 'auth:finish', 'auth:cancel',
  'credential:describe', 'credential:submit', 'credential:cancel']);
const ERROR_NAMES = new Set(['Error', 'TypeError', 'SyntaxError', 'RangeError', 'AbortError', 'ProtocolFault', 'UnexpectedError']);
const REASONS = new Set(['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'error', 'unhandled-rejection', 'preload-error']);
const VIEW_TYPES = new Set(['window', 'webview', 'offscreen', 'remote', 'webContentsView', 'browserView', 'backgroundPage']);
const PROCESS_TYPES = new Set(['GPU', 'Utility', 'Browser', 'Renderer', 'Zygote', 'Sandbox helper', 'Pepper Plugin']);
const SOURCE_NAMES = '(?:app|auth-service|server-session|credential-store|basic-auth-broker|main-window|auth-window|credential-window|fallback-view|ipc-registry|workbench-service|directory-store|session-state|dsh-web-adapter|rpc|read-only-rpc|read-only-mux|pending-interaction|session-cache|session-reconciler|sync-scheduler|pet-companion|diagnostic-logger|app-preload|auth-preload|credential-preload|workbench)';
const FRAME = new RegExp(`^${SOURCE_NAMES}\\.(?:js|cjs|ts):\\d{1,8}:\\d{1,8}$`, 'u');
const STACK_FRAME = new RegExp(`[/\\\\](${SOURCE_NAMES}\\.(?:js|cjs|ts):\\d{1,8}:\\d{1,8})`, 'gu');
const MAX_ENTRY_BYTES = 4096;

/** 只接受已知元数据，未知键一律丢弃；不能把请求参数或远程返回值传进日志。 */
export function sanitizeLogFields(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return {};
  const fields: Record<string, unknown> = {};
  if (typeof value.serverId === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(value.serverId)) fields.serverId = value.serverId;
  for (const key of ['generation', 'workspaceCount', 'sessionCount', 'errorCode', 'exitCode', 'rendererLine', 'rendererColumn'] as const) {
    if (typeof value[key] === 'number' && Number.isSafeInteger(value[key])) fields[key] = value[key];
  }
  if (typeof value.mainFrame === 'boolean') fields.mainFrame = value.mainFrame;
  if (typeof value.state === 'string' && STATES.has(value.state as ConnectionState)) fields.state = value.state;
  if (typeof value.failureKind === 'string' && FAULTS.has(value.failureKind)) fields.failureKind = value.failureKind;
  if (typeof value.operation === 'string' && OPERATIONS.has(value.operation)) fields.operation = value.operation;
  if (typeof value.reason === 'string' && REASONS.has(value.reason)) fields.reason = value.reason;
  if (typeof value.viewType === 'string' && VIEW_TYPES.has(value.viewType)) fields.viewType = value.viewType;
  if (typeof value.processType === 'string' && PROCESS_TYPES.has(value.processType)) fields.processType = value.processType;
  if (typeof value.errorName === 'string' && ERROR_NAMES.has(value.errorName)) fields.errorName = value.errorName;
  if (Array.isArray(value.frames)) fields.frames = value.frames.filter(frame => typeof frame === 'string' && FRAME.test(frame)).slice(0, 6);
  return fields;
}

/** 不保留 message/cause/完整 stack，只留下安全分类及本应用已知文件的行列号。 */
export function describeLogError(error: unknown): LogFields {
  if (!(error instanceof Error)) return { failureKind: 'unexpected', errorName: 'UnexpectedError' };
  const stack = error.stack;
  const frames = typeof stack === 'string' ? [...stack.slice(0, 16384).matchAll(STACK_FRAME)]
    .flatMap(match => match[1] === undefined ? [] : [match[1]]).slice(0, 6) : [];
  return { failureKind: error instanceof ProtocolFault ? error.kind : 'unexpected',
    errorName: ERROR_NAMES.has(error.name) ? error.name : 'UnexpectedError', frames };
}

/** 默认本机滚动日志；磁盘失败时保留内存诊断，不阻塞业务或递归记录日志错误。 */
export class DiagnosticLogger {
  readonly enabled: boolean;
  readonly activeFile: string;
  private readonly lastErrorFile: string;
  private readonly maxFileBytes: number;
  private readonly backups: number;
  private readonly historyLimit: number;
  private readonly software: SoftwareInfo;
  private readonly history: LogEntry[] = [];
  private tail: Promise<void> = Promise.resolve();
  private initialized = false;
  private storageFailed = false;
  private bytes = 0;
  private pending = 0;
  private dropped = 0;

  constructor(readonly directory: string, software: SoftwareInfo, options: LogOptions = {}) {
    this.enabled = options.enabled ?? DEFAULT_LOG_OPTIONS.enabled;
    this.maxFileBytes = Number.isSafeInteger(options.maxFileBytes) && (options.maxFileBytes ?? 0) >= MAX_ENTRY_BYTES
      ? Math.min(8 * 1024 * 1024, options.maxFileBytes as number) : DEFAULT_LOG_OPTIONS.maxFileBytes;
    this.backups = Number.isSafeInteger(options.backups) && (options.backups ?? 0) >= 1
      ? Math.min(5, options.backups as number) : DEFAULT_LOG_OPTIONS.backups;
    this.historyLimit = Number.isSafeInteger(options.historyLimit) && (options.historyLimit ?? 0) >= 1
      ? Math.min(200, options.historyLimit as number) : DEFAULT_LOG_OPTIONS.historyLimit;
    this.software = { appVersion: version(software.appVersion), electronVersion: version(software.electronVersion),
      nodeVersion: version(software.nodeVersion), chromeVersion: version(software.chromeVersion),
      platform: ['win32', 'darwin', 'linux'].includes(software.platform) ? software.platform : 'unknown',
      arch: ['x64', 'arm64', 'ia32'].includes(software.arch) ? software.arch : 'unknown' };
    this.activeFile = join(directory, 'dshdeck.log'); this.lastErrorFile = join(directory, 'last-error.log');
  }

  record(level: LogLevel, event: LogEvent, fields: LogFields = {}): void {
    if (!this.enabled || !EVENTS.has(event)) return;
    const entry = this.entry(level, event, fields); this.remember(entry);
    if (this.storageFailed) return;
    if (this.pending >= 256) { this.dropped++; return; }
    const line = `${JSON.stringify(entry)}\n`;
    if (Buffer.byteLength(line, 'utf8') > MAX_ENTRY_BYTES) { this.dropped++; return; }
    this.pending++;
    this.tail = this.tail.then(async () => {
      if (this.storageFailed) return;
      await this.initialize();
      const size = Buffer.byteLength(line, 'utf8');
      if (this.bytes + size > this.maxFileBytes) await this.rotate();
      await appendFile(this.activeFile, line, { encoding: 'utf8' }); this.bytes += size;
    }).catch(() => { this.storageFailed = true; }).finally(() => { this.pending--; });
  }
  fault(event: LogEvent, error: unknown, fields: LogFields = {}): void { this.record('warn', event, { ...fields, ...describeLogError(error) }); }

  /** fatal/startup 路径另存一条有界错误，避免进程退出前异步队列未落盘。 */
  emergency(event: 'startup-failed' | 'main-fatal', error: unknown): void {
    const entry = this.entry('error', event, describeLogError(error)); this.remember(entry);
    if (!this.enabled) return;
    try {
      mkdirSync(this.directory, { recursive: true });
      writeFileSync(this.lastErrorFile, `${JSON.stringify(entry)}\n`, { encoding: 'utf8' });
    } catch { this.storageFailed = true; }
  }
  async flush(): Promise<void> {
    let previous: Promise<void>;
    do { previous = this.tail; await previous; } while (previous !== this.tail);
  }
  diagnosticText(): string { return this.reportText(this.history); }
  async diagnosticReport(): Promise<string> {
    await this.flush();
    const entries = [...this.history];
    try {
      const metadata = await stat(this.lastErrorFile);
      if (metadata.size <= MAX_ENTRY_BYTES) {
        const saved = parseSavedEntry(JSON.parse(await readFile(this.lastErrorFile, 'utf8')) as unknown);
        if (saved !== null && !entries.some(entry => JSON.stringify(entry) === JSON.stringify(saved))) entries.push(saved);
      }
    } catch { /* 无旧错误或文件不可读时，仍可复制当前内存诊断。 */ }
    return this.reportText(entries.sort((left, right) => left.at.localeCompare(right.at)).slice(-this.historyLimit));
  }
  ensureDirectory(): Promise<void> { return mkdir(this.directory, { recursive: true }).then(() => {}); }

  private entry(level: LogLevel, event: LogEvent, fields: LogFields): LogEntry {
    return { at: new Date().toISOString(), level, event, appVersion: this.software.appVersion, fields: sanitizeLogFields(fields) };
  }
  private remember(entry: LogEntry): void { this.history.push(entry); if (this.history.length > this.historyLimit) this.history.shift(); }
  private reportText(entries: readonly LogEntry[]): string {
    return ['DshDeck 脱敏诊断报告', `生成时间：${new Date().toISOString()}`,
      `应用：${this.software.appVersion}；候选协议：0.2.2-rc.3`,
      `Electron：${this.software.electronVersion}；Node：${this.software.nodeVersion}；Chromium：${this.software.chromeVersion}`,
      `平台：${this.software.platform} ${this.software.arch}`,
      `日志：${this.enabled ? '默认开启' : '已关闭'}；磁盘：${this.storageFailed ? '不可写，使用内存兜底' : '可用或初始化中'}；拥塞丢弃：${this.dropped}`,
      '不含登录凭据、认证链接、服务器地址、输入或会话正文；复制不会自动上传。',
      '最近诊断事件：', ...entries.map(entry => JSON.stringify(entry)), ''].join('\n');
  }
  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.directory, { recursive: true });
    try { this.bytes = (await stat(this.activeFile)).size; }
    catch (error) { if (!isMissing(error)) throw error; }
    this.initialized = true;
  }
  private async rotate(): Promise<void> {
    await unlink(join(this.directory, `dshdeck.${this.backups}.log`)).catch(error => { if (!isMissing(error)) throw error; });
    for (let index = this.backups - 1; index >= 1; index--) {
      await rename(join(this.directory, `dshdeck.${index}.log`), join(this.directory, `dshdeck.${index + 1}.log`))
        .catch(error => { if (!isMissing(error)) throw error; });
    }
    await rename(this.activeFile, join(this.directory, 'dshdeck.1.log')).catch(error => { if (!isMissing(error)) throw error; });
    this.bytes = 0;
  }
}
function version(value: string): string { return /^[\d][\da-z.+-]{0,63}$/iu.test(value) ? value : 'unknown'; }
function isMissing(error: unknown): boolean { return isRecord(error) && error.code === 'ENOENT'; }
function parseSavedEntry(value: unknown): LogEntry | null {
  if (!isRecord(value) || typeof value.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.at)
    || !['info', 'warn', 'error'].includes(String(value.level)) || !EVENTS.has(value.event as LogEvent) || typeof value.appVersion !== 'string') return null;
  return { at: value.at, level: value.level as LogLevel, event: value.event as LogEvent, appVersion: version(value.appVersion), fields: sanitizeLogFields(value.fields) };
}
