import type { ServerScope, SessionContext } from '../../shared/domain.js';

interface Priority { readonly context: SessionContext; readonly until: number; readyAt: number | null }
/** 只决定辅助读取何时开场；15秒有限预算不续期，不暂停状态或远程任务。 */
export class ReadAdmission {
  private priority: Priority | undefined;
  constructor(private readonly now: () => number = Date.now) {}
  opening(context: SessionContext): void {
    const previous = this.priority;
    if (previous !== undefined && sameScope(previous.context, context) && previous.context.sessionId === context.sessionId && previous.readyAt === null) return;
    this.priority = { context: { ...context }, until: this.now() + 15000, readyAt: null };
  }
  ready(context: SessionContext): void {
    const priority = this.priority;
    if (priority !== undefined && sameScope(priority.context, context) && priority.context.sessionId === context.sessionId && priority.readyAt === null) priority.readyAt = this.now();
  }
  allow(context: ServerScope, purpose: 'background' | 'jobs'): boolean {
    const priority = this.priority;
    if (priority === undefined || !sameScope(priority.context, context)) return true;
    return this.now() >= (priority.readyAt === null ? priority.until : priority.readyAt + (purpose === 'jobs' ? 500 : 1000));
  }
  clear(serverId?: string): void { if (serverId === undefined || this.priority?.context.serverId === serverId) this.priority = undefined; }
}
function sameScope(left: ServerScope, right: ServerScope): boolean { return left.serverId === right.serverId && left.authProfileId === right.authProfileId && left.generation === right.generation; }
