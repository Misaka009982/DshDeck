import { useEffect, useMemo, useState } from 'react';
import type { ConversationView } from '../../shared/domain.js';
import { WorkbenchIcon } from '../ui/WorkbenchIcon.js';
import { runtimeDuration, runtimeFromView, timelineFromView } from './session-runtime-model.js';

export function RuntimeStatus({ view, running }: { readonly view: ConversationView; readonly running: boolean }) {
  const [now, setNow] = useState(Date.now());
  // 主进程按不可变持久seq合并历史；IPC复制数组或推理分块不应反复重算时间事实。
  const timeline = useMemo(() => timelineFromView(view), [view.context.serverId, view.context.authProfileId, view.context.generation, view.context.sessionId,
    view.cursor, view.events.length, view.events[0]?.seq, view.events[0]?.time, view.events.at(-1)?.seq, view.events.at(-1)?.time,
    view.assistant.activeAttempt?.turn, view.assistant.activeAttempt?.step]);
  const value = runtimeFromView(view, running, now, timeline);
  useEffect(() => {
    setNow(Date.now());
    if (!running || view.status !== 'live' || timeline.endedAt !== null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer);
  }, [running, view.status, timeline.endedAt]);
  if (value.turn === null && !running) return null;
  const retry = value.retry;
  const label = value.cached ? '缓存任务状态' : value.finished ? '本轮已结束' : value.running ? '任务运行中' : '任务状态待确认';
  return <div className={`session-runtime${value.cached ? ' is-cached' : ''}`} aria-label="任务运行时间与模型重试">
    <div className="session-runtime-clock"><WorkbenchIcon name="clock" size={14} /><span>{label}{value.turn !== null && ` · 第 ${value.turn} 轮`}</span><span role="timer" aria-live="off">· {value.durationMs === null ? '用时未知' : `${value.cached ? '已观察用时' : '用时'} ${runtimeDuration(value.durationMs)}`}</span></div>
    {retry !== null && <details className="model-retry-status">
      <summary>模型请求已重试（{retry.count.toLocaleString('zh-CN')}{retry.limit === null ? ' · 持续重试' : `/${retry.limit.toLocaleString('zh-CN')}`}）
        <span>{value.cached ? ' · 等待同步确认' : retry.phase === 'waiting' ? retry.remainingMs === null ? ' · 等待状态未知' : retry.remainingMs > 0 ? ` · ${Math.ceil(retry.remainingMs / 1000)} 秒后重试` : ' · 等待服务器确认开始' : retry.elapsedMs === null ? '' : ` · 本次请求 ${runtimeDuration(retry.elapsedMs)}`}</span>
      </summary>
      <dl><dt>实际重试等待</dt><dd>{(retry.delayMs / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 3 })} 秒</dd><dt>失败原因</dt><dd>{retry.reason}</dd></dl>
    </details>}
    {value.cached && <small>保留最后观察值；远程任务是否仍运行需同步确认，网络恢复统计另列。</small>}
  </div>;
}
