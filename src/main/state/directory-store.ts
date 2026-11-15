import type { SessionBrief, WorkspaceBrief } from '../../shared/contracts.js';
import type { ServerScope, SessionContext } from '../../shared/domain.js';
import { ProtocolFault } from '../../shared/faults.js';
import type { WorkspaceReadFrame } from '../protocol/read-values.js';

export interface DirectorySession extends SessionBrief { readonly title?: string }
interface ServerDirectory {
  scope: ServerScope;
  readonly sessions: Map<string, DirectorySession>;
  readonly workspaces: Map<string, WorkspaceBrief>;
  readonly tombstones: Set<string>;
  archived: Set<string>;
  pinned: Set<string>;
  order: string[];
  listed: boolean;
  based: boolean;
  fresh: boolean;
}

/** 目录代次与删除标记是路由的权限边界，不能用迟到的摘要恢复旧实体。 */
export class DirectoryStore {
  private readonly servers = new Map<string, ServerDirectory>();

  begin(scope: ServerScope): void {
    const previous = this.servers.get(scope.serverId);
    if (previous !== undefined && scope.generation <= previous.scope.generation && scope.authProfileId === previous.scope.authProfileId) return;
    this.servers.set(scope.serverId, {
      scope: { ...scope }, sessions: new Map(), workspaces: new Map(), tombstones: new Set(),
      archived: new Set(), pinned: new Set(), order: [], listed: false, based: false, fresh: true,
    });
  }

  replaceSessions(scope: ServerScope, sessions: readonly DirectorySession[]): void {
    const server = this.match(scope);
    if (server === undefined) return;
    const ids = new Set(sessions.map(session => session.sessionId));
    for (const id of server.sessions.keys()) if (!ids.has(id)) server.tombstones.add(id);
    server.sessions.clear();
    for (const session of sessions) if (!server.tombstones.has(session.sessionId)) server.sessions.set(session.sessionId, { ...session });
    server.listed = true;
  }

  upsertSession(scope: ServerScope, session: DirectorySession): void {
    const server = this.match(scope);
    if (server === undefined || server.tombstones.has(session.sessionId)) return;
    server.sessions.set(session.sessionId, { ...session });
  }

  removeSession(scope: ServerScope, sessionId: string): void {
    const server = this.match(scope);
    if (server === undefined) return;
    server.tombstones.add(sessionId);
    server.sessions.delete(sessionId);
  }

  applyWorkspaces(scope: ServerScope, frame: WorkspaceReadFrame): void {
    const server = this.match(scope);
    if (server === undefined) return;
    switch (frame.type) {
      case 'baseline':
      case 'replace': {
        if (frame.type === 'replace') {
          const allowed = new Set(frame.value.items.flatMap(workspace => workspace.sessionIds));
          for (const old of server.workspaces.values()) {
            for (const id of old.sessionIds) if (!allowed.has(id)) this.removeSession(scope, id);
          }
        }
        server.workspaces.clear();
        for (const workspace of frame.value.items) server.workspaces.set(workspace.workspaceId, cloneWorkspace(workspace));
        server.order = frame.value.items.map(workspace => workspace.workspaceId);
        server.archived = new Set(frame.value.archivedSessionIds);
        server.pinned = new Set(frame.value.pinnedSessionIds);
        server.based = true;
        break;
      }
      case 'upsert':
        server.workspaces.set(frame.workspace.workspaceId, cloneWorkspace(frame.workspace));
        if (!server.order.includes(frame.workspace.workspaceId)) server.order.push(frame.workspace.workspaceId);
        break;
      case 'remove':
        server.workspaces.delete(frame.workspaceId);
        server.order = server.order.filter(id => id !== frame.workspaceId);
        break;
      case 'order':
        server.order = [...frame.workspaceIds];
        break;
      case 'archived': server.archived = new Set(frame.archivedSessionIds); break;
      case 'pinned': server.pinned = new Set(frame.pinnedSessionIds); break;
    }
  }

  scope(serverId: string): ServerScope | undefined { const scope = this.servers.get(serverId)?.scope; return scope === undefined ? undefined : { ...scope }; }
  ready(serverId: string): boolean {
    const server = this.servers.get(serverId);
    return server !== undefined && server.listed && server.based && server.fresh;
  }
  session(serverId: string, sessionId: string): DirectorySession | undefined {
    const value = this.servers.get(serverId)?.sessions.get(sessionId);
    return value === undefined ? undefined : { ...value };
  }
  sessions(serverId: string): readonly DirectorySession[] { return [...(this.servers.get(serverId)?.sessions.values() ?? [])].map(session => ({ ...session })); }
  workspaces(serverId: string): readonly WorkspaceBrief[] {
    const server = this.servers.get(serverId);
    if (server === undefined) return [];
    const order = [...server.order, ...server.workspaces.keys()];
    return [...new Set(order)].flatMap(id => { const workspace = server.workspaces.get(id); return workspace === undefined ? [] : [cloneWorkspace(workspace)]; });
  }
  archived(serverId: string, sessionId: string): boolean { return this.servers.get(serverId)?.archived.has(sessionId) ?? false; }
  pinned(serverId: string, sessionId: string): boolean { return this.servers.get(serverId)?.pinned.has(sessionId) ?? false; }
  markStale(serverId: string): void { const server = this.servers.get(serverId); if (server !== undefined) server.fresh = false; }
  revoke(serverId: string): void { this.servers.delete(serverId); }

  resolve(serverId: string, sessionId: string): SessionContext | undefined {
    const server = this.servers.get(serverId);
    if (server === undefined || !this.ready(serverId) || !server.sessions.has(sessionId) || server.tombstones.has(sessionId)) return undefined;
    const workspace = this.workspaces(serverId).find(workspace => workspace.sessionIds.includes(sessionId));
    return { ...server.scope, sessionId, workspaceId: workspace?.workspaceId ?? null };
  }

  validate(context: SessionContext): SessionContext {
    const server = this.match(context);
    if (server === undefined || !this.ready(context.serverId) || !server.sessions.has(context.sessionId)
      || server.tombstones.has(context.sessionId)) throw new ProtocolFault('forbidden');
    if (context.workspaceId === null) {
      if (this.workspaces(context.serverId).some(workspace => workspace.sessionIds.includes(context.sessionId))) throw new ProtocolFault('forbidden');
    } else if (!server.workspaces.get(context.workspaceId)?.sessionIds.includes(context.sessionId)) throw new ProtocolFault('forbidden');
    return { ...context };
  }

  private match(scope: ServerScope): ServerDirectory | undefined {
    const server = this.servers.get(scope.serverId);
    return server !== undefined && server.scope.authProfileId === scope.authProfileId && server.scope.generation === scope.generation ? server : undefined;
  }
}
function cloneWorkspace(workspace: WorkspaceBrief): WorkspaceBrief { return { ...workspace, sessionIds: [...workspace.sessionIds] }; }
