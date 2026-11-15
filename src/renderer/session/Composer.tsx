import { useEffect, useRef, useState } from 'react';
import type { ConversationView } from '../../shared/domain.js';
import type { WorkbenchClientStore } from '../state/workbench-store.js';

export function Composer({ view, store, disabled, running }: { readonly view: ConversationView; readonly store: WorkbenchClientStore; readonly disabled: boolean; readonly running: boolean }) {
  const [text, setText] = useState(view.draft);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const composing = useRef(false);
  const requestId = useRef<string | null>(null);
  const stableId = `${view.context.serverId}:${view.context.authProfileId}:${view.context.sessionId}`;
  useEffect(() => { setText(view.draft); requestId.current = null; setSending(false); }, [stableId]);
  const send = (): void => {
    if (disabled || sending || text.trim() === '' || composing.current) return;
    const submitted = text;
    const context = { ...view.context };
    const id = requestId.current ?? crypto.randomUUID(); requestId.current = id;
    setSending(true);
    void store.api.sendText({ context, requestId: id, text: submitted }).then(result => {
      if (result.ok) {
        setText(current => current === submitted ? '' : current);
        requestId.current = null;
      } else { void store.action(Promise.resolve(result)); }
      void store.refresh();
    }).finally(() => setSending(false));
  };
  return <footer className="composer-area">
    <div className="composer-box"><textarea value={text} maxLength={65536} placeholder={disabled ? '当前仅可查看；连接、登录或退出演示后才能发送' : '发送消息到当前会话…'} rows={3} aria-label="当前会话输入"
      disabled={disabled} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onChange={event => { const value = event.target.value; setText(value); requestId.current = null; void store.api.setDraft(view.context, value); }}
      onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} />
      <div className="composer-controls"><span className="muted">Enter 发送 · Shift+Enter 换行</span><div>
        {running && <button type="button" disabled={disabled || stopping} className="stop-task" onClick={() => {
          setStopping(true); void store.action(store.api.stopRemote(view.context)).finally(() => setStopping(false));
        }}>{stopping ? '停止请求中…' : '停止远程任务'}</button>}
        <button type="button" className="primary send-button" disabled={disabled || sending || text.trim() === ''} onClick={send}>{sending ? '发送中…' : '发送 ↑'}</button>
      </div></div>
    </div>
    {view.sendState === 'uncertain' && <p className="delivery-warning" role="status">上次送达未知，不会自动重发。请先核实远程会话；编辑后再次发送属于新请求。</p>}
  </footer>;
}
