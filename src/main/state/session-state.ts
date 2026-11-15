import type { ServerScope, SessionFacts, SessionPreference, TaskProjection, TerminalEvidence } from '../../shared/domain.js';
import { preferenceKey, resultKey, sessionKey } from '../../shared/domain.js';
import type { DirectorySession } from './directory-store.js';

/** 权威事实与颜色分离；后台只更新事实，不推进本地阅读位置。 */
export class SessionStateStore {
  private readonly scopes = new Map<string, ServerScope>();
  private readonly facts = new Map<string, SessionFacts>();

  beginScope(scope: ServerScope): void {
    const previous = this.scopes.get(scope.serverId);
    if (previous?.authProfileId === scope.authProfileId && previous.generation >= scope.generation) return;
    for (const [key, value] of this.facts) if (value.serverId === scope.serverId) this.facts.delete(key);
    this.scopes.set(scope.serverId, { ...scope });
  }
  upsert(scope: ServerScope, summary: DirectorySession): void {
    if (!this.matches(scope)) return;
    const key = sessionKey(scope.serverId, summary.sessionId);
    const previous = this.facts.get(key);
    const running = previous?.stateObserved ? previous.running : summary.running;
    this.facts.set(key, {
      ...scope, sessionId: summary.sessionId, title: summary.title ?? previous?.title ?? summary.sessionId,
      running, agentAvailable: previous?.stateObserved ? previous.agentAvailable : summary.agentAvailable,
      freshness: 'fresh', accessible: previous?.accessible ?? true, archived: previous?.archived ?? false,
      cursor: previous?.cursor ?? -1, baselineCursor: previous?.baselineCursor ?? null,
      pendingIds: previous?.pendingIds ?? [], terminal: running && !previous?.running ? null : previous?.terminal ?? null,
      terminalIsNew: running && !previous?.running ? false : previous?.terminalIsNew ?? false,
      stateObserved: previous?.stateObserved ?? false,
    });
  }
  primeCursor(scope: ServerScope, sessionId: string, cursor: number): void {
    this.update(scope, sessionId, facts => ({ ...facts, baselineCursor: facts.baselineCursor ?? cursor, cursor: Math.max(facts.cursor, cursor) }));
  }
  setState(scope: ServerScope, sessionId: string, state: { cursor: number; running: boolean; active: boolean; pendingIds: readonly string[] }): void {
    this.update(scope, sessionId, facts => state.cursor < facts.cursor ? facts : ({
      ...facts, cursor: state.cursor, baselineCursor: facts.baselineCursor ?? state.cursor,
      running: state.running, agentAvailable: state.active, pendingIds: [...state.pendingIds], stateObserved: true,
      terminal: state.running && !facts.running ? null : facts.terminal,
      terminalIsNew: state.running && !facts.running ? false : facts.terminalIsNew,
    }));
  }
  setRunning(scope: ServerScope, sessionId: string, running: boolean): void {
    this.update(scope, sessionId, facts => ({ ...facts, running, stateObserved: true,
      terminal: running && !facts.running ? null : facts.terminal,
      terminalIsNew: running && !facts.running ? false : facts.terminalIsNew,
    }));
  }
  setPending(scope: ServerScope, sessionId: string, pendingIds: readonly string[]): void {
    this.update(scope, sessionId, facts => ({ ...facts, pendingIds: [...new Set([...facts.pendingIds.filter(id => id.startsWith('state:')), ...pendingIds])] }));
  }
  setTitle(scope: ServerScope, sessionId: string, title: string): void { this.update(scope, sessionId, facts => ({ ...facts, title })); }
  terminal(scope: ServerScope, sessionId: string, result: TerminalEvidence, live: boolean): void {
    this.update(scope, sessionId, facts => {
      if (result.seq < (facts.terminal?.seq ?? -1)) return facts;
      return {
        ...facts, running: false, terminal: { ...result },
        cursor: Math.max(facts.cursor, result.seq),
        terminalIsNew: live && result.seq > (facts.baselineCursor ?? -1),
      };
    });
  }
  setArchived(scope: ServerScope, sessionId: string, archived: boolean): void { this.update(scope, sessionId, facts => ({ ...facts, archived })); }
  revoke(scope: ServerScope, sessionId: string): void { this.update(scope, sessionId, facts => ({ ...facts, accessible: false, pendingIds: [], freshness: 'stale' })); }
  markStale(serverId: string): void { for (const [key, facts] of this.facts) if (facts.serverId === serverId) this.facts.set(key, { ...facts, freshness: 'stale' }); }
  clear(serverId: string): void { this.scopes.delete(serverId); for (const [key, facts] of this.facts) if (facts.serverId === serverId) this.facts.delete(key); }
  get(serverId: string, sessionId: string): SessionFacts | undefined { const facts = this.facts.get(sessionKey(serverId, sessionId)); return facts === undefined ? undefined : cloneFacts(facts); }
  all(): readonly SessionFacts[] { return [...this.facts.values()].map(cloneFacts); }

  private matches(scope: ServerScope): boolean { const current = this.scopes.get(scope.serverId); return current?.authProfileId === scope.authProfileId && current.generation === scope.generation; }
  private update(scope: ServerScope, sessionId: string, apply: (facts: SessionFacts) => SessionFacts): void {
    if (!this.matches(scope)) return;
    const key = sessionKey(scope.serverId, sessionId);
    const facts = this.facts.get(key);
    if (facts !== undefined) this.facts.set(key, apply(facts));
  }
}

export function projectTasks(facts: readonly SessionFacts[], preferences: (key: string) => SessionPreference): readonly TaskProjection[] {
  const tasks: TaskProjection[] = [];
  const seen = new Set<string>();
  for (const session of facts) {
    const id = preferenceKey(session.serverId, session.authProfileId, session.sessionId);
    if (seen.has(id)) continue;
    seen.add(id);
    const preference = preferences(id);
    if (!preference.followed || !session.accessible || session.archived) continue;
    const resultId = session.terminal === null ? null : resultKey(session.terminal);
    let color: TaskProjection['color'] | null = null;
    if (session.pendingIds.length > 0) color = 'yellow';
    else if (session.running) color = 'green';
    else if (session.terminalIsNew && resultId !== preference.acknowledgedResult) {
      if (session.terminal?.kind === 'failed') color = 'red';
      else if (session.terminal?.kind === 'completed') color = 'blue';
    }
    if (color !== null) tasks.push({
      id, serverId: session.serverId, authProfileId: session.authProfileId, generation: session.generation,
      sessionId: session.sessionId, title: session.title, color, freshness: session.freshness,
      resultId: color === 'yellow' ? JSON.stringify(['pending', session.pendingIds]) : resultId,
    });
  }
  return tasks;
}
function cloneFacts(facts: SessionFacts): SessionFacts { return { ...facts, pendingIds: [...facts.pendingIds], terminal: facts.terminal === null ? null : { ...facts.terminal } }; }
