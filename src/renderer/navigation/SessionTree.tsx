import { useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { ServerRow, SessionRow, TaskCounts, TaskColor, WorkbenchSnapshot } from '../../shared/domain.js';
import { contextFor, filterTree, isSelected, selectedFilteredOut } from './tree-model.js';
import type { TreeQuery } from './tree-model.js';
import type { WorkbenchClientStore } from '../state/workbench-store.js';
import { recoveryText } from '../../shared/recovery.js';
import type { NetworkCheckReport } from '../../shared/network-check.js';
import { NetworkCheckPanel } from './NetworkCheckPanel.js';
import { WorkbenchIcon } from '../ui/WorkbenchIcon.js';

const colorText: Record<TaskColor, string> = { green: '运行中', yellow: '等待交互', red: '明确失败', blue: '完成待确认' };
const stateText: Record<ServerRow['state'], string> = {
  idle: '未连接', authenticating: '登录中', probing: '连接中…', 'readonly-ready': '已验证 · 已连接',
  'auth-required': '需重新登录', denied: '访问被拒绝', incompatible: '仅兼容页面', failed: '离线', cancelled: '登录已取消',
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
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
  const [reports, setReports] = useState<ReadonlyMap<string, { readonly identity: string; readonly report: NetworkCheckReport | null; readonly error: string }>>(new Map());
  const [now, setNow] = useState(Date.now());
  const waiting = snapshot.servers.some(server => server.recovery?.phase === 'waiting');
  useEffect(() => { if (!waiting) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [waiting]);
  const identity = (server: ServerRow): string => JSON.stringify([server.config.authProfileId, server.generation, server.config.baseUrl, server.config.proxyMode ?? 'system']);
  const check = (server: ServerRow): void => {
    const id = server.config.id; if (checking.has(id)) return;
    setChecking(previous => new Set([...previous, id]));
    void store.api.checkNetwork(id).then(result => {
      setReports(previous => { const next = new Map(previous); next.set(id, { identity: identity(server), report: result.ok ? result.value : null, error: result.ok ? '' : result.error.message }); return next; });
    }).catch(() => setReports(previous => { const next = new Map(previous); next.set(id, { identity: identity(server), report: null, error: '本地线路检查接口暂不可用。' }); return next; }))
      .finally(() => setChecking(previous => { const next = new Set(previous); next.delete(id); return next; }));
  };
  const visible = filterTree(snapshot.servers, query, snapshot.selected);
  const toggle = (id: string): void => setCollapsed(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const connect = (id: string): void => {
    if (connecting.has(id)) return;
    setConnecting(previous => new Set([...previous, id]));
    void store.action(store.api.connectServer(id)).finally(() => setConnecting(previous => { const next = new Set(previous); next.delete(id); return next; }));
  };
  const closeMenu = (button: HTMLButtonElement): void => { const details = button.closest('details'); if (details instanceof HTMLDetailsElement) details.open = false; };
  const keyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.tree-select')].filter(button => button.offsetParent !== null && !button.disabled);
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
      <button className="tree-select session-select" type="button" disabled={session.archived || server.state !== 'readonly-ready' || server.directoryReady === false} onClick={() => { void store.select(context); }} title={`${session.title}\n${server.config.alias} › ${workspaceId === null ? '未归属工作区' : server.tree.find(workspace => workspace.workspaceId === workspaceId)?.title ?? '工作区'}\n会话 ID：${session.sessionId}`}>
        {session.task !== null ? <span className={`task-light light-${session.task} ${session.freshness === 'stale' ? 'is-stale' : ''}`} aria-label={`${colorText[session.task]}${session.freshness === 'stale' ? '（已过期）' : ''}`} /> : <span className="session-glyph" aria-hidden="true"><WorkbenchIcon name="chat" size={13} /></span>}
        <span className="session-label">{session.title}</span>
        {session.unread && <span className="unread-dot" aria-label="未读" />}
      </button>
      <button type="button" className={`follow-button ${session.followed ? 'is-followed' : ''}`} disabled={server.state !== 'readonly-ready' || server.directoryReady === false} aria-label={session.followed ? '取消关注' : '关注会话'} aria-pressed={session.followed}
        onClick={() => { void store.action(store.api.setFollowed(context, !session.followed)); }}><WorkbenchIcon name="star" size={13} /></button>
    </div>;
  };
  return <aside className="deck-sidebar">
    <header className="deck-brand"><span>DshDeck</span><button type="button" className="icon-button" onClick={onAdd} aria-label="添加服务器" title="添加服务器"><WorkbenchIcon name="plus" size={19} /></button></header>
    <div className="tree-search"><input value={query.text} onChange={event => setQuery({ ...query, text: event.target.value })} placeholder="搜索服务器、工作区、会话" aria-label="搜索导航" />
      <select value={query.filter} onChange={event => setQuery({ ...query, filter: event.target.value as TreeQuery['filter'] })} aria-label="会话筛选">
        <option value="all">全部会话</option><option value="followed">已关注</option><option value="running">运行中</option><option value="pending">待交互</option><option value="unread">未读</option>
      </select>
    </div>
    <div className="tree-caption"><span>服务器</span><span>计数仅关注</span></div>
    <div className="deck-tree" role="tree" aria-label="服务器、工作区和会话" onKeyDown={keyboard}>
      {visible.map(({ server, workspaces, unassigned }) => {
        const folded = collapsed.has(server.config.id);
        const label = server.authenticationOpen ? server.failure !== null ? '登录页加载失败' : '等待网页登录' : server.recovery === undefined ? stateText[server.state] : recoveryText(server.recovery, now);
        const report = reports.get(server.config.id); const currentReport = report?.identity === identity(server) ? report : undefined;
        return <section className="tree-server" key={server.config.id} role="treeitem" aria-expanded={!folded}>
          <div className="server-line"><button type="button" className="tree-select server-heading" onClick={() => toggle(server.config.id)} onKeyDown={event => {
            if (event.key === 'ArrowLeft' && !folded || event.key === 'ArrowRight' && folded) { toggle(server.config.id); event.preventDefault(); }
          }}><span className="chevron" aria-hidden="true"><WorkbenchIcon name="chevron-down" className={folded ? 'is-collapsed' : ''} size={12} /></span><span className="server-label">{server.config.alias}</span><TaskBadge counts={server.counts} /></button></div>
          <div className="server-subline" title={`${label}${server.failure === null ? '' : `\n${server.failure.message}`}`}><span className={`connection-mark ${server.state === 'readonly-ready' ? 'online' : ''} ${server.recovery !== undefined && server.recovery.phase !== 'stopped' ? 'is-reconnecting' : ''}`} aria-hidden="true" />{label}</div>
          {server.config.id !== 'demo' && <div className="server-controls">
            <button type="button" className="server-connect-button" disabled={connecting.has(server.config.id) || server.state === 'probing' || server.authenticationOpen} onClick={() => connect(server.config.id)}>{server.state === 'readonly-ready' ? '重连' : server.recovery === undefined ? '连接' : '立即重试'}</button>
            <details className="server-overflow" onBlur={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }} onKeyDown={event => {
              if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector<HTMLElement>('summary')?.focus(); event.stopPropagation(); }
              if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.currentTarget.open = true; const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')].filter(button => !button.disabled);
                const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? (current + 1) % buttons.length : (current - 1 + buttons.length) % buttons.length;
                buttons[next]?.focus(); event.preventDefault(); event.stopPropagation();
              }
            }}><summary title="服务器操作" aria-label={`${server.config.alias} 的操作`}>···</summary><div className="server-more-actions" role="group" aria-label="服务器操作">
              <button type="button" onClick={event => { closeMenu(event.currentTarget); void store.action(store.api.authenticateServer(server.config.id)); }}><WorkbenchIcon name="shield" size={14} />重新登录</button>
              <button type="button" onClick={event => { closeMenu(event.currentTarget); onEdit(server); }}><WorkbenchIcon name="edit" size={14} />编辑服务器</button>
              <button type="button" onClick={event => { closeMenu(event.currentTarget); void store.action(store.api.openWholeServer(server.config.id)); }} title="显式打开整站原网页，可查看未适配的布局与插件"><WorkbenchIcon name="external" size={14} />整站原网页</button>
              <button type="button" disabled={checking.has(server.config.id) || connecting.has(server.config.id) || server.state === 'probing' || server.authenticationOpen} onClick={event => { closeMenu(event.currentTarget); check(server); }} title="仅手动检查保存入口的线路，不发 Cookie 或 RPC 正文"><WorkbenchIcon name="activity" size={14} />检查线路</button>
              <button type="button" onClick={event => { closeMenu(event.currentTarget); void store.action(store.api.disconnectServer(server.config.id)); }} title="停止当前连接与自动恢复，同日重开不再自动连接"><WorkbenchIcon name="stop" size={14} />{server.recovery === undefined ? '断开连接' : '停止重连'}</button>
            </div></details>
          </div>}
          {(checking.has(server.config.id) || currentReport !== undefined) && <NetworkCheckPanel busy={checking.has(server.config.id)} report={currentReport?.report ?? null} error={currentReport?.error ?? ''} copy={() => { void store.action(store.api.copyDiagnostics()); }} />}
          {!folded && <div role="group" className="server-children">
            {workspaces.map(workspace => {
              const id = `${server.config.id}:${workspace.workspaceId}`;
              const collapsedWorkspace = collapsed.has(id);
              return <div key={workspace.workspaceId} role="treeitem" aria-expanded={!collapsedWorkspace} className="tree-workspace">
                <button className="tree-select workspace-heading" type="button" onClick={() => toggle(id)} onKeyDown={event => {
                  if (event.key === 'ArrowLeft' && !collapsedWorkspace || event.key === 'ArrowRight' && collapsedWorkspace) { toggle(id); event.preventDefault(); }
                }} title={workspace.path}><span className="chevron" aria-hidden="true"><WorkbenchIcon name="chevron-down" className={collapsedWorkspace ? 'is-collapsed' : ''} size={12} /></span><WorkbenchIcon name="folder" size={12} /><span className="workspace-label">{workspace.title}</span><TaskBadge counts={workspace.counts} /></button>
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
    <footer className="tree-footer"><TaskBadge counts={snapshot.counts} /><span>关注任务</span></footer>
  </aside>;
}
