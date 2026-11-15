import type { PublicFailure } from './faults.js';
import type { AnswerInput, ReadConfirmation, SendTextInput, SessionContext, WorkbenchSettings, WorkbenchSnapshot } from './domain.js';
import type { AppearancePatch, AppearanceSettings } from './appearance.js';
import type { WebViewport } from './session-web.js';
import type { WorkbenchCommand } from './workbench-commands.js';

export interface ServerInput {
  readonly alias: string;
  readonly baseUrl: string;
  readonly proxyMode?: 'system' | 'direct';
}

/** 只有非敏感配置；登录态留在该 profile 的 Chromium 分区。 */
export interface ServerConfig extends ServerInput {
  readonly id: string;
  readonly authProfileId: string;
}

export type ConnectionState =
  | 'idle' | 'authenticating' | 'probing' | 'readonly-ready'
  | 'auth-required' | 'denied' | 'incompatible' | 'failed' | 'cancelled';

export interface WorkspaceBrief {
  readonly workspaceId: string;
  readonly title: string;
  readonly path: string;
  readonly sessionIds: readonly string[];
}

export interface SessionBrief {
  readonly sessionId: string;
  readonly running: boolean;
  readonly agentAvailable: boolean;
  readonly blank: boolean;
  readonly updatedAt: number;
  readonly title?: string;
  /** cached 水位不能与当前连接的 sequenced 水位直接比较。 */
  readonly titleHint?: { readonly kind: 'cached' | 'sequenced'; readonly asOfSeq: number };
  readonly parentSessionId?: string;
  readonly origin?: 'subagent';
  readonly cwd?: string;
  readonly formatStatus?: 'current' | 'migration-required';
}

export interface ProbeSampleInput {
  readonly sessionId: string;
  readonly mode: 'realtime' | 'periodic';
  readonly stateStream: 'observe-state' | 'control';
  readonly durationSeconds: number;
  readonly intervalSeconds: number;
}

export interface ProbeCounters {
  readonly httpBodyBytes: number;
  readonly detailTextBytes: number;
  readonly stateTextBytes: number;
  readonly detailItems: number;
  readonly stateItems: number;
  readonly snapshotCount: number;
}

/** 只统计已解码载荷，不冒充包含压缩、握手和心跳的线上总字节。 */
export interface ProbeSampleResult extends ProbeCounters {
  readonly mode: ProbeSampleInput['mode'];
  readonly stateStream: ProbeSampleInput['stateStream'];
  readonly elapsedMs: number;
  readonly stopped: boolean;
  readonly lastCursor: number | null;
  readonly beforeAgentAvailable: boolean | null;
  readonly afterAgentAvailable: boolean | null;
  readonly byteBasis: 'decoded-body-and-ws-text';
  readonly sideEffectsVerified: false;
}

export interface ServerSnapshot {
  readonly config: ServerConfig;
  readonly state: ConnectionState;
  readonly generation: number;
  readonly workspaces: readonly WorkspaceBrief[];
  readonly sessions: readonly SessionBrief[];
  readonly failure: PublicFailure | null;
  readonly sample: ProbeSampleResult | null;
}

export type IpcResult<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PublicFailure };

export interface RendererFailure {
  readonly kind: 'error' | 'unhandled-rejection';
  readonly line?: number;
  readonly column?: number;
}
export interface AppBridge {
  listServers(): Promise<IpcResult<readonly ServerSnapshot[]>>;
  addServer(input: ServerInput): Promise<IpcResult<ServerSnapshot>>;
  editServer(id: string, input: ServerInput): Promise<IpcResult<ServerSnapshot>>;
  connectServer(id: string): Promise<IpcResult<ServerSnapshot>>;
  authenticateServer(id: string): Promise<IpcResult<void>>;
  disconnectServer(id: string): Promise<IpcResult<ServerSnapshot>>;
  runSample(id: string, input: ProbeSampleInput): Promise<IpcResult<ProbeSampleResult>>;
  stopSample(id: string): Promise<IpcResult<void>>;
  workbench(sinceRevision?: number): Promise<IpcResult<WorkbenchSnapshot | null>>;
  selectSession(context: SessionContext): Promise<IpcResult<WorkbenchSnapshot>>;
  setFollowed(context: SessionContext, followed: boolean): Promise<IpcResult<void>>;
  setManualUnread(context: SessionContext, unread: boolean): Promise<IpcResult<void>>;
  setDraft(context: SessionContext, text: string): Promise<IpcResult<void>>;
  sendText(input: SendTextInput): Promise<IpcResult<void>>;
  stopRemote(context: SessionContext): Promise<IpcResult<void>>;
  answer(input: AnswerInput): Promise<IpcResult<void>>;
  syncNow(context: SessionContext): Promise<IpcResult<void>>;
  loadOlder(context: SessionContext): Promise<IpcResult<void>>;
  confirmRead(input: ReadConfirmation): Promise<IpcResult<void>>;
  updateSettings(settings: WorkbenchSettings, appearance?: AppearanceSettings): Promise<IpcResult<void>>;
  openFallback(serverId: string): Promise<IpcResult<void>>;
  openWholeServer(serverId: string): Promise<IpcResult<void>>;
  closeFallback(): Promise<IpcResult<void>>;
  choosePetPath(kind: 'runtime' | 'resources'): Promise<IpcResult<void>>;
  selectPet(id: string): Promise<IpcResult<void>>;
  rescanPets(): Promise<IpcResult<void>>;
  basicCredentialInfo(id: string): Promise<IpcResult<BasicCredentialInfo>>;
  editBasicCredentials(id: string): Promise<IpcResult<void>>;
  forgetBasicCredentials(id: string): Promise<IpcResult<void>>;
  updateAppearance(input: AppearancePatch): Promise<IpcResult<void>>;
  chooseBackground(): Promise<IpcResult<void>>;
  clearBackground(): Promise<IpcResult<void>>;
  setWebViewport(input: WebViewport): Promise<IpcResult<void>>;
  cacheWebLayout(): Promise<IpcResult<{ name: string }>>;
  openCommandMenu(): Promise<IpcResult<WorkbenchCommand>>;
  toggleWebSidebar(): Promise<IpcResult<void>>;
  showWebFiles(): Promise<IpcResult<boolean>>;
  showWebConversation(): Promise<IpcResult<boolean>>;
  openWebLayouts(): Promise<IpcResult<void>>;
  setDemo(enabled: boolean): Promise<IpcResult<void>>;
  openLogs(): Promise<IpcResult<void>>;
  copyDiagnostics(): Promise<IpcResult<void>>;
  reportRendererFailure(input: RendererFailure): Promise<IpcResult<void>>;
  onOpenSettings(listener: () => void): () => void;
}

export interface AuthDescription {
  readonly alias: string;
  readonly baseUrl: string;
}

/** 仅供本地认证控制页；远程认证页面没有这份 preload。 */
export interface AuthBridge {
  describe(): Promise<IpcResult<AuthDescription>>;
  navigate(authorizationUrl: string): Promise<IpcResult<void>>;
  finish(): Promise<IpcResult<void>>;
  cancel(): Promise<IpcResult<void>>;
}

export interface BasicCredentialInfo {
  readonly rememberAvailable: boolean;
  readonly remembered: boolean;
  readonly username: string | null;
  readonly rejected: boolean;
  readonly storageFailed: boolean;
}
export interface CredentialInput {
  readonly username: string;
  readonly password: string;
  readonly remember?: boolean;
}

/** 密码只在独立本地认证提示窗输入并传给 main，不经过工作台 UI。 */
export interface CredentialBridge {
  describe(): Promise<IpcResult<{ origin: string; realm: string; username?: string; rememberAvailable?: boolean; remembered?: boolean; saveOnly?: boolean; usernameLocked?: boolean }>>;
  submit(input: CredentialInput): Promise<IpcResult<void>>;
  cancel(): Promise<IpcResult<void>>;
}
