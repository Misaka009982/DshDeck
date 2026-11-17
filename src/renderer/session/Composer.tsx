import { useEffect, useId, useRef, useState } from 'react';
import type { ConversationView } from '../../shared/domain.js';
import type { CommandDescriptor } from '../../shared/native-controls.js';
import type { WorkbenchClientStore } from '../state/workbench-store.js';
import { WorkbenchIcon } from '../ui/WorkbenchIcon.js';
import { ModelSelector } from './ModelSelector.js';
import { ContextInspector } from './ContextInspector.js';
import { GoalTaskDock } from './GoalTaskDock.js';
import { RuntimeStatus } from './RuntimeStatus.js';
import { composerActivity } from './composer-model.js';
import { classifySlash, slashCandidates, slashQuery } from './slash-model.js';
import type { LocalSlashAction, SlashCandidate } from './slash-model.js';

export function Composer({ view, store, disabled, running, controlsDisabled = disabled, onOpenOriginal }: { readonly view: ConversationView; readonly store: WorkbenchClientStore; readonly disabled: boolean; readonly running: boolean; readonly controlsDisabled?: boolean; readonly onOpenOriginal?: () => void }) {
  const [text, setText] = useState(view.draft); const [sending, setSending] = useState(false); const [stopping, setStopping] = useState(false);
  const [commands, setCommands] = useState<readonly CommandDescriptor[]>([]); const [commandState, setCommandState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [localError, setLocalError] = useState(''); const [menuDismissed, setMenuDismissed] = useState(false); const [highlight, setHighlight] = useState(0);
  const [modelOpen, setModelOpen] = useState(false); const [toolsOpen, setToolsOpen] = useState(false); const [panel, setPanel] = useState<'context' | 'tasks' | 'goal' | null>(null);
  const composing = useRef(false); const requestId = useRef<string | null>(null); const input = useRef<HTMLTextAreaElement>(null); const tools = useRef<HTMLDivElement>(null);
  const scope = JSON.stringify([view.context.serverId, view.context.authProfileId, view.context.generation, view.context.sessionId]);
  const currentScope = useRef(scope); const alive = useRef(true); const menuId = useId(); const toolId = useId();
  const query = slashQuery(text); const candidates = query === null ? [] : slashCandidates(commands, query);
  const activity = composerActivity(view.native);
  const menuOpen = !disabled && !menuDismissed && query !== null && !composing.current;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { currentScope.current = scope; setText(view.draft); requestId.current = null; setSending(false); setCommands([]); setCommandState('idle'); setModelOpen(false); setToolsOpen(false); setPanel(null); setLocalError(''); }, [scope]);
  useEffect(() => { setHighlight(0); }, [query]);
  useEffect(() => {
    const element = input.current; if (element === null) return;
    element.style.height = 'auto'; element.style.height = `${Math.max(80, Math.min(210, element.scrollHeight))}px`;
  }, [text, scope]);
  useEffect(() => {
    if (!toolsOpen) return;
    tools.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const outside = (event: PointerEvent): void => { if (event.target instanceof Node && !tools.current?.contains(event.target)) setToolsOpen(false); };
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { setToolsOpen(false); tools.current?.querySelector<HTMLButtonElement>('.composer-add-button')?.focus(); } };
    window.addEventListener('pointerdown', outside); window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape); };
  }, [toolsOpen]);
  const readCommands = (refresh = false): void => {
    if (controlsDisabled || commandState === 'loading') return;
    const target = scope; setCommandState('loading');
    void store.api.commandCatalog(view.context, refresh).then(result => {
      if (!alive.current || currentScope.current !== target) return;
      if (result.ok) { setCommands(result.value); setCommandState('ready'); }
      else { setCommandState('failed'); setLocalError(`服务器命令目录不可用（${result.error.kind}）；本地面板入口仍可用，服务器命令不会改成普通消息。`); }
    }).catch(() => { if (alive.current && currentScope.current === target) { setCommandState('failed'); setLocalError('本地命令目录接口暂不可用；草稿已保留。'); } });
  };
  useEffect(() => { if (query !== null && commandState === 'idle' && !controlsDisabled) readCommands(); }, [query, commandState, controlsDisabled]);
  const updateText = (value: string): void => { setText(value); requestId.current = null; setLocalError(''); setMenuDismissed(false); void store.api.setDraft(view.context, value); };
  const showPanel = (action: LocalSlashAction): void => {
    setToolsOpen(false);
    if (action === 'model') { setPanel(null); setModelOpen(true); }
    else { setModelOpen(false); setPanel(action); }
  };
  const openLocal = (action: LocalSlashAction): void => { updateText(''); setMenuDismissed(true); showPanel(action); };
  const openSlash = (): void => {
    setToolsOpen(false); setModelOpen(false); setPanel(null);
    if (query !== null) setMenuDismissed(false);
    else if (text.trim() === '') updateText('/');
    else setLocalError('当前草稿已保留；斜杠菜单需要从输入开头 / 开始，不会覆盖已有消息。');
    requestAnimationFrame(() => input.current?.focus());
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
      } catch { if (alive.current && currentScope.current === target) setLocalError('提交结果尚未确认；不会自动重发，请先同步会话核实。'); }
      finally { if (alive.current && currentScope.current === target) setSending(false); }
    })();
  };
  const stop = (): void => {
    if (disabled || stopping) return;
    setStopping(true); const target = scope;
    void store.action(store.api.stopRemote(view.context)).finally(() => { if (alive.current && currentScope.current === target) setStopping(false); });
  };
  return <footer className="composer-area">
    <GoalTaskDock context={view.context} native={view.native} store={store} disabled={controlsDisabled} panel={panel === 'context' ? null : panel} setPanel={setPanel} />
    <RuntimeStatus view={view} running={running} />
    <div className="composer-box">
      <div className="composer-input-wrap">
        {menuOpen && <div className="slash-menu" id={menuId} role="listbox" aria-label="斜杠命令">
          <header><span>输入 / 搜索 · ↑↓ 选择 · Enter 填入 · Esc 关闭</span><button type="button" onClick={() => readCommands(true)} disabled={commandState === 'loading' || controlsDisabled}>重读</button></header>
          {commandState === 'loading' && <p className="muted">正在读取该会话的服务器命令…</p>}
          {candidates.map((candidate, index) => <button type="button" role="option" aria-selected={index === highlight} id={`${menuId}-${index}`} key={candidate.name} className={index === highlight ? 'is-highlighted' : ''}
            onMouseDown={event => event.preventDefault()} onMouseEnter={() => setHighlight(index)} onClick={() => pick(candidate)}><span>/{candidate.name}<small>{candidate.kind === 'local' ? '本地面板' : '服务器命令'}</small></span><span>{candidate.description}</span></button>)}
          {candidates.length === 0 && <p className="muted">没有匹配命令；插件额外入口可用原网页。</p>}
        </div>}
        <textarea ref={input} value={text} maxLength={65536} placeholder={disabled ? '当前仅可查看；连接就绪后才能发送' : '发消息或创建任务，/ 调用指令，@ 文件引用可用原网页'} rows={3} aria-label="当前会话输入" aria-controls={menuOpen ? menuId : undefined} aria-expanded={menuOpen} aria-autocomplete="list" aria-activedescendant={menuOpen && candidates.length > 0 ? `${menuId}-${highlight}` : undefined}
          disabled={disabled} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
          onChange={event => updateText(event.target.value)} onKeyDown={event => {
            if (composing.current || event.nativeEvent.isComposing) return;
            if (menuOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && candidates.length > 0) { event.preventDefault(); setHighlight(current => (current + (event.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length); return; }
            if (event.key === 'Escape') { if (menuOpen) { event.preventDefault(); setMenuDismissed(true); } else { setPanel(null); setModelOpen(false); setToolsOpen(false); } return; }
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); const candidate = menuOpen ? candidates[highlight] : undefined; if (candidate !== undefined) pick(candidate); else send(); }
          }} />
      </div>
      <div className="composer-controls">
        <div className="composer-tool-buttons" role="group" aria-label="输入工具">
          <div className="composer-tools" ref={tools}>
            <button type="button" className="icon-button composer-add-button" aria-label="会话快捷操作" title="目标、上下文、模型与原网页" aria-expanded={toolsOpen} aria-haspopup="menu" aria-controls={toolsOpen ? toolId : undefined} onClick={() => { setToolsOpen(!toolsOpen); setPanel(null); setModelOpen(false); }}><WorkbenchIcon name="plus" size={19} /></button>
            {toolsOpen && <div className="composer-tools-menu" role="menu" id={toolId} aria-label="会话快捷操作" onKeyDown={event => {
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
              const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].filter(button => !button.disabled);
              const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? (current + 1) % buttons.length : (current - 1 + buttons.length) % buttons.length;
              buttons[index]?.focus(); event.preventDefault();
            }}>
              <button type="button" role="menuitem" onClick={() => showPanel('goal')}><WorkbenchIcon name="target" /><span>{view.native?.values.goal === null ? '创建目标' : '目标详情'}</span><small>/goal</small></button>
              {activity.todos.length > 0 && <button type="button" role="menuitem" onClick={() => showPanel('tasks')}><WorkbenchIcon name="tasks" /><span>任务详情</span><small>/tasks</small></button>}
              <button type="button" role="menuitem" onClick={() => showPanel('context')}><WorkbenchIcon name="database" /><span>上下文与统计</span><small>/context</small></button>
              <button type="button" role="menuitem" disabled={controlsDisabled} onClick={() => showPanel('model')}><WorkbenchIcon name="activity" /><span>选择模型</span><small>/model</small></button>
              <button type="button" role="menuitem" disabled={disabled} onClick={openSlash}><span className="slash-tool-symbol" aria-hidden="true">/</span><span>斜杠命令</span></button>
              <button type="button" role="menuitem" disabled={onOpenOriginal === undefined} onClick={() => { setToolsOpen(false); onOpenOriginal?.(); }}><WorkbenchIcon name="external" /><span>原网页与插件功能</span></button>
            </div>}
          </div>
          <button type="button" className="composer-option composer-mode-button" onClick={onOpenOriginal} disabled={onOpenOriginal === undefined} title="权限与模式由服务器原网页处理，不默认改成完全权限"><WorkbenchIcon name="shield" size={16} /><span>权限</span><WorkbenchIcon name="external" size={11} /></button>
          <button type="button" className="icon-button composer-slash-button" disabled={disabled} onClick={openSlash} aria-label="打开斜杠命令" title="输入 / 搜索命令，不覆盖已有草稿"><span aria-hidden="true">/</span></button>
        </div>
        <div className="composer-submit-buttons">
          <ModelSelector context={view.context} native={view.native} store={store} disabled={controlsDisabled} open={modelOpen} setOpen={value => { setModelOpen(value); if (value) { setPanel(null); setToolsOpen(false); } }} />
          {running && <button type="button" disabled={disabled || stopping} className={`stop-task ${text.trim() === '' ? 'primary' : ''}`} onClick={stop} aria-label={stopping ? '停止请求中' : '停止远程任务'} title={stopping ? '停止请求中…' : '停止远程任务'}><WorkbenchIcon name="stop" size={17} /></button>}
          {(!running || text.trim() !== '') && <button type="button" className="primary send-button" disabled={disabled || sending || text.trim() === ''} onClick={send} aria-label={sending ? '提交中' : '发送消息'} title={sending ? '提交中…' : '发送 · Enter（Shift+Enter 换行）'}><WorkbenchIcon name="arrow-up" size={21} /></button>}
        </div>
      </div>
    </div>
    <div className="composer-metadata" aria-label="会话信息"><ContextInspector native={view.native} open={panel === 'context'} setOpen={open => { setPanel(open ? 'context' : null); if (open) { setModelOpen(false); setToolsOpen(false); } }} /></div>
    {localError !== '' && <p className="delivery-warning" role="status">{localError}</p>}
    {view.sendState === 'uncertain' && <p className="delivery-warning" role="status">上次送达未知，不会自动重发。请先核实远程会话；编辑后再次发送属于新请求。</p>}
  </footer>;
}
