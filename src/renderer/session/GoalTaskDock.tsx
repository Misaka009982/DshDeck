import { useEffect, useRef, useState } from 'react';
import type { SessionContext } from '../../shared/domain.js';
import type { GoalAction, GoalRef, NativeSnapshot } from '../../shared/native-controls.js';
import type { WorkbenchClientStore } from '../state/workbench-store.js';

export type GoalTaskPanel = 'tasks' | 'goal' | null;
interface Props { readonly context: SessionContext; readonly native: NativeSnapshot | undefined; readonly store: WorkbenchClientStore; readonly disabled: boolean; readonly panel: GoalTaskPanel; readonly setPanel: (panel: GoalTaskPanel) => void }
const phaseText = { active: '目标有效', paused: '已暂停', blocked: '目标受阻', complete: '已完成' } as const;
const todoText = { pending: '待开始', in_progress: '进行中', completed: '已完成' } as const;

export function GoalTaskDock({ context, native, store, disabled, panel, setPanel }: Props) {
  const root = useRef<HTMLDivElement>(null); const alive = useRef(true);
  const actionId = useRef<{ signature: string; id: string } | null>(null);
  const [editing, setEditing] = useState(false); const [objective, setObjective] = useState(''); const [ref, setRef] = useState<GoalRef | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const goal = native?.values.goal; const todos = native?.values.todos;
  const completed = todos?.filter(todo => todo.status === 'completed').length ?? 0;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (panel === null) return;
    const outside = (event: PointerEvent): void => { if (event.target instanceof Node && !root.current?.contains(event.target)) setPanel(null); };
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape' && !busy) setPanel(null); };
    window.addEventListener('pointerdown', outside); window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape); };
  }, [panel, busy]);
  const edit = (): void => {
    if (goal === undefined || disabled || busy) return;
    setRef(goal === null ? null : { id: goal.goal.id, revision: goal.goal.revision }); setObjective(goal?.goal.objective ?? ''); setEditing(true); setPanel('goal'); setError('');
  };
  const submit = (action: GoalAction): void => {
    if (disabled || busy) return;
    const signature = JSON.stringify(action);
    const previous = actionId.current; const request = previous !== null && previous.signature === signature ? previous : { signature, id: crypto.randomUUID() };
    actionId.current = request; const requestId = request.id;
    setBusy(true); setError(''); setNotice('');
    void store.api.goalAction({ context: { ...context }, requestId, action }).then(result => {
      if (!alive.current) return;
      if (result.ok) { actionId.current = null; setEditing(false); setNotice('服务器已接受动作；目标状态以随后的投影为准。'); }
      else setError(result.error.kind === 'conflict' ? '目标或会话状态已经改变，请先同步后重新编辑。' : ['uncertain', 'network', 'timeout'].includes(result.error.kind)
        ? '目标动作结果未知；不会自动重发，请先同步会话核实。' : `目标动作未完成（${result.error.kind}）。`);
      void store.refresh();
    }).finally(() => { if (alive.current) setBusy(false); });
  };
  return <div className="goal-task-dock" ref={root}>
    <div className="goal-task-buttons">
      <button type="button" className="composer-option" aria-expanded={panel === 'tasks'} onClick={() => setPanel(panel === 'tasks' ? null : 'tasks')}>任务{todos === undefined ? '' : ` ${completed}/${todos?.length ?? 0}`}</button>
      <button type="button" className="composer-option" aria-expanded={panel === 'goal'} onClick={() => setPanel(panel === 'goal' ? null : 'goal')}>目标{goal === null || goal === undefined ? '' : ` · ${phaseText[goal.goal.phase]}`}</button>
    </div>
    {goal !== undefined && goal !== null && <div className="goal-summary" title={goal.goal.objective}><span>{goal.goal.objective}</span><small>{goal.roundsStarted}/{goal.goal.maxGoalRounds} 轮</small></div>}
    {panel !== null && <div className="native-popover goal-popover" role="dialog" aria-label={panel === 'tasks' ? '会话任务列表' : '会话目标'}>
      <header><strong>{panel === 'tasks' ? '任务列表' : '会话目标'}</strong><button type="button" onClick={() => setPanel(null)} aria-label="关闭任务目标面板">×</button></header>
      {panel === 'tasks' ? <>
        {todos === undefined ? <p className="muted">服务器未提供可用的 todos 投影；不会制造本地假任务。</p> : todos === null || todos.length === 0 ? <p className="muted">当前轮没有任务列表。</p> : <ul className="session-todos">{todos.map((todo, index) => <li key={index} className={`todo-${todo.status}`}>
          <span aria-label={todoText[todo.status]}>{todo.status === 'completed' ? '☑' : todo.status === 'in_progress' ? '◉' : '□'}</span><div>{todo.content}<small>{todoText[todo.status]}</small></div>
        </li>)}</ul>}
        <p className="muted">任务由服务器 Agent 维护；展示不改变任务状态、不确认已读，也不激活后台会话。</p>
      </> : <>
        {goal === undefined ? <p className="muted">服务器未提供可用的 goal 投影；可在原网页查看插件入口。</p> : goal === null ? <p className="muted">该会话没有当前目标。</p> : <>
          <p className="goal-objective">{goal.goal.objective}</p><p className="goal-state">{phaseText[goal.goal.phase]} · 已开始 {goal.roundsStarted}/{goal.goal.maxGoalRounds} 轮 · 修订 {goal.goal.revision}</p>
          {goal.goal.blockedReason !== undefined && <p className="native-field-warning">{goal.goal.blockedReason.message}</p>}
          <div className="goal-actions"><button type="button" disabled={disabled || busy} onClick={edit}>编辑</button>
            {goal.goal.phase === 'active' && <button type="button" disabled={disabled || busy} onClick={() => submit({ kind: 'pause', ref: { id: goal.goal.id, revision: goal.goal.revision } })}>暂停目标</button>}
            {(goal.goal.phase === 'paused' || goal.goal.phase === 'blocked') && <button type="button" disabled={disabled || busy} onClick={() => submit({ kind: 'resume', ref: { id: goal.goal.id, revision: goal.goal.revision } })}>继续目标</button>}
            <button type="button" disabled={disabled || busy} onClick={() => submit({ kind: 'clear', ref: { id: goal.goal.id, revision: goal.goal.revision } })}>清除目标</button>
          </div>
        </>}
        {goal === null && !editing && <button type="button" disabled={disabled || busy} onClick={edit}>创建目标</button>}
        {editing && <form className="goal-editor" onSubmit={event => { event.preventDefault(); if (objective.trim() !== '') submit(ref === null ? { kind: 'create', objective: objective.trim() } : { kind: 'edit', ref, objective: objective.trim() }); }}>
          <textarea value={objective} onChange={event => setObjective(event.target.value)} maxLength={16384} rows={3} aria-label="目标内容" disabled={disabled || busy} placeholder="希望服务器完成的目标" />
          <div className="goal-actions"><button type="button" onClick={() => setEditing(false)} disabled={busy}>取消编辑</button><button type="submit" disabled={disabled || busy || objective.trim() === ''}>{busy ? '提交中…' : ref === null ? '创建目标' : '保存目标'}</button></div>
        </form>}
        <p className="muted">创建或继续目标可能让服务器按自身规则自动推进；只有你明确点击才提交。暂停/继续不等同于远程停止按钮。</p>
      </>}
      {native?.state !== 'live' && <p className="muted">当前显示为缓存或过期投影，变更会由服务器再次校验版本。</p>}
      {error !== '' && <p className="native-field-warning" role="status">{error}</p>}
      {notice !== '' && <p className="muted" role="status">{notice}</p>}
    </div>}
  </div>;
}
