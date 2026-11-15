import { deriveEventMessage, isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
import { joinAssistantStreamText } from '@deepseek-ai/dsh-llm/assistant-stream';
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm/assistant-stream';
import type { ConversationView, WireEvent } from '../../shared/domain.js';

export interface DisplayMessage {
  readonly id: string;
  readonly seq: number;
  readonly role: 'user' | 'assistant' | 'tool' | 'system' | 'event';
  readonly text: string;
  readonly reasoning: string;
  readonly label: string;
  readonly live: boolean;
}

/** 人类对话采用 append-origin，模型的 replacement 不擦掉用户已经见过的历史。 */
export function messagesFromView(view: ConversationView): readonly DisplayMessage[] {
  const messages: DisplayMessage[] = [];
  for (const event of view.events) {
    const message = fromEvent(event);
    if (message !== null) messages.push(message);
  }
  const attempt = view.assistant.activeAttempt;
  if (attempt !== null) {
    let text = '';
    try { text = joinAssistantStreamText(attempt.stream as readonly AssistantStreamRecord[]); } catch { text = '当前实时输出结构尚未适配，可查看事件或兼容页面。'; }
    if (text !== '') messages.push({ id: `attempt:${attempt.attemptId}`, seq: attempt.startedAfterSeq, role: 'assistant', text, reasoning: '', label: '实时输出', live: true });
  }
  return messages;
}
export function rawEventText(event: WireEvent): string { return boundedJson({ type: event.type, seq: event.seq, time: event.time, data: event.data }); }
export function canConfirmRead(view: ConversationView, visible: boolean, focused: boolean, atEnd: boolean): boolean {
  return visible && focused && atEnd && !view.hasGap && view.cursor >= 0 && view.events[view.events.length - 1]?.seq === view.cursor
    && view.status !== 'loading' && view.status !== 'error' && view.status !== 'stale';
}
function fromEvent(event: WireEvent): DisplayMessage | null {
  const data = record(event.data);
  if (event.type === 'demo/user' || event.type === 'demo/assistant') return { id: `event:${event.seq}`, seq: event.seq, role: event.type === 'demo/user' ? 'user' : 'assistant', text: String(data?.text ?? ''), reasoning: '', label: '合成演示', live: false };
  if (event.type === 'tool/call') return { id: `event:${event.seq}`, seq: event.seq, role: 'tool', text: typeof data?.arguments === 'string' ? data.arguments : boundedJson(event.data), reasoning: '', label: typeof data?.name === 'string' ? data.name : '工具调用', live: false };
  try {
    if (!isAppendSurfaceEvent(event as unknown as SessionEvent)) return null;
    const message = record(deriveEventMessage(event as unknown as SessionEvent));
    if (message === null) return null;
    const role = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : message.role === 'tool' ? 'tool' : 'system';
    const content = contentText(message.content);
    return { id: `event:${event.seq}`, seq: event.seq, role, text: content.text, reasoning: content.reasoning, label: role === 'tool' ? '工具输出' : role === 'system' ? '系统上下文' : '', live: false };
  } catch {
    return { id: `event:${event.seq}`, seq: event.seq, role: 'event', text: boundedJson(event.data), reasoning: '', label: `未适配事件 · ${event.type}`, live: false };
  }
}
function contentText(value: unknown): { text: string; reasoning: string } {
  if (typeof value === 'string') return { text: value, reasoning: '' };
  if (!Array.isArray(value)) return { text: boundedJson(value), reasoning: '' };
  const text: string[] = []; const reasoning: string[] = [];
  for (const item of value) {
    const block = record(item);
    if (block?.type === 'text' && typeof block.text === 'string') text.push(block.text);
    else if (block?.type === 'reasoning' && typeof block.text === 'string') reasoning.push(block.text);
    else if (block?.type === 'image' || block?.type === 'file') text.push('[附件未预下载，请在兼容页面查看]');
    else text.push(boundedJson(item));
  }
  return { text: text.join('\n'), reasoning: reasoning.join('\n') };
}
function record(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function boundedJson(value: unknown): string { const text = JSON.stringify(value, null, 2) ?? ''; return text.length > 131072 ? `${text.slice(0, 131072)}\n[仅显示前 128 KiB，完整内容仍保留于有界缓存]` : text; }
