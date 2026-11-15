import type { ServerRow, SessionContext, SessionRow, TaskCounts, WorkspaceRow } from '../../shared/domain.js';
import { emptyCounts } from '../../shared/domain.js';

export type TreeFilter = 'all' | 'followed' | 'running' | 'pending' | 'unread';
export interface TreeQuery { readonly text: string; readonly filter: TreeFilter; readonly showArchived: boolean }
export interface VisibleServer { readonly server: ServerRow; readonly workspaces: readonly WorkspaceRow[]; readonly unassigned: readonly SessionRow[] }

/** 只过滤元信息，保留命中项的祖先；不改变真实目录、选择或订阅。 */
export function filterTree(servers: readonly ServerRow[], query: TreeQuery): readonly VisibleServer[] {
  const text = query.text.trim().toLocaleLowerCase();
  const matches = (session: SessionRow, ancestorMatched: boolean): boolean => {
    if (session.archived && !query.showArchived) return false;
    if (query.filter === 'followed' && !session.followed) return false;
    if (query.filter === 'running' && !session.running) return false;
    if (query.filter === 'pending' && session.pendingCount === 0) return false;
    if (query.filter === 'unread' && !session.unread) return false;
    return text === '' || ancestorMatched || `${session.title} ${session.sessionId}`.toLocaleLowerCase().includes(text);
  };
  return servers.flatMap(server => {
    const serverMatch = text !== '' && `${server.config.alias} ${server.config.baseUrl}`.toLocaleLowerCase().includes(text);
    const workspaces = server.tree.flatMap(workspace => {
      const ancestorMatch = serverMatch || (text !== '' && `${workspace.title} ${workspace.path}`.toLocaleLowerCase().includes(text));
      const sessions = workspace.sessions.filter(session => matches(session, ancestorMatch));
      if (sessions.length === 0 && !(query.filter === 'all' && (text === '' || ancestorMatch))) return [];
      return [{ ...workspace, sessions }];
    });
    const unassigned = server.unassigned.filter(session => matches(session, serverMatch));
    if (workspaces.length === 0 && unassigned.length === 0 && !(query.filter === 'all' && (text === '' || serverMatch))) return [];
    return [{ server, workspaces, unassigned }];
  });
}
export function contextFor(server: ServerRow, workspaceId: string | null, sessionId: string): SessionContext {
  return { serverId: server.config.id, authProfileId: server.config.authProfileId, generation: server.generation, workspaceId, sessionId };
}
export function isSelected(context: SessionContext, selected: SessionContext | null): boolean {
  return selected !== null && selected.serverId === context.serverId && selected.authProfileId === context.authProfileId
    && selected.sessionId === context.sessionId && selected.generation === context.generation;
}
export function selectedFilteredOut(visible: readonly VisibleServer[], selected: SessionContext | null): boolean {
  if (selected === null) return false;
  return !visible.some(item => item.server.config.id === selected.serverId && [...item.unassigned, ...item.workspaces.flatMap(workspace => workspace.sessions)]
    .some(session => session.sessionId === selected.sessionId));
}
export function visibleCounts(sessions: readonly SessionRow[]): TaskCounts {
  const counts = { ...emptyCounts() };
  const seen = new Set<string>();
  for (const session of sessions) {
    if (seen.has(session.sessionId)) continue;
    seen.add(session.sessionId);
    if (session.followed && session.task !== null) counts[session.task]++;
  }
  return counts;
}
