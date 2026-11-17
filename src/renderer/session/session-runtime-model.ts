import type { ConversationView } from '../../shared/domain.js';

interface RetryTimeline {
  readonly id: string; readonly turn: number; readonly step: number; readonly count: number; readonly limit: number | null;
  readonly scheduledAt: number; readonly delayMs: number; readonly reason: string; readonly requestStartedAt: number | null;
}
export interface RuntimeTimeline {
  readonly turn: number | null; readonly startedAt: number | null; readonly endedAt: number | null; readonly retry: RetryTimeline | null;
}
export interface RuntimeReading {
  readonly turn: number | null; readonly running: boolean; readonly finished: boolean; readonly durationMs: number | null; readonly cached: boolean;
  readonly retry: { readonly count: number; readonly limit: number | null; readonly phase: 'waiting' | 'requesting'; readonly delayMs: number;
    readonly remainingMs: number | null; readonly elapsedMs: number | null; readonly reason: string } | null;
}
type RuntimeSource = Pick<ConversationView, 'events' | 'assistant' | 'status' | 'syncedAt'>;
const STEP_EVENTS = new Set(['step/start', 'step/end', 'assistant/message', 'assistant/attempt', 'llm/retry', 'llm/retry-started']);

/** 时间与模型重试只读持久事件；不以连接代次、累计账单或接入时间猜测。 */
export function timelineFromView(view: RuntimeSource): RuntimeTimeline {
  let turn: number | null = null; let startedAt: number | null = null; let endedAt: number | null = null;
  let step: number | null = null; let retry: RetryTimeline | null = null; let lastSeq = -1;
  const adopt = (next: number): boolean => {
    if (turn !== null && next < turn) return false;
    if (turn !== next) { turn = next; startedAt = null; endedAt = null; step = null; retry = null; }
    return true;
  };
  for (const event of view.events) {
    const data = record(event.data); const eventTurn = integer(data?.turn); const time = integer(event.time); const seq = integer(event.seq);
    if (data === null || eventTurn === null || time === null || seq === null || seq <= lastSeq) continue;
    lastSeq = seq;
    if (event.type === 'turn/start') {
      if (!adopt(eventTurn)) continue;
      startedAt = time; endedAt = null; step = null; retry = null;
    } else if (event.type === 'turn/end') {
      if (!adopt(eventTurn)) continue;
      endedAt = time; retry = null;
    } else if (STEP_EVENTS.has(event.type)) {
      const eventStep = integer(data.step);
      if (eventStep === null || !adopt(eventTurn) || endedAt !== null || step !== null && eventStep < step) continue;
      if (step !== eventStep) { step = eventStep; retry = null; }
      if (event.type === 'step/start' || event.type === 'step/end' || event.type === 'assistant/message' || event.type === 'assistant/attempt') retry = null;
      else if (event.type === 'llm/retry') {
        retry = null;
        const id = text(data.retryId, 256); const count = integer(data.retry, 1); const delayMs = finite(data.delayMs);
        const limit = data.mode === 'always' ? null : integer(data.maxRetries);
        const failure = record(data.failure);
        if (id === null || count === null || delayMs === null || failure === null || text(data.provider, 256) === null || text(data.policyKey, 8192) === null
          || data.mode !== 'normal' && data.mode !== 'always' || data.mode === 'normal' && (limit === null || count > limit)
          || typeof failure.message !== 'string' || typeof failure.code !== 'string') continue;
        retry = { id, turn: eventTurn, step: eventStep, count, limit, scheduledAt: time, delayMs, reason: retryReason(failure), requestStartedAt: null };
      } else retry = retryStarted(retry, data, time);
    }
  }
  const active = view.assistant.activeAttempt;
  if (active !== null && (turn === null || active.turn > turn)) { turn = active.turn; startedAt = null; endedAt = null; retry = null; }
  else if (active !== null && active.turn === turn && step !== null && active.step > step) retry = null;
  return { turn, startedAt, endedAt, retry };
}

/** 缓存停止本机计时；等新的真实事件后再恢复，不暗示远程任务被暂停。 */
export function runtimeFromView(view: RuntimeSource, running: boolean, now = Date.now(), timeline = timelineFromView(view)): RuntimeReading {
  const finished = timeline.endedAt !== null; const cached = view.status !== 'live' || !running && !finished;
  const clock = cached || !running ? view.syncedAt : now;
  const through = timeline.endedAt ?? clock;
  const durationMs = timeline.startedAt === null || through === null ? null : Math.max(0, through - timeline.startedAt);
  const retry = finished ? null : timeline.retry;
  return { turn: timeline.turn, running: running && !finished, finished, durationMs, cached,
    retry: retry === null ? null : { count: retry.count, limit: retry.limit, phase: retry.requestStartedAt === null ? 'waiting' : 'requesting', delayMs: retry.delayMs,
      remainingMs: cached || !running || retry.requestStartedAt !== null ? null : Math.max(0, retry.scheduledAt + retry.delayMs - now),
      elapsedMs: cached || !running || retry.requestStartedAt === null ? null : Math.max(0, now - retry.requestStartedAt), reason: retry.reason } };
}
export function runtimeDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000)); const hours = Math.floor(total / 3600); const minutes = Math.floor(total % 3600 / 60); const seconds = total % 60;
  return `${hours > 0 ? `${hours} 小时 ` : ''}${minutes > 0 || hours > 0 ? `${minutes} 分 ` : ''}${seconds} 秒`;
}
function retryStarted(previous: RetryTimeline | null, data: Record<string, unknown>, time: number): RetryTimeline | null {
  if (previous === null || data.retryId !== previous.id || data.retry !== previous.count || data.turn !== previous.turn || data.step !== previous.step) return previous;
  return { ...previous, requestStartedAt: time };
}
function retryReason(failure: Record<string, unknown>): string {
  const message = typeof failure.message === 'string' ? failure.message.slice(0, 2048) : '';
  const idle = /\bstream idle timeout after (\d+(?:\.\d+)?)ms\b/i.exec(message);
  const timeout = idle === null ? null : finite(Number(idle[1]));
  if (timeout !== null && timeout > 0) return `模型流空闲超时（${timeout % 60000 === 0 ? `${timeout / 60000} 分钟` : runtimeDuration(timeout)}）`;
  if (failure.status === 429 || failure.code === 'RATE_LIMIT') return '模型服务限流';
  if (failure.status === 401 || failure.status === 403 || failure.code === 'AUTHENTICATION_FAILED') return '模型服务认证或权限被拒绝';
  if (failure.code === 'TIMEOUT' || failure.code === 'REQUEST_TIMEOUT') return '模型请求超时';
  if (failure.code === 'NETWORK_ERROR' || failure.code === 'CONNECTION_ERROR') return '模型服务网络错误';
  if (typeof failure.status === 'number' && failure.status >= 500 && failure.status <= 599) return '模型服务暂不可用';
  return '模型请求失败，具体原因尚未适配';
}
function record(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function integer(value: unknown, min = 0): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && !Object.is(value, -0) ? value : null; }
function finite(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER && !Object.is(value, -0) ? value : null; }
function text(value: unknown, max: number): string | null { return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null; }
