import { createHash } from 'node:crypto';
import { Notification } from 'electron';
import type { TaskProjection } from '../../shared/domain.js';
import { NotificationDedup } from './notification-dedup.js';

interface NotificationHooks {
  readonly enabled: () => boolean;
  readonly visible: () => boolean;
  readonly selectedTaskId: () => string | null;
  readonly jump: (task: TaskProjection) => void;
  readonly petNotice: (notification: unknown) => void;
}
/** 一套提醒策略分发给系统与宠物；系统声音由 OS 负责，宠物声音固定关闭。 */
export class NotificationService {
  private readonly dedup = new NotificationDedup();
  private readonly notifications = new Set<Notification>();
  private disposed = false;
  constructor(private readonly hooks: NotificationHooks) {}
  consume(tasks: readonly TaskProjection[]): void {
    if (this.disposed) return;
    for (const task of tasks) {
      if (!this.hooks.enabled() || (this.hooks.visible() && this.hooks.selectedTaskId() === task.id)) continue;
      if (!this.dedup.accept(task)) continue;
      const message = task.color === 'yellow' ? '有关注会话正在等待你的交互。' : task.color === 'red' ? '有关注会话发生了明确失败。' : '有关注会话已完成，等待查看。';
      const now = Date.now();
      this.hooks.petNotice({ id: createHash('sha256').update(JSON.stringify([task.id, task.color, task.resultId])).digest('hex'), title: 'DshDeck 关注任务', message, createdAt: now, expiresAt: now + 10000 });
      if (!Notification.isSupported()) continue;
      const notice = new Notification({ title: 'DshDeck 关注任务', body: message, silent: false });
      this.notifications.add(notice);
      notice.once('click', () => { if (!this.disposed) { try { this.hooks.jump(task); } catch { /* 过期通知不能让主工作台崩溃。 */ } } });
      notice.once('close', () => this.notifications.delete(notice));
      notice.show();
    }
  }
  dispose(): void { this.disposed = true; for (const notification of this.notifications) notification.close(); this.notifications.clear(); }
}
