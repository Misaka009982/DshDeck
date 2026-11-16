import { deriveEventMessage, isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
import { assembleAssistantStream, expandAssistantStream } from '@deepseek-ai/dsh-llm/assistant-stream';
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm/assistant-stream';
import type { ConversationView, WireEvent } from '../../shared/domain.js';

export interface DisplayBlock {
  readonly kind: 'text' | 'reasoning' | 'attachment' | 'tool-call' | 'unknown';
  readonly text: string;
  readonly label?: string;
  readonly callId?: string;
}
export interface DisplayMessage {
  readonly id: string;
  readonly seq: number;
  readonly role: 'user' | 'assistant' | 'tool' | 'system' | 'event';
  readonly text: string;
  readonly reasoning: string;
  readonly label: string;
  readonly live: boolean;
  readonly blocks: readonly DisplayBlock[];
  readonly input?: string;
  readonly outcome?: 'pending' | 'success' | 'error' | 'interrupted';
  readonly elapsedMs?: number;
}

/** 人类历史来自 append-origin；工具按调用身份配对，内容块保留顺序而不人为换行。 */
export function messagesFromView(view: ConversationView): readonly DisplayMessage[] {
  const messages: DisplayMessage[] = [];
  const tools = new Map<string, { index: number; time: number }>();
  const commands = new Map<string, number>();
  const calls = new Set(view.events.flatMap(event => event.type === 'tool/call' && typeof record(event.data)?.callId === 'string' ? [String(record(event.data)?.callId)] : []));
  for (const event of view.events) {
    const data = record(event.data);
    if (event.type === 'tool/call') {
      const name = typeof data?.name === 'string' ? data.name : '工具调用';
      const input = typeof data?.arguments === 'string' ? boundedText(data.arguments) : boundedJson(event.data);
      const message: DisplayMessage = { id: `event:${event.seq}`, seq: event.seq, role: 'tool', label: name, text: '', reasoning: '', blocks: [], live: false, input, outcome: 'pending' };
      if (typeof data?.callId === 'string') tools.set(data.callId, { index: messages.length, time: event.time });
      messages.push(message); continue;
    }
    if (event.type === 'command/run') {
      const name = typeof data?.name === 'string' ? data.name : '未知命令';
      const input = typeof data?.args === 'string' ? boundedText(data.args) : '';
      if (typeof data?.commandId === 'string') commands.set(data.commandId, messages.length);
      messages.push({ id: `event:${event.seq}`, seq: event.seq, role: 'event', label: `命令 /${name}`, text: '', reasoning: '', blocks: [], live: false, input, outcome: 'pending' }); continue;
    }
    if (event.type === 'command/done') {
      const text = typeof data?.text === 'string' ? boundedText(data.text) : '';
      const index = typeof data?.commandId === 'string' ? commands.get(data.commandId) : undefined;
      const previous = index === undefined ? undefined : messages[index];
      const message: DisplayMessage = { id: previous?.id ?? `event:${event.seq}`, seq: previous?.seq ?? event.seq, role: 'event', label: previous?.label ?? '命令结果',
        text, reasoning: '', blocks: text === '' ? [] : [{ kind: 'text', text }], live: false, outcome: data?.kind === 'error' ? 'error' : 'success',
        ...(previous?.input === undefined ? {} : { input: previous.input }) };
      if (index !== undefined) messages[index] = message; else messages.push(message);
      continue;
    }
    const message = fromEvent(event, calls);
    if (message === null) continue;
    if (event.type === 'tool/result') {
      const wireMessage = record(data?.message); const source = record(wireMessage?.source);
      const callId = typeof wireMessage?.toolCallId === 'string' ? wireMessage.toolCallId : typeof source?.callId === 'string' ? source.callId : null;
      const call = callId === null ? undefined : tools.get(callId); const previous = call === undefined ? undefined : messages[call.index];
      const reason = record(data?.error)?.reason;
      const blocks = typeof reason === 'string' ? [...message.blocks, { kind: 'text' as const, text: boundedText(reason) }] : message.blocks;
      const paired: DisplayMessage = { ...message, id: previous?.id ?? message.id, seq: previous?.seq ?? message.seq, label: previous?.label ?? '工具输出', blocks,
        outcome: wireMessage?.isError === true ? 'error' : 'success',
        ...(previous?.input === undefined ? {} : { input: previous.input }), ...(call === undefined ? {} : { elapsedMs: Math.max(0, event.time - call.time) }) };
      if (call !== undefined) messages[call.index] = paired; else messages.push(paired);
    } else messages.push(message);
  }
  const attempt = view.assistant.activeAttempt;
  if (attempt !== null) {
    const blocks = streamBlocks(attempt.stream, false);
    if (blocks.length > 0) messages.push(makeMessage(`attempt:${attempt.attemptId}`, attempt.startedAfterSeq, 'assistant', blocks, '实时输出', true));
  }
  return messages;
}
export function rawEventText(event: WireEvent): string { return boundedJson({ type: event.type, seq: event.seq, time: event.time, data: event.data }); }
export function canConfirmRead(view: ConversationView, visible: boolean, focused: boolean, atEnd: boolean): boolean {
  return visible && focused && atEnd && !view.hasGap && view.cursor >= 0 && view.events[view.events.length - 1]?.seq === view.cursor
    && view.status !== 'loading' && view.status !== 'error' && view.status !== 'stale';
}
function fromEvent(event: WireEvent, calls: ReadonlySet<string>): DisplayMessage | null {
  const data = record(event.data);
  if (event.type === 'demo/user' || event.type === 'demo/assistant') return makeMessage(`event:${event.seq}`, event.seq,
    event.type === 'demo/user' ? 'user' : 'assistant', [{ kind: 'text', text: String(data?.text ?? '') }], '合成演示');
  if (event.type === 'assistant/attempt') {
    const blocks = streamBlocks(Array.isArray(data?.stream) ? data.stream : [], true);
    return blocks.length === 0 ? null : { ...makeMessage(`event:${event.seq}`, event.seq, 'assistant', blocks, '未提交的输出前缀'), outcome: 'interrupted' };
  }
  try {
    if (!isAppendSurfaceEvent(event as unknown as SessionEvent)) return null;
    const message = record(deriveEventMessage(event as unknown as SessionEvent));
    if (message === null) return null;
    const source = record(message.source);
    const human = message.role === 'user' && (source?.kind === undefined || source.kind === 'user' || source.kind === 'retry');
    const role = human ? 'user' : message.role === 'assistant' ? 'assistant' : message.role === 'tool' ? 'tool' : 'system';
    let blocks = contentBlocks(message.content);
    if (role === 'assistant') blocks = blocks.filter(block => block.kind !== 'tool-call' || block.callId === undefined || !calls.has(block.callId));
    if (blocks.length === 0) return null;
    const label = role === 'tool' ? '工具输出' : role === 'system' ? typeof source?.summary === 'string' ? boundedText(source.summary, 160)
      : `上下文${typeof source?.kind === 'string' ? ` · ${boundedText(source.kind, 64)}` : ''}` : '';
    const rendered = makeMessage(`event:${event.seq}`, event.seq, role, blocks, label);
    return data?.interrupted === true ? { ...rendered, outcome: 'interrupted' } : rendered;
  } catch {
    return makeMessage(`event:${event.seq}`, event.seq, 'event', [{ kind: 'unknown', text: boundedJson(event.data) }], `未适配事件 · ${event.type}`);
  }
}
function streamBlocks(value: readonly unknown[], interrupted: boolean): readonly DisplayBlock[] {
  try {
    const stream = value as readonly AssistantStreamRecord[];
    expandAssistantStream(stream);
    const assembler = assembleAssistantStream(stream);
    if (interrupted) return contentBlocks(assembler.interruptedBlocks());
    try { return contentBlocks(assembler.blocks()); } catch { return contentBlocks(assembler.interruptedBlocks()); }
  } catch { return [{ kind: 'unknown', text: '当前实时内容结构尚未适配，可查看事件或原网页。' }]; }
}
function makeMessage(id: string, seq: number, role: DisplayMessage['role'], blocks: readonly DisplayBlock[], label = '', live = false): DisplayMessage {
  return { id, seq, role, blocks, label, live, text: blocks.filter(block => block.kind !== 'reasoning').map(block => block.text).join(''),
    reasoning: blocks.filter(block => block.kind === 'reasoning').map(block => block.text).join('') };
}
function contentBlocks(value: unknown): readonly DisplayBlock[] {
  if (typeof value === 'string') return [{ kind: 'text', text: boundedText(value) }];
  if (!Array.isArray(value)) return [{ kind: 'unknown', text: boundedJson(value) }];
  const blocks: DisplayBlock[] = [];
  for (const item of value) {
    const block = record(item);
    if ((block?.type === 'text' || block?.type === 'reasoning') && typeof block.text === 'string') {
      const last = blocks[blocks.length - 1];
      if (last?.kind === block.type) blocks[blocks.length - 1] = { kind: block.type, text: boundedText(last.text + block.text) };
      else blocks.push({ kind: block.type, text: boundedText(block.text) });
    } else if (block?.type === 'image' || block?.type === 'file') {
      const name = record(block.attachment)?.name;
      blocks.push({ kind: 'attachment', text: `${block.type === 'image' ? '图片' : '文件'}${typeof name === 'string' ? `：${boundedText(name, 256)}` : ''}（未预下载，原网页查看）` });
    } else if (block?.type === 'tool-call') blocks.push({ kind: 'tool-call', text: typeof block.arguments === 'string' ? boundedText(block.arguments) : '',
      label: typeof block.name === 'string' ? boundedText(block.name, 128) : '正在组织工具调用', ...(typeof block.id === 'string' ? { callId: block.id } : {}) });
    else blocks.push({ kind: 'unknown', text: boundedJson(item) });
  }
  return blocks;
}
function record(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function boundedText(text: string, max = 131072): string { return text.length > max ? `${text.slice(0, max)}\n[达到本机展示上限]` : text; }
function boundedJson(value: unknown): string { return boundedText(JSON.stringify(value, null, 2) ?? ''); }
