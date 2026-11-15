import { ProtocolFault } from '../../shared/faults.js';
import type { FollowSnapshot, HistoryPage, ServerScope, SendTextInput, AnswerInput } from '../../shared/domain.js';
import type { ProbeSampleInput, ProbeSampleResult } from '../../shared/contracts.js';
import type { WorkbenchAdapter, AdapterCallbacks, FollowCallbacks, AdapterSubscription } from './adapter.js';

/** 显式演示模式的静态夹具，不联网、不自动发送，也不声明部署兼容。 */
export class MockAdapter implements WorkbenchAdapter {
  readonly source = 'synthetic' as const;
  private disposed = false;
  private readonly snapshot: FollowSnapshot;
  constructor(readonly scope: ServerScope, private readonly callbacks: AdapterCallbacks) {
    this.snapshot = {
      header: { id: 'demo-session', createdAt: 1, version: 1 }, cursor: 1, hasMore: false,
      projections: {}, assistant: { revision: 0, activeAttempt: null },
      events: [
        { type: 'demo/user', seq: 0, time: 1, data: { text: '这是演示会话，只展示界面。' }, ignorable: true },
        { type: 'demo/assistant', seq: 1, time: 2, data: { text: '真实连接需要你在内置浏览器登录；演示模式不会访问服务器。' }, ignorable: true },
      ],
    };
  }
  async connect() {
    this.assertActive();
    const workspaces = [{ workspaceId: 'demo-workspace', title: '演示工作区', path: '合成夹具 · 不是真实服务器', sessionIds: ['demo-session'] }];
    const sessions = [{ sessionId: 'demo-session', title: '界面演示（不联网）', running: false, agentAvailable: false, blank: false, updatedAt: 2 }];
    this.callbacks.sessions(sessions);
    this.callbacks.workspaces({ type: 'baseline', value: { items: workspaces, archivedSessionIds: [], pinnedSessionIds: [] } });
    this.callbacks.state('demo-session', { cursor: 1, active: false, running: false, pendingInput: [] });
    return { workspaces, sessions };
  }
  async follow(_sessionId: string, callbacks: FollowCallbacks, signal: AbortSignal): Promise<AdapterSubscription> {
    this.assertActive(signal);
    callbacks.snapshot(structuredClone(this.snapshot));
    return { cancel: () => {} };
  }
  async opening(_sessionId: string, signal: AbortSignal): Promise<FollowSnapshot> { this.assertActive(signal); return structuredClone(this.snapshot); }
  async history(_sessionId: string, _beforeSeq: number, _throughSeq: number, signal: AbortSignal): Promise<HistoryPage> { this.assertActive(signal); return { cursor: this.snapshot.cursor, hasMore: false, events: [] }; }
  async send(_input: SendTextInput, _signal: AbortSignal): Promise<void> { throw new ProtocolFault('unsupported'); }
  async stop(_sessionId: string, _signal: AbortSignal): Promise<void> { throw new ProtocolFault('unsupported'); }
  async answer(_input: AnswerInput, _signal: AbortSignal): Promise<void> { throw new ProtocolFault('unsupported'); }
  async sample(_input: ProbeSampleInput): Promise<ProbeSampleResult> { throw new ProtocolFault('unsupported'); }
  stopSample(): void {}
  dispose(): void { this.disposed = true; }
  private assertActive(signal?: AbortSignal): void { if (this.disposed || signal?.aborted) throw new ProtocolFault('cancelled'); }
}
