import { useEffect, useId, useRef, useState } from 'react';
import type { ConversationView } from '../../shared/domain.js';
import type { CommandDescriptor } from '../../shared/native-controls.js';
import type { WorkbenchClientStore } from '../state/workbench-store.js';
import { ModelSelector } from './ModelSelector.js';
import { ContextInspector } from './ContextInspector.js';
import { GoalTaskDock } from './GoalTaskDock.js';
import { classifySlash, slashCandidates, slashQuery } from './slash-model.js';
import type { LocalSlashAction, SlashCandidate } from './slash-model.js';

export function Composer({ view, store, disabled, running, controlsDisabled = disabled, onOpenOriginal }: { readonly view: ConversationView; readonly store: WorkbenchClientStore; readonly disabled: boolean; readonly running: boolean; readonly controlsDisabled?: boolean; readonly onOpenOriginal?: () => void }) {
  const [text, setText] = useState(view.draft); const [sending, setSending] = useState(false); const [stopping, setStopping] = useState(false);
  const [commands, setCommands] = useState<readonly CommandDescriptor[]>([]); const [commandState, setCommandState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [localError, setLocalError] = useState(''); const [menuDismissed, setMenuDismissed] = useState(false); const [highlight, setHighlight] = useState(0);
  const [modelOpen, setModelOpen] = useState(false); const [panel, setPanel] = useState<'context' | 'tasks' | 'goal' | null>(null);
  const composing = useRef(false); const requestId = useRef<string | null>(null); const input = useRef<HTMLTextAreaElement>(null);
  const scope = JSON.stringify([view.context.serverId, view.context.authProfileId, view.context.generation, view.context.sessionId]);
  const currentScope = useRef(scope); const alive = useRef(true); const menuId = useId();
  const query = slashQuery(text); const candidates = query === null ? [] : slashCandidates(commands, query);
  const menuOpen = !disabled && !menuDismissed && query !== null && !composing.current;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { currentScope.current = scope; setText(view.draft); requestId.current = null; setSending(false); setCommands([]); setCommandState('idle'); setModelOpen(false); setPanel(null); setLocalError(''); }, [scope]);
  useEffect(() => { setHighlight(0); }, [query]);
  const readCommands = (refresh = false): void => {
    if (controlsDisabled || commandState === 'loading') return;
    const target = scope; setCommandState('loading');
    void store.api.commandCatalog(view.context, refresh).then(result => {
      if (!alive.current || currentScope.current !== target) return;
      if (result.ok) { setCommands(result.value); setCommandState('ready'); }
      else { setCommandState('failed'); setLocalError(`服务器命令目录不可用（${result.error.kind}）；本地面板入口仍可用，服务器命令不会改成普通消息。`); }
    });
  };
  useEffect(() => { if (query !== null && commandState === 'idle' && !controlsDisabled) readCommands(); }, [query, commandState, controlsDisabled]);
  const updateText = (value: string): void => { setText(value); requestId.current = null; setLocalError(''); setMenuDismissed(false); void store.api.setDraft(view.context, value); };
  const openLocal = (action: LocalSlashAction): void => {
    updateText(''); setMenuDismissed(true);
    if (action === 'model') { setPanel(null); setModelOpen(true); }
    else { setModelOpen(false); setPanel(action); }
  };
  const pick = (candidate: SlashCandidate): void => {
    if (candidate.kind === 'local' && candidate.action !== undefined) openLocal(candidate.action);
    else { updateText(`/${candidate.name}${candidate.input ? ' ' : ''}`); setMenuDismissed(true); requestAnimationFrame(() => input.current?.focus()); }
  };
  const send = (): void => {
    if (disabled || sending || text.trim() === '' || composing.current) return;
    const submission = classifySlash(text, commands);
    if (submission.kind === 'local') { openLocal(submission.action); return; }
    if (submission.kind === 'unknown' || submission.kind === 'command' && commandState !== 'ready') { setLocalError('没有就绪的匹配命令；不会把斜杠输入静默当作普通消息发送。请重读命令目录或使用原网页。'); return; }
    const submitted = text; const context = { ...view.context }; const target = scope;
    const id = requestId.current ?? crypto.randomUUID(); requestId.current = id;
    setSending(true); setLocalError('');
    void (async () => {
      try {
        if (submission.kind === 'command') {
          const result = await store.api.executeCommand({ context, requestId: id, text: submitted });
          if (!alive.current || currentScope.current !== target) return;
          if (result.ok) {
            if (result.value.result.kind === 'error') setLocalError(result.value.result.text ?? '服务器命令已执行但返回失败；编辑后重试属于新请求。');
            else { setText(current => current === submitted ? '' : current); requestId.current = null; }
          } else setLocalError(result.error.message);
        } else {
          const result = await store.api.sendText({ context, requestId: id, text: submitted });
          if (!alive.current || currentScope.current !== target) return;
          if (result.ok) { setText(current => current === submitted ? '' : current); requestId.current = null; }
          else { void store.action(Promise.resolve(result)); }
        }
        void store.refresh();
      } finally { if (alive.current && currentScope.current === target) setSending(false); }
    })();
  };
  return <footer className="composer-area">
    <div className="composer-insights">
      <GoalTaskDock context={view.context} native={view.native} store={store} disabled={controlsDisabled} panel={panel === 'context' ? null : panel} setPanel={setPanel} />
    </div>
    <div className="composer-box">
      <div className="composer-options"><button type="button" className="composer-option" onClick={onOpenOriginal} disabled={onOpenOriginal === undefined} title="权限与模式由服务器原网页处理，不默认改成完全权限">权限 / 模式 ↗</button>
        <ModelSelector context={view.context} native={view.native} store={store} disabled={controlsDisabled} open={modelOpen} setOpen={value => { setModelOpen(value); if (value) setPanel(null); }} />
        <ContextInspector native={view.native} open={panel === 'context'} setOpen={open => { setPanel(open ? 'context' : null); if (open) setModelOpen(false); }} />
      </div>
      <div className="composer-input-wrap">
        {menuOpen && <div className="slash-menu" id={menuId} role="listbox" aria-label="斜杠命令">
          <header><span>输入 / 搜索 · ↑↓ 选择 · Enter 填入 · Esc 关闭</span><button type="button" onClick={() => readCommands(true)} disabled={commandState === 'loading' || controlsDisabled}>重读</button></header>
          {commandState === 'loading' && <p className="muted">正在读取该会话的服务器命令…</p>}
          {candidates.map((candidate, index) => <button type="button" role="option" aria-selected={index === highlight} id={`${menuId}-${index}`} key={candidate.name} className={index === highlight ? 'is-highlighted' : ''}
            onMouseDown={event => event.preventDefault()} onMouseEnter={() => setHighlight(index)} onClick={() => pick(candidate)}><span>/{candidate.name}<small>{candidate.kind === 'local' ? '本地面板' : '服务器命令'}</small></span><span>{candidate.description}</span></button>)}
          {candidates.length === 0 && <p className="muted">没有匹配命令；插件额外入口可用原网页。</p>}
        </div>}
        <textarea ref={input} value={text} maxLength={65536} placeholder={disabled ? '当前仅可查看；连接、登录或退出演示后才能发送' : '发送消息，或输入 / 搜索命令…'} rows={3} aria-label="当前会话输入" aria-controls={menuOpen ? menuId : undefined} aria-expanded={menuOpen} aria-autocomplete="list" aria-activedescendant={menuOpen && candidates.length > 0 ? `${menuId}-${highlight}` : undefined}
          disabled={disabled} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
          onChange={event => updateText(event.target.value)} onKeyDown={event => {
            if (composing.current || event.nativeEvent.isComposing) return;
            if (menuOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && candidates.length > 0) { event.preventDefault(); setHighlight(current => (current + (event.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length); return; }
            if (event.key === 'Escape') { if (menuOpen) { event.preventDefault(); setMenuDismissed(true); } else { setPanel(null); setModelOpen(false); } return; }
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); const candidate = menuOpen ? candidates[highlight] : undefined; if (candidate !== undefined) pick(candidate); else send(); }
          }} />
      </div>
      <div className="composer-controls"><span className="muted">Enter 发送 · Shift+Enter 换行 · @ 文件引用使用原网页</span><div>
        {running && <button type="button" disabled={disabled || stopping} className="stop-task" onClick={() => {
          setStopping(true); const target = scope; void store.action(store.api.stopRemote(view.context)).finally(() => { if (alive.current && currentScope.current === target) setStopping(false); });
        }}>{stopping ? '停止请求中…' : '停止远程任务'}</button>}
        <button type="button" className="primary send-button" disabled={disabled || sending || text.trim() === ''} onClick={send}>{sending ? '提交中…' : '发送 ↑'}</button>
      </div></div>
    </div>
    {localError !== '' && <p className="delivery-warning" role="status">{localError}</p>}
    {view.sendState === 'uncertain' && <p className="delivery-warning" role="status">上次送达未知，不会自动重发。请先核实远程会话；编辑后再次发送属于新请求。</p>}
  </footer>;
}
