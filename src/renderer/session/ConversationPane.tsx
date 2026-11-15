import { useCallback, useState } from 'react';
import type { WorkbenchSnapshot } from '../../shared/domain.js';
import type { WorkbenchClientStore } from '../state/workbench-store.js';
import { MessageList } from './MessageList.js';
import { Composer } from './Composer.js';
import { PendingInteractionPanel } from './PendingInteractionPanel.js';

export function ConversationPane({ snapshot, store }: { readonly snapshot: WorkbenchSnapshot; readonly store: WorkbenchClientStore }) {
  const [mode, setMode] = useState<'conversation' | 'output' | 'events'>('conversation');
  const view = snapshot.conversation;
  const confirmRead = useCallback(() => {
    if (view === null) return;
    void store.api.confirmRead({ context: view.context, throughSeq: view.cursor, visible: document.visibilityState === 'visible', focused: document.hasFocus() });
  }, [store, view]);
  if (view === null) return <main className="deck-conversation welcome-pane"><div><h1>你的 dsh 会话工作台</h1><p>添加服务器，在内置浏览器登录，再从左侧选择工作区和会话。</p><p className="muted">只有关注的会话显示四色任务灯；所有运行中的后台会话都会按设置预缓存。</p></div></main>;
  const server = snapshot.servers.find(server => server.config.id === view.context.serverId);
  const row = [...(server?.unassigned ?? []), ...(server?.tree.flatMap(workspace => workspace.sessions) ?? [])].find(session => session.sessionId === view.context.sessionId);
  const workspace = server?.tree.find(workspace => workspace.workspaceId === view.context.workspaceId);
  const ready = server?.state === 'readonly-ready' && server.config.id !== 'demo' && row !== undefined;
  return <main className="deck-conversation">
    <header className="conversation-header"><div className="conversation-identity"><div className="conversation-breadcrumb">{server?.config.alias ?? '服务器'}<span>›</span>{workspace?.title ?? '未归属工作区'}</div><h1>{view.title}</h1></div>
      <div className="conversation-actions"><button type="button" title="关注只控制任务灯和提醒，不控制预同步" aria-pressed={row?.followed ?? false} onClick={() => { void store.action(store.api.setFollowed(view.context, !(row?.followed ?? false))); }}>{row?.followed ? '★ 已关注' : '☆ 关注'}</button>
        <button type="button" onClick={() => { void store.action(store.api.syncNow(view.context)); }}>立即同步</button><button type="button" onClick={() => { void store.action(store.api.setManualUnread(view.context, true)); }}>标为未读</button><button type="button" onClick={() => { void store.action(store.api.openFallback(view.context.serverId)); }}>兼容网页</button>
      </div></header>
    <nav className="conversation-tabs" aria-label="会话视图">{(['conversation', 'output', 'events'] as const).map(tab => <button type="button" key={tab} aria-pressed={mode === tab} className={mode === tab ? 'active' : ''} onClick={() => setMode(tab)}>{tab === 'conversation' ? '对话' : tab === 'output' ? '工具输出' : '事件'}</button>)}<span className="cache-indicator">{view.status === 'stale' ? '离线缓存' : view.status === 'gap' ? '局部缺口' : view.status === 'cached' ? '近期缓存' : view.status === 'loading' ? '首次读取' : '当前会话实时'}{view.syncedAt !== null && ` · ${new Date(view.syncedAt).toLocaleTimeString()}`}{view.syncing ? ' · 同步中' : ''}</span></nav>
    {view.hasMore && <button type="button" className="load-older" onClick={() => { void store.action(store.api.loadOlder(view.context)); }}>加载更早历史</button>}
    {view.failure !== null && <div className="inline-failure" role="status">{view.failure.message}<button type="button" onClick={() => { void store.action(store.api.syncNow(view.context)); }}>重试读取</button><button type="button" onClick={() => { void store.action(store.api.authenticateServer(view.context.serverId)); }}>重新登录</button></div>}
    {view.hasGap && <div className="gap-warning" role="status">正文保留可用缓存，缺失区间尚未补齐；不会将其标为完整或已读。</div>}
    <MessageList view={view} mode={mode} onRead={confirmRead} />
    <PendingInteractionPanel pending={view.pending} context={view.context} store={store} />
    {view.pending.length === 0 && (row?.pendingCount ?? 0) > 0 && <div className="gap-warning">服务器确认需要交互，但本客户端未取得可回答的结构；请使用兼容网页。</div>}
    <Composer key={`${view.context.serverId}:${view.context.authProfileId}:${view.context.sessionId}`} view={view} store={store} disabled={!ready} running={row?.running ?? false} />
  </main>;
}
