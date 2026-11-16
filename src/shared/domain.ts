import { ProtocolFault, requireId, requireKeys, requireRecord } from './faults.js';
import type { PublicFailure } from './faults.js';
import type { ServerSnapshot, SessionBrief, WorkspaceBrief } from './contracts.js';
import type { AppearanceView } from './appearance.js';
import type { SessionWebState } from './session-web.js';
import type { RecoveryView } from './recovery.js';
import type { PetDisplaySettings } from './pet-display.js';

export interface ServerScope {
  readonly serverId: string;
  readonly authProfileId: string;
  readonly generation: number;
}
export interface SessionContext extends ServerScope {
  readonly workspaceId: string | null;
  readonly sessionId: string;
}
export type Freshness = 'fresh' | 'stale';
export type TaskColor = 'green' | 'yellow' | 'red' | 'blue';
export interface TerminalEvidence {
  readonly kind: 'completed' | 'failed' | 'cancelled' | 'unknown';
  readonly turn: number;
  readonly seq: number;
}
export interface SessionPreference {
  readonly followed: boolean;
  readonly readSeq: number;
  readonly acknowledgedResult: string | null;
  readonly manualUnread: boolean;
}
export interface SessionFacts extends ServerScope {
  readonly sessionId: string;
  readonly title: string;
  readonly running: boolean;
  readonly agentAvailable: boolean;
  readonly freshness: Freshness;
  readonly accessible: boolean;
  readonly archived: boolean;
  readonly cursor: number;
  readonly baselineCursor: number | null;
  readonly pendingIds: readonly string[];
  readonly terminal: TerminalEvidence | null;
  readonly terminalIsNew: boolean;
  readonly stateObserved: boolean;
}
export interface TaskProjection extends ServerScope {
  readonly id: string;
  readonly sessionId: string;
  readonly title: string;
  readonly color: TaskColor;
  readonly freshness: Freshness;
  readonly resultId: string | null;
}
export interface TaskCounts { readonly green: number; readonly yellow: number; readonly red: number; readonly blue: number }
export interface SessionRow extends SessionBrief {
  readonly title: string;
  readonly followed: boolean;
  readonly unread: boolean;
  readonly archived: boolean;
  readonly pendingCount: number;
  readonly task: TaskColor | null;
  readonly freshness: Freshness;
}
export interface WorkspaceRow extends WorkspaceBrief { readonly sessions: readonly SessionRow[]; readonly counts: TaskCounts }
export interface ServerRow extends ServerSnapshot {
  readonly tree: readonly WorkspaceRow[];
  readonly unassigned: readonly SessionRow[];
  readonly counts: TaskCounts;
  readonly protocolProfile: string;
  readonly deploymentVerified: false;
  readonly directoryReady?: boolean;
  readonly recovery?: RecoveryView;
}
export interface WireEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: unknown;
  readonly ignorable?: true;
  readonly sourceEventSeqs?: unknown;
  readonly surfaceOp?: unknown;
}
export interface AssistantAttempt {
  readonly attemptId: string;
  readonly startedAfterSeq: number;
  readonly turn: number;
  readonly step: number;
  readonly nextIndex: number;
  readonly stream: readonly unknown[];
}
export interface AssistantBaseline { readonly revision: number; readonly activeAttempt: AssistantAttempt | null }
export interface HistoryPage { readonly cursor: number; readonly hasMore: boolean; readonly events: readonly WireEvent[] }
export interface FollowSnapshot extends HistoryPage {
  readonly header: { readonly id: string; readonly createdAt: number; readonly version: number };
  readonly projections: Readonly<Record<string, unknown>>;
  readonly assistant: AssistantBaseline;
}
export type AssistantFrame =
  | { readonly type: 'start'; readonly attemptId: string; readonly revision: number; readonly startedAfterSeq: number; readonly turn: number; readonly step: number }
  | { readonly type: 'chunk'; readonly attemptId: string; readonly revision: number; readonly index: number; readonly time: number; readonly chunk: unknown }
  | { readonly type: 'end'; readonly attemptId: string; readonly revision: number; readonly index: number; readonly outcome: { readonly kind: 'committed'; readonly seq: number; readonly eventType: string } | { readonly kind: 'abandoned' } };
export type ConversationStatus = 'empty' | 'loading' | 'cached' | 'live' | 'stale' | 'gap' | 'error';
export interface ConversationView {
  readonly context: SessionContext;
  readonly title: string;
  readonly status: ConversationStatus;
  readonly events: readonly WireEvent[];
  readonly assistant: AssistantBaseline;
  readonly cursor: number;
  readonly hasMore: boolean;
  readonly hasGap: boolean;
  readonly syncedAt: number | null;
  readonly syncing: boolean;
  readonly native?: import('./native-controls.js').NativeSnapshot;
  readonly draft: string;
  readonly failure: PublicFailure | null;
  readonly recovery?: RecoveryView;
  readonly pending: readonly PendingInteraction[];
  readonly sendState: 'idle' | 'sending' | 'accepted' | 'uncertain';
}
export interface QuestionItem {
  readonly id: string;
  readonly question: string;
  readonly detail: string;
  readonly options: readonly { readonly label: string; readonly description: string }[];
  readonly multiSelect: boolean;
  readonly fixedApproval: boolean;
}
export interface PendingInteraction extends ServerScope {
  readonly id: string;
  readonly sessionId: string;
  readonly name: string;
  readonly kind: 'question' | 'approval' | 'unsupported';
  readonly prompt: string;
  readonly choices: readonly { readonly id: string; readonly label: string }[];
  readonly openedAt: number;
  readonly questions: readonly QuestionItem[];
}
export interface WorkbenchSettings {
  readonly syncIntervalSeconds: number;
  readonly notifications: boolean;
  readonly sidebarWidth: number;
  readonly theme: 'system' | 'light' | 'dark';
  readonly petEnabled: boolean;
}
export interface PetChoice { readonly id: string; readonly name: string; readonly available: boolean; readonly message: string }
export interface PetStatus {
  readonly state: 'disabled' | 'ready' | 'starting' | 'running' | 'unavailable' | 'failed';
  readonly resourceRoot: string | null;
  readonly display: PetDisplaySettings;
  readonly choices?: readonly PetChoice[];
  readonly selectedPetId?: string | null;
  readonly scanning?: boolean;
  readonly truncated?: boolean;
  readonly message: string;
}
export interface WorkbenchSnapshot {
  readonly revision: number;
  readonly servers: readonly ServerRow[];
  readonly tasks: readonly TaskProjection[];
  readonly counts: TaskCounts;
  readonly selected: SessionContext | null;
  readonly conversation: ConversationView | null;
  readonly settings: WorkbenchSettings;
  readonly pet: PetStatus;
  readonly demo: boolean;
  readonly appearance?: AppearanceView;
  readonly web?: SessionWebState;
}
export interface SendTextInput { readonly context: SessionContext; readonly requestId: string; readonly text: string }
export interface AnswerInput { readonly context: SessionContext; readonly interactionId: string; readonly value: string }
export interface ReadConfirmation { readonly context: SessionContext; readonly throughSeq: number; readonly visible: boolean; readonly focused: boolean }

/** 工作区不是稳定会话身份的一部分；账户隔离由另外的 profile 键承担。 */
export function sessionKey(serverId: string, sessionId: string): string {
  return JSON.stringify([requireId(serverId), requireId(sessionId)]);
}
export function preferenceKey(serverId: string, authProfileId: string, sessionId: string): string {
  return JSON.stringify([requireId(serverId), requireId(authProfileId), requireId(sessionId)]);
}
export function resultKey(result: TerminalEvidence): string { return JSON.stringify([result.turn, result.seq, result.kind]); }
export function parseContext(value: unknown): SessionContext {
  const input = requireRecord(value);
  requireKeys(input, ['serverId', 'authProfileId', 'generation', 'workspaceId', 'sessionId']);
  if (typeof input.generation !== 'number' || !Number.isSafeInteger(input.generation) || input.generation < 0) throw new ProtocolFault('protocol');
  return {
    serverId: requireId(input.serverId), authProfileId: requireId(input.authProfileId), generation: input.generation,
    workspaceId: input.workspaceId === null ? null : requireId(input.workspaceId), sessionId: requireId(input.sessionId),
  };
}
export function emptyCounts(): TaskCounts { return { green: 0, yellow: 0, red: 0, blue: 0 }; }
export function countTasks(tasks: readonly TaskProjection[]): TaskCounts {
  const counts = { green: 0, yellow: 0, red: 0, blue: 0 };
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    counts[task.color]++;
  }
  return counts;
}
export function taskMood(tasks: readonly TaskProjection[]): TaskColor | 'idle' {
  const counts = countTasks(tasks);
  for (const color of ['yellow', 'red', 'green', 'blue'] as const) if (counts[color] > 0) return color;
  return 'idle';
}
