import type { TaskProjection } from '../../shared/domain.js';

/** 状态重复、重连或多个显示面不应再次提醒同一终态；运行不产生结果通知。 */
export class NotificationDedup {
  private readonly seen = new Set<string>();
  accept(task: TaskProjection): boolean {
    if (task.freshness !== 'fresh' || task.color === 'green') return false;
    const identity = JSON.stringify([task.id, task.color, task.resultId ?? `pending:${task.generation}`]);
    if (this.seen.has(identity)) return false;
    this.seen.add(identity);
    if (this.seen.size > 10000) this.seen.delete(this.seen.values().next().value as string);
    return true;
  }
}
