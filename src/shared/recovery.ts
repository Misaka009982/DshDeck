import { ProtocolFault } from './faults.js';

export interface RecoveryView {
  readonly phase: 'waiting' | 'connecting' | 'stopped';
  readonly attempt: number;
  readonly limit: number | null;
  readonly retryAt: number | null;
}
export function recoveryDelayMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new ProtocolFault('protocol');
  return Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
}
/** 显示恢复进度，不把重试期间的缓存当成当前在线状态。 */
export function recoveryText(value: RecoveryView, now = Date.now(), conversation = false): string {
  const label = conversation ? '会话重新连接' : '重新连接';
  const progress = value.limit === null ? `第 ${value.attempt} 次` : `第 ${value.attempt}/${value.limit} 次`;
  if (value.phase === 'stopped') return `${label}已暂停 · 请手动重试`;
  const seconds = value.retryAt === null ? null : Math.max(0, Math.ceil((value.retryAt - now) / 1000));
  return `${label}中… · ${progress}${value.phase === 'waiting' && seconds !== null ? ` · ${seconds} 秒后重试` : ''}`;
}
