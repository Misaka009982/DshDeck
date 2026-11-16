import { useEffect, useRef } from 'react';
import type { ConversationView } from '../../shared/domain.js';
import { canConfirmRead, messagesFromView, rawEventText } from './session-view-model.js';
import { SafeMarkdown } from './SafeMarkdown.js';
import type { DisplayMessage } from './session-view-model.js';

interface Props { readonly view: ConversationView; readonly mode: 'conversation' | 'output' | 'events'; readonly onRead: () => void; readonly onOpenOriginal?: () => void }
export function MessageList({ view, mode, onRead, onOpenOriginal }: Props) {
  const scroll = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const lastRead = useRef(-2);
  const stableId = `${view.context.serverId}:${view.context.authProfileId}:${view.context.sessionId}`;
  const messages = messagesFromView(view).filter(message => mode !== 'output' || message.role === 'tool');
  useEffect(() => { atEnd.current = true; lastRead.current = -2; }, [stableId]);
  useEffect(() => {
    if (atEnd.current) end.current?.scrollIntoView({ block: 'end' });
  }, [view.cursor, view.assistant.revision, stableId]);
  useEffect(() => {
    const target = end.current;
    if (target === null) return;
    const confirm = (): void => {
      if (mode === 'conversation' && canConfirmRead(view, document.visibilityState === 'visible', document.hasFocus(), atEnd.current)
        && lastRead.current !== view.cursor) { lastRead.current = view.cursor; onRead(); }
    };
    const observer = new IntersectionObserver(entries => { atEnd.current = entries[0]?.isIntersecting ?? false; confirm(); }, { root: scroll.current, threshold: 0.9 });
    observer.observe(target);
    window.addEventListener('focus', confirm); document.addEventListener('visibilitychange', confirm);
    return () => { observer.disconnect(); window.removeEventListener('focus', confirm); document.removeEventListener('visibilitychange', confirm); };
  }, [view, mode, onRead]);
  return <div className="message-scroll" ref={scroll}>
    <div className="message-column">
      {mode === 'events' ? view.events.map(event => <details className="event-card" key={event.seq}><summary><span>#{event.seq}</span> {event.type}</summary><pre>{rawEventText(event)}</pre></details>) : messages.map(message => (
        <article className={`message message-${message.role}`} key={message.id}>
          {message.role === 'tool' || message.role === 'event' ? <details className="tool-output">
            <summary>{message.label || '输出'}{message.outcome !== undefined && <span className={`message-outcome outcome-${message.outcome}`}>{outcomeText(message.outcome)}</span>}{message.elapsedMs !== undefined && <span className="muted">{(message.elapsedMs / 1000).toFixed(1)}s</span>}</summary>
            {message.input !== undefined && message.input !== '' && <details className="tool-arguments"><summary>输入参数</summary><pre>{message.input}</pre></details>}
            <MessageContent message={message} plain onOpenOriginal={onOpenOriginal} />
          </details> : message.role === 'system' ? <details className="context-output"><summary>{message.label || '系统上下文'}</summary><MessageContent message={message} onOpenOriginal={onOpenOriginal} /></details> : <>
            {(message.label !== '' || message.outcome === 'interrupted') && <header className="message-meta">{message.label}{message.live && <span className="streaming-mark" aria-label="正在实时输出" />}{message.outcome === 'interrupted' && <span>输出未完整提交</span>}</header>}
            <MessageContent message={message} onOpenOriginal={onOpenOriginal} />
          </>}
        </article>
      ))}
      {view.events.length === 0 && view.assistant.activeAttempt === null && <div className="conversation-empty">{view.status === 'loading' ? '首次读取会话…' : view.failure !== null ? '会话暂不可读。可以重试、重新登录或打开兼容页面。' : '这个会话没有已加载的消息。'}</div>}
      {mode === 'conversation' && view.events.length > 0 && messages.length === 0 && view.assistant.activeAttempt === null && <div className="conversation-empty">已读取 {view.events.length} 条记录，当前没有可显示的标准对话；可切换到事件查看，插件界面请使用原网页。</div>}
      {mode === 'output' && messages.length === 0 && <p className="muted">当前缓存中没有工具输出。</p>}
      <div ref={end} className="read-sentinel" aria-hidden="true" />
    </div>
  </div>;
}
function MessageContent({ message, plain = false, onOpenOriginal }: { readonly message: DisplayMessage; readonly plain?: boolean; readonly onOpenOriginal?: (() => void) | undefined }) {
  return <div className="message-content">{message.blocks.map((block, index) => block.kind === 'reasoning' ? <details className="reasoning" key={index} open={message.live}><summary>推理过程{message.live ? ' · 实时' : ''}</summary><SafeMarkdown text={block.text} /></details>
    : block.kind === 'attachment' ? <div className="message-attachment" key={index}>{block.text}{onOpenOriginal !== undefined && <button type="button" onClick={onOpenOriginal}>原网页查看</button>}</div>
      : block.kind === 'tool-call' || block.kind === 'unknown' ? <details className="tool-output" key={index}><summary>{block.label ?? (block.kind === 'tool-call' ? '正在组织工具调用' : '未适配内容块')}</summary><pre>{block.text}</pre></details>
        : plain ? <pre className="tool-result-text" key={index}>{block.text}</pre> : <SafeMarkdown text={block.text} key={index} />)}</div>;
}
function outcomeText(outcome: NonNullable<DisplayMessage['outcome']>): string {
  return outcome === 'pending' ? '未加载结果' : outcome === 'error' ? '失败' : outcome === 'interrupted' ? '未完整提交' : '已完成';
}
