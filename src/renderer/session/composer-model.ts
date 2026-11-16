import type { GoalProjection, NativeSnapshot, NativeValues } from '../../shared/native-controls.js';

/** 仅把有实际内容的服务器投影放进常驻功能区；空状态保留在用户主动打开的详情里。 */
export function composerActivity(native: NativeSnapshot | undefined): {
  readonly goal: GoalProjection | null;
  readonly todos: NonNullable<NativeValues['todos']>;
  readonly completed: number;
  readonly inProgress: number;
  readonly pending: number;
  readonly summary: string;
} {
  const goal = native?.values.goal;
  const todos = native?.values.todos?.filter(todo => todo.content.trim() !== '') ?? [];
  const completed = todos.filter(todo => todo.status === 'completed').length;
  const inProgress = todos.filter(todo => todo.status === 'in_progress').length;
  const pending = todos.filter(todo => todo.status === 'pending').length;
  return {
    goal: goal !== null && goal !== undefined && goal.goal.phase !== 'complete' && goal.goal.objective.trim() !== '' ? goal : null,
    todos, completed, inProgress, pending,
    summary: [completed > 0 ? `${completed} 已完成` : '', inProgress > 0 ? `${inProgress} 进行中` : '', pending > 0 ? `${pending} 待开始` : ''].filter(part => part !== '').join(' · '),
  };
}
/** 常驻统计使用紧凑显示；精确数值仍在 tooltip 和详情中保留。 */
export function compactCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '未知';
  const unit = value >= 1e9 ? { divisor: 1e9, suffix: 'B' } : value >= 1e6 ? { divisor: 1e6, suffix: 'M' } : value >= 1e3 ? { divisor: 1e3, suffix: 'K' } : null;
  return unit === null ? value.toLocaleString('zh-CN') : `${(value / unit.divisor).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}${unit.suffix}`;
}
