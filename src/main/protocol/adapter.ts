import type { HistoryPage, FollowSnapshot, AssistantFrame, PendingInteraction, ServerScope, SendTextInput, AnswerInput, WireEvent } from '../../shared/domain.js';
import type { ProbeSampleInput, ProbeSampleResult } from '../../shared/contracts.js';
import type { ProtocolFault } from '../../shared/faults.js';
import type { DirectorySession } from '../state/directory-store.js';
import type { WorkspaceReadFrame } from './read-values.js';
import type { NativeFrame, ModelCatalog, ModelSelection, SelectModelInput, GoalActionInput, CommandDescriptor, CommandExecution } from '../../shared/native-controls.js';
import type { WebInteractionOwner } from './interaction-ownership.js';
import type { JobRowsFrame, JobFollowFrame } from '../../shared/jobs.js';

export interface AdapterCallbacks {
  readonly workspaces: (frame: WorkspaceReadFrame) => void;
  readonly sessions: (sessions: readonly DirectorySession[]) => void;
  readonly removed: (sessionId: string) => void;
  readonly running: (sessionId: string, running: boolean) => void;
  readonly state: (sessionId: string, state: { cursor: number; active: boolean; running: boolean; pendingInput: readonly string[] }) => void;
  readonly stateFailed?: (sessionId: string, fault: ProtocolFault) => void;
  readonly pending: (pending: readonly PendingInteraction[]) => void;
  readonly event: (sessionId: string, event: WireEvent, live: boolean) => void;
  readonly failed: (fault: ProtocolFault) => void;
}
export interface FollowCallbacks {
  readonly snapshot: (snapshot: FollowSnapshot) => void;
  readonly event: (event: WireEvent) => void;
  readonly assistant: (frame: AssistantFrame) => void;
  readonly projections?: (frame: NativeFrame) => void;
  readonly projectionsFailed?: (fault: ProtocolFault) => void;
  readonly failed: (fault: ProtocolFault) => void;
}
export interface AdapterSubscription { cancel(): void }
export interface JobRowsCallbacks { readonly item: (frame: JobRowsFrame) => void; readonly failed: (fault: ProtocolFault) => void }
export interface JobOutputCallbacks { readonly item: (frame: JobFollowFrame) => void; readonly failed: (fault: ProtocolFault) => void }
export interface WorkbenchAdapter {
  readonly scope: ServerScope;
  readonly source: 'live' | 'synthetic';
  connect(): Promise<{ workspaces: readonly import('../../shared/contracts.js').WorkspaceBrief[]; sessions: readonly DirectorySession[] }>;
  follow(sessionId: string, callbacks: FollowCallbacks, signal: AbortSignal): Promise<AdapterSubscription>;
  opening(sessionId: string, signal: AbortSignal, purpose?: 'foreground' | 'background'): Promise<FollowSnapshot>;
  history(sessionId: string, beforeSeq: number, throughSeq: number, signal: AbortSignal): Promise<HistoryPage>;
  send(input: SendTextInput, signal: AbortSignal): Promise<void>;
  stop(sessionId: string, signal: AbortSignal): Promise<void>;
  answer(input: AnswerInput, signal: AbortSignal): Promise<void>;
  watchJobRows?(sessionId: string, callbacks: JobRowsCallbacks, signal: AbortSignal): AdapterSubscription;
  followJob?(sessionId: string, jobId: string, from: number | undefined, callbacks: JobOutputCallbacks, signal: AbortSignal): AdapterSubscription;
  modelCatalog?(signal: AbortSignal, refresh?: boolean): Promise<ModelCatalog>;
  commands?(sessionId: string, signal: AbortSignal, refresh?: boolean): Promise<readonly CommandDescriptor[]>;
  selectModel?(input: SelectModelInput, signal: AbortSignal): Promise<ModelSelection>;
  goalAction?(input: GoalActionInput, signal: AbortSignal): Promise<void>;
  executeCommand?(input: SendTextInput, signal: AbortSignal): Promise<CommandExecution>;
  sample(input: ProbeSampleInput): Promise<ProbeSampleResult>;
  stopSample(): void;
  setWebOwner?(owner: WebInteractionOwner | null): void;
  dispose(): void;
}
