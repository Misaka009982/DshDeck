import type { KeyboardEvent } from 'react';
import type { WorkbenchSnapshot } from '../../shared/domain.js';
import type { WorkbenchClientStore } from '../state/workbench-store.js';
import { followedSessionIcons, isSelected, sessionIconTitle } from './tree-model.js';

export function SessionRail({ snapshot, store, onExpand, onAdd }: { readonly snapshot: WorkbenchSnapshot; readonly store: WorkbenchClientStore; readonly onExpand: () => void; readonly onAdd: () => void }) {
  const items = followedSessionIcons(snapshot.servers, snapshot.selected);
  const selectable = new Map(snapshot.servers.map(server => [server.config.id, server.state === 'readonly-ready' && server.directoryReady !== false]));
  const keyboard = (event: KeyboardEvent<HTMLElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.followed-session-icon')].filter(button => !button.disabled);
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? Math.min(buttons.length - 1, current + 1) : Math.max(0, current - 1);
    buttons[index]?.focus(); event.preventDefault();
  };
  return <aside className="deck-sidebar session-rail" aria-label="关注会话图标栏" onKeyDown={keyboard}>
    <button type="button" className="icon-button rail-toggle" onClick={onExpand} title="展开服务器与工作区" aria-label="展开左侧导航">›</button>
    <div className="session-rail-items">{items.map(item => <button type="button" key={`${item.context.serverId}:${item.context.sessionId}`}
      className={`followed-session-icon ${isSelected(item.context, snapshot.selected) ? 'is-selected' : ''}`}
      disabled={!selectable.get(item.context.serverId)} title={sessionIconTitle(item)} aria-label={sessionIconTitle(item)} aria-pressed={isSelected(item.context, snapshot.selected)}
      onClick={() => { void store.select(item.context); }}>
      <span className="rail-session-glyph" aria-hidden="true">{Array.from(item.session.title)[0] ?? '◇'}</span>
      <span className="rail-follow-mark" aria-hidden="true">★</span>
      {item.session.task !== null && <span className={`task-light rail-task light-${item.session.task} ${item.session.freshness === 'stale' ? 'is-stale' : ''}`} />}
      {item.session.unread && <span className="unread-dot rail-unread" aria-label="未读" />}
    </button>)}{items.length === 0 && <span className="rail-empty" title="在展开的导航里关注会话，它就会显示在这里。">☆</span>}</div>
    <button type="button" className="icon-button rail-add" onClick={onAdd} aria-label="添加服务器" title="添加服务器">＋</button>
  </aside>;
}
