import type { SessionContext } from '../../shared/domain.js';
import { DirectoryStore } from './directory-store.js';

/** 所有选择、发送、读取与宠物跳转都复用同一权威路由。 */
export class FocusRouter {
  private focused: SessionContext | null = null;
  constructor(private readonly directory: DirectoryStore) {}
  select(context: SessionContext): SessionContext { this.focused = this.validate(context); return { ...this.focused }; }
  validate(context: SessionContext): SessionContext { return this.directory.validate(context); }
  resolve(serverId: string, sessionId: string): SessionContext | undefined { return this.directory.resolve(serverId, sessionId); }
  current(): SessionContext | null {
    if (this.focused === null) return null;
    const resolved = this.resolve(this.focused.serverId, this.focused.sessionId);
    if (resolved === undefined || resolved.authProfileId !== this.focused.authProfileId || resolved.generation !== this.focused.generation) return null;
    this.focused = resolved;
    return { ...resolved };
  }
  clear(serverId?: string): void { if (serverId === undefined || this.focused?.serverId === serverId) this.focused = null; }
}
