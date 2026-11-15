import type { ServerRow, SessionContext, SessionRow, TaskCounts, WorkspaceRow } from '../../shared/domain.js';
import { emptyCounts, sessionKey } from '../../shared/domain.js';

export type TreeFilter = 'all' | 'followed' | 'running' | 'pending' | 'unread';
export interface TreeQuery { readonly text: string; readonly filter: TreeFilter; readonly showArchived: boolean; readonly showSubagents?: boolean }
export interface VisibleServer { readonly server: ServerRow; readonly workspaces: readonly WorkspaceRow[]; readonly unassigned: readonly SessionRow[] }

/** 只过滤元信息，保留命中项的祖先；不改变真实目录、选择或订阅。 */
export function filterTree(servers: readonly ServerRow[], query: TreeQuery, selected: SessionContext | null = null): readonly VisibleServer[] {
  const text = query.text.trim().toLocaleLowerCase();
  const matches = (session: SessionRow, ancestorMatched: boolean, server: ServerRow): boolean => {
    if (session.blank && !session.running && !(selected?.serverId === server.config.id && selected.authProfileId === server.config.authProfileId && selected.sessionId === session.sessionId && selected.generation === server.generation)) return false;
    if (session.origin === 'subagent' && !query.showSubagents) return false;
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
      const sessions = workspace.sessions.filter(session => matches(session, ancestorMatch, server));
      if (sessions.length === 0 && !(query.filter === 'all' && (text === '' || ancestorMatch))) return [];
      return [{ ...workspace, sessions }];
    });
    const unassigned = server.unassigned.filter(session => matches(session, serverMatch, server));
    if (workspaces.length === 0 && unassigned.length === 0 && !(query.filter === 'all' && (text === '' || serverMatch))) return [];
    return [{ server, workspaces, unassigned }];
  });
}
export interface FollowedSessionIcon { readonly context: SessionContext; readonly session: SessionRow; readonly serverName: string; readonly workspaceName: string }

/** 图标来自权威目录而非终态任务表：休眠的关注会话仍可跳转，已删除／归档不留幽灵图标。 */
export function followedSessionIcons(servers: readonly ServerRow[], selected: SessionContext | null): readonly FollowedSessionIcon[] {
  const items: FollowedSessionIcon[] = []; const seen = new Set<string>();
  for (const server of servers) {
    const add = (session: SessionRow, workspaceId: string | null, workspaceName: string): void => {
      const key = sessionKey(server.config.id, session.sessionId);
      if (!session.followed || session.archived || seen.has(key) || session.blank && !session.running && !(selected?.serverId === server.config.id && selected.sessionId === session.sessionId)) return;
      seen.add(key); items.push({ context: contextFor(server, workspaceId, session.sessionId), session, serverName: server.config.alias, workspaceName });
    };
    for (const workspace of server.tree) for (const session of workspace.sessions) add(session, workspace.workspaceId, workspace.title);
    for (const session of server.unassigned) add(session, null, '未归属工作区');
  }
  return items;
}
export function sessionIconTitle(item: FollowedSessionIcon): string {
  return `${item.session.title}\n会话 ID：${item.session.sessionId}\n服务器：${item.serverName}\n工作区：${item.workspaceName}`;
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
