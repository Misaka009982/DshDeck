import { useEffect, useRef } from 'react';
import type { ConversationView } from '../../shared/domain.js';
import { canConfirmRead, messagesFromView, rawEventText } from './session-view-model.js';
import { SafeMarkdown } from './SafeMarkdown.js';

interface Props { readonly view: ConversationView; readonly mode: 'conversation' | 'output' | 'events'; readonly onRead: () => void }
export function MessageList({ view, mode, onRead }: Props) {
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
          {(message.label !== '' || message.role !== 'user') && <header className="message-meta">{message.label || (message.role === 'assistant' ? 'dsh' : message.role === 'system' ? '系统上下文' : '')}{message.live && <span className="streaming-mark" aria-label="正在实时输出" />}</header>}
          {message.reasoning !== '' && <details className="reasoning"><summary>推理过程</summary><SafeMarkdown text={message.reasoning} /></details>}
          {message.role === 'tool' || message.role === 'event' ? <details className="tool-output"><summary>{message.label || '输出'}</summary><pre>{message.text}</pre></details> : <SafeMarkdown text={message.text} />}
        </article>
      ))}
      {view.events.length === 0 && view.assistant.activeAttempt === null && <div className="conversation-empty">{view.status === 'loading' ? '首次读取会话…' : view.failure !== null ? '会话暂不可读。可以重试、重新登录或打开兼容页面。' : '这个会话没有已加载的消息。'}</div>}
      {mode === 'output' && messages.length === 0 && <p className="muted">当前缓存中没有工具输出。</p>}
      <div ref={end} className="read-sentinel" aria-hidden="true" />
    </div>
  </div>;
}
