import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { ServerRow, SessionRow, TaskCounts, TaskColor, WorkbenchSnapshot } from '../../shared/domain.js';
import { contextFor, filterTree, isSelected, selectedFilteredOut } from './tree-model.js';
import type { TreeQuery } from './tree-model.js';
import type { WorkbenchClientStore } from '../state/workbench-store.js';

const colorText: Record<TaskColor, string> = { green: '运行中', yellow: '等待交互', red: '明确失败', blue: '完成待确认' };
const stateText: Record<ServerRow['state'], string> = {
  idle: '未连接', authenticating: '登录中', probing: '连接中', 'readonly-ready': '已连接 · 待验证',
  'auth-required': '需登录', denied: '访问被拒绝', incompatible: '仅兼容页面', failed: '离线', cancelled: '登录已取消',
};
export function TaskBadge({ counts }: { counts: TaskCounts }) {
  return <span className="task-counts" aria-label={`关注任务：等待 ${counts.yellow}，失败 ${counts.red}，运行 ${counts.green}，完成 ${counts.blue}`}>
    {(['yellow', 'red', 'green', 'blue'] as const).map(color => counts[color] === 0 ? null : <span className={`count count-${color}`} key={color} title={`关注 · ${colorText[color]}`}>{counts[color]}</span>)}
  </span>;
}
interface Props { readonly snapshot: WorkbenchSnapshot; readonly store: WorkbenchClientStore; readonly onAdd: () => void; readonly onEdit: (server: ServerRow) => void }
export function SessionTree({ snapshot, store, onAdd, onEdit }: Props) {
  const [query, setQuery] = useState<TreeQuery>({ text: '', filter: 'all', showArchived: false, showSubagents: false });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [connecting, setConnecting] = useState<Set<string>>(new Set());
  const visible = filterTree(snapshot.servers, query, snapshot.selected);
  const toggle = (id: string): void => setCollapsed(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const connect = (id: string): void => {
    if (connecting.has(id)) return;
    setConnecting(previous => new Set([...previous, id]));
    void store.action(store.api.connectServer(id)).finally(() => setConnecting(previous => { const next = new Set(previous); next.delete(id); return next; }));
  };
  const keyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.tree-select')].filter(button => button.offsetParent !== null);
    const current = buttons.findIndex(button => button === document.activeElement);
    let next = current;
    if (event.key === 'ArrowDown') next = Math.min(buttons.length - 1, current + 1);
    if (event.key === 'ArrowUp') next = Math.max(0, current - 1);
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = buttons.length - 1;
    buttons[next]?.focus(); event.preventDefault();
  };
  const row = (server: ServerRow, workspaceId: string | null, session: SessionRow) => {
    const context = contextFor(server, workspaceId, session.sessionId);
    const selected = isSelected(context, snapshot.selected);
    return <div className={`session-row ${selected ? 'is-selected' : ''}`} key={session.sessionId} role="treeitem" aria-selected={selected}>
      <button className="tree-select session-select" type="button" disabled={session.archived} onClick={() => { void store.select(context); }} title={`${session.title}\n${server.config.alias} › ${workspaceId === null ? '未归属工作区' : server.tree.find(workspace => workspace.workspaceId === workspaceId)?.title ?? '工作区'}\n会话 ID：${session.sessionId}`}>
        {session.task !== null ? <span className={`task-light light-${session.task} ${session.freshness === 'stale' ? 'is-stale' : ''}`} aria-label={`${colorText[session.task]}${session.freshness === 'stale' ? '（已过期）' : ''}`} /> : <span className="session-glyph" aria-hidden="true">◇</span>}
        <span className="session-label">{session.title}</span>
        {session.unread && <span className="unread-dot" aria-label="未读" />}
      </button>
      <button type="button" className={`follow-button ${session.followed ? 'is-followed' : ''}`} aria-label={session.followed ? '取消关注' : '关注会话'} aria-pressed={session.followed}
        onClick={() => { void store.action(store.api.setFollowed(context, !session.followed)); }}>{session.followed ? '★' : '☆'}</button>
    </div>;
  };
  return <aside className="deck-sidebar">
    <header className="deck-brand"><span>DshDeck</span><button type="button" className="icon-button" onClick={onAdd} aria-label="添加服务器" title="添加服务器">＋</button></header>
    <div className="tree-search"><input value={query.text} onChange={event => setQuery({ ...query, text: event.target.value })} placeholder="搜索服务器、工作区、会话" aria-label="搜索导航" />
      <select value={query.filter} onChange={event => setQuery({ ...query, filter: event.target.value as TreeQuery['filter'] })} aria-label="会话筛选">
        <option value="all">全部会话</option><option value="followed">已关注</option><option value="running">运行中</option><option value="pending">待交互</option><option value="unread">未读</option>
      </select>
    </div>
    <div className="tree-caption"><span>服务器</span><span>计数仅关注</span></div>
    <div className="deck-tree" role="tree" aria-label="服务器、工作区和会话" onKeyDown={keyboard}>
      {visible.map(({ server, workspaces, unassigned }) => {
        const folded = collapsed.has(server.config.id);
        return <section className="tree-server" key={server.config.id} role="treeitem" aria-expanded={!folded}>
          <div className="server-line"><button type="button" className="tree-select server-heading" onClick={() => toggle(server.config.id)} onKeyDown={event => {
            if (event.key === 'ArrowLeft' && !folded || event.key === 'ArrowRight' && folded) { toggle(server.config.id); event.preventDefault(); }
          }}><span className="chevron" aria-hidden="true">{folded ? '›' : '⌄'}</span><span className="server-label">{server.config.alias}</span><TaskBadge counts={server.counts} /></button></div>
          <div className="server-subline" title={server.failure?.message ?? stateText[server.state]}><span className={`connection-mark ${server.state === 'readonly-ready' ? 'online' : ''}`} aria-hidden="true" />{server.authenticationOpen ? server.failure !== null ? '登录页加载失败' : '等待网页登录' : stateText[server.state]}</div>
          {server.config.id !== 'demo' && <div className="server-controls">
            <button type="button" disabled={connecting.has(server.config.id) || server.state === 'probing'} onClick={() => connect(server.config.id)}>连接</button>
            <button type="button" onClick={() => { void store.action(store.api.authenticateServer(server.config.id)); }}>重登</button>
            <button type="button" onClick={() => onEdit(server)}>编辑</button>
            <button type="button" onClick={() => { void store.action(store.api.openWholeServer(server.config.id)); }} title="显式打开整站原网页，可查看未适配的布局与插件">整站</button>
          </div>}
          {!folded && <div role="group" className="server-children">
            {workspaces.map(workspace => {
              const id = `${server.config.id}:${workspace.workspaceId}`;
              const collapsedWorkspace = collapsed.has(id);
              return <div key={workspace.workspaceId} role="treeitem" aria-expanded={!collapsedWorkspace} className="tree-workspace">
                <button className="tree-select workspace-heading" type="button" onClick={() => toggle(id)} onKeyDown={event => {
                  if (event.key === 'ArrowLeft' && !collapsedWorkspace || event.key === 'ArrowRight' && collapsedWorkspace) { toggle(id); event.preventDefault(); }
                }} title={workspace.path}><span className="chevron">{collapsedWorkspace ? '›' : '⌄'}</span><span className="workspace-label">{workspace.title}</span><TaskBadge counts={workspace.counts} /></button>
                {!collapsedWorkspace && <div role="group">{workspace.sessions.map(session => row(server, workspace.workspaceId, session))}{workspace.sessions.length === 0 && <p className="tree-empty">工作区没有会话</p>}</div>}
              </div>;
            })}
            {unassigned.length > 0 && <div className="tree-workspace"><div className="workspace-heading unassigned-label">未归属工作区</div>{unassigned.map(session => row(server, null, session))}</div>}
            {workspaces.length === 0 && unassigned.length === 0 && <p className="tree-empty">{server.state === 'readonly-ready' ? '真实目录为空' : '连接后加载真实目录'}</p>}
          </div>}
        </section>;
      })}
      {visible.length === 0 && <div className="tree-empty large">{snapshot.servers.length === 0 ? '点击 ＋ 添加服务器' : '没有匹配项；可调整搜索与筛选。'}</div>}
    </div>
    {selectedFilteredOut(visible, snapshot.selected) && <div className="filtered-selection" role="status">当前会话被筛选隐藏；右侧仍保留当前上下文。</div>}
    <label className="archive-toggle"><input type="checkbox" checked={query.showSubagents ?? false} onChange={event => setQuery({ ...query, showSubagents: event.target.checked })} />显示子智能体</label>
    <footer className="tree-footer"><TaskBadge counts={snapshot.counts} /><span>关注任务 · 部署待验证</span></footer>
  </aside>;
}
