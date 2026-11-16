import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { WorkbenchSnapshot } from '../../shared/domain.js';
import { panelAlpha } from '../../shared/appearance.js';
import { sameWebContext } from '../../shared/session-web.js';
import type { WorkbenchClientStore } from '../state/workbench-store.js';
import { MessageList } from './MessageList.js';
import { Composer } from './Composer.js';
import { PendingInteractionPanel } from './PendingInteractionPanel.js';

type PaneMode = 'conversation' | 'output' | 'events' | 'files';
export function ConversationPane({ snapshot, store, overlayOpen = false }: { readonly snapshot: WorkbenchSnapshot; readonly store: WorkbenchClientStore; readonly overlayOpen?: boolean }) {
  const [mode, setMode] = useState<PaneMode>('conversation');
  const [fileHint, setFileHint] = useState('项目文件与修改详情由服务器原网页提供。');
  const host = useRef<HTMLDivElement>(null);
  const view = snapshot.conversation; const web = snapshot.web;
  const legacyTarget = web?.context === null && web.serverId !== null;
  const legacy = legacyTarget && web?.state === 'ready';
  const matching = view !== null && web !== undefined && sameWebContext(view.context, web.context);
  const webReady = web?.state === 'ready' && (matching || legacy);
  const visibleWeb = webReady && (mode === 'conversation' || mode === 'files') && !overlayOpen;
  const contextKey = view === null ? '' : JSON.stringify([view.context.serverId, view.context.authProfileId, view.context.generation, view.context.sessionId]);
  useEffect(() => { setMode('conversation'); setFileHint('项目文件与修改详情由服务器原网页提供。'); }, [contextKey]);
  useEffect(() => {
    const element = host.current; if (element === null) return;
    let frame: number | null = null;
    const publish = (): void => {
      frame = null; const bounds = element.getBoundingClientRect();
      void store.api.setWebViewport({ x: Math.max(0, Math.round(bounds.x)), y: Math.max(0, Math.round(bounds.y)), width: Math.max(0, Math.round(bounds.width)), height: Math.max(0, Math.round(bounds.height)), visible: visibleWeb });
    };
    const resize = (): void => { frame ??= requestAnimationFrame(publish); };
    const observer = new ResizeObserver(resize); observer.observe(element); window.addEventListener('resize', resize); publish();
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); if (frame !== null) cancelAnimationFrame(frame); };
  }, [visibleWeb, contextKey, legacy, store]);
  useEffect(() => {
    if (!webReady || mode !== 'files') return;
    let current = true;
    void store.api.showWebFiles().then(result => {
      if (current) setFileHint(result.ok && result.value ? '已打开原网页文件区；文件内容与修改详情按插件原样显示。' : '请在原网页打开文件区；也可通过 ☰ 显示原网页侧栏。缓存功能区后可继续做原生适配。');
    });
    return () => { current = false; };
  }, [mode, webReady, contextKey, store]);
  const confirmRead = useCallback(() => {
    if (view === null || visibleWeb || overlayOpen) return;
    void store.api.confirmRead({ context: view.context, throughSeq: view.cursor, visible: document.visibilityState === 'visible', focused: document.hasFocus() });
  }, [store, view, visibleWeb, overlayOpen]);
  const server = snapshot.servers.find(server => server.config.id === view?.context.serverId);
  const row = [...(server?.unassigned ?? []), ...(server?.tree.flatMap(workspace => workspace.sessions) ?? [])].find(session => session.sessionId === view?.context.sessionId);
  const ready = server?.state === 'readonly-ready' && server.config.id !== 'demo' && row !== undefined && !row.archived;
  const choose = (next: PaneMode): void => {
    setMode(next);
    if (next === 'files' && !webReady && view !== null) void store.action(store.api.openFallback(view.context.serverId));
    if (next === 'conversation' && webReady) void store.api.showWebConversation();
  };
  const status = webReady && (mode === 'conversation' || mode === 'files') ? '原网页实时' : view?.status === 'live' ? '当前会话实时' : view?.status === 'stale' ? '离线缓存' : view?.status === 'gap' ? '局部缺口' : view?.status === 'loading' ? '首次读取' : view?.status === 'error' ? '读取失败' : '近期缓存';
  const transparent = snapshot.appearance?.settings.backgroundEnabled && snapshot.appearance.image !== null && snapshot.appearance.imageState === 'ready';
  const alpha = transparent ? panelAlpha(snapshot.appearance?.settings.sessionTransparency ?? 20, true) : 1;
  const webStyle = { backgroundColor: `rgba(${web?.dark ? '25,25,25' : '250,250,250'},${alpha})` } as CSSProperties;
  return <main className="deck-conversation">
    <nav className="conversation-tabs" aria-label="会话视图">{(['conversation', 'output', 'events', 'files'] as const).map(tab => <button type="button" key={tab} disabled={view === null && !legacy} aria-pressed={mode === tab} className={mode === tab ? 'active' : ''} onClick={() => choose(tab)}>{tab === 'conversation' ? '对话' : tab === 'output' ? '工具输出' : tab === 'events' ? '事件' : '文件夹'}</button>)}
      <span className="cache-indicator" title={webReady ? '原网页保持当前会话实时；原生缓存在后台按间隔更新。' : status}>{view === null && !legacy ? '等待选择会话' : status}{view?.syncedAt !== null && view?.syncedAt !== undefined && ` · ${new Date(view.syncedAt).toLocaleTimeString()}`}{view?.syncing ? ' · 缓存同步中' : ''}</span>
    </nav>
    {mode === 'files' && <div className="file-panel-note" role="status">{fileHint}</div>}
    {matching && web?.state === 'loading' && <div className="web-load-note" role="status">正在定位原网页，先显示已有缓存。</div>}
    {(matching || legacyTarget) && web?.state === 'failed' && <div className="inline-failure" role="status">{web.message}<button type="button" onClick={() => { if (view !== null) void store.action(store.api.openFallback(view.context.serverId)); else if (web.serverId !== null) void store.action(store.api.openWholeServer(web.serverId)); }}>重试原网页</button><button type="button" onClick={() => { const id = view?.context.serverId ?? web.serverId; if (id !== null) void store.action(store.api.openWholeServer(id)); }}>整站网页</button></div>}
    <div className="conversation-body" ref={host}>
      {webReady && (mode === 'conversation' || mode === 'files') ? <div className="web-underlay" style={webStyle} aria-label="服务器原网页会话区域" /> : view === null ? <div className="welcome-pane"><div><h1>选择一个会话</h1><p>添加服务器，在内置浏览器登录，再从左侧选择工作区和会话。</p><p className="muted">左侧可折叠为关注图标；后台运行会话按设置预缓存。</p></div></div> : <>
        {view.hasMore && <button type="button" className="load-older" onClick={() => { void store.action(store.api.loadOlder(view.context)); }}>加载更早历史</button>}
        {view.failure !== null && <div className="inline-failure" role="status">{view.failure.message}<button type="button" onClick={() => { void store.action(store.api.syncNow(view.context)); }}>重试读取</button><button type="button" onClick={() => { void store.action(store.api.authenticateServer(view.context.serverId)); }}>重新登录</button></div>}
        {view.hasGap && <div className="gap-warning" role="status">保留可用缓存，缺失区间尚未补齐；不会标为完整或已读。</div>}
        <MessageList view={view} mode={mode === 'files' ? 'conversation' : mode} onRead={confirmRead} onOpenOriginal={() => { void store.action(store.api.openFallback(view.context.serverId)); }} />
        {!webReady && <PendingInteractionPanel pending={view.pending} context={view.context} store={store} />}
        {webReady && <div className="web-load-note">当前人工交互由原网页处理；这里展示原生缓存，切回“对话”处理问题与审批。</div>}
        {!webReady && view.pending.length === 0 && (row?.pendingCount ?? 0) > 0 && <div className="gap-warning">服务器确认需要交互，但本客户端未取得可回答的结构；请使用原网页。</div>}
        <Composer key={`${view.context.serverId}:${view.context.authProfileId}:${view.context.generation}:${view.context.sessionId}`} view={view} store={store} disabled={!ready || webReady} controlsDisabled={!ready || webReady || row?.origin === 'subagent'} running={row?.running ?? false}
          onOpenOriginal={() => { choose('conversation'); if (!webReady) void store.action(store.api.openFallback(view.context.serverId)); }} />
      </>}
    </div>
  </main>;
}
