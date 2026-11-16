import { useEffect, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import type { ServerRow } from '../shared/domain.js';
import { cropFrame, DEFAULT_APPEARANCE, panelAlpha } from '../shared/appearance.js';
import { sameWebContext } from '../shared/session-web.js';
import { SessionTree } from './navigation/SessionTree.js';
import { SessionRail } from './navigation/SessionRail.js';
import { ConversationPane } from './session/ConversationPane.js';
import { ServerSettings } from './settings/ServerSettings.js';
import { WorkbenchSettingsDialog } from './settings/WorkbenchSettings.js';
import { WorkbenchClientStore } from './state/workbench-store.js';
import { WorkbenchIcon } from './ui/WorkbenchIcon.js';

const store = new WorkbenchClientStore(window.dshDeck);
export function App() {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const error = useSyncExternalStore(store.subscribe, store.getError);
  const [adding, setAdding] = useState(false); const [editing, setEditing] = useState<ServerRow | null>(null); const [settings, setSettings] = useState(false);
  const [diagnosticStatus, setDiagnosticStatus] = useState('');
  const [layoutSaved, setLayoutSaved] = useState(false);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [dark, setDark] = useState(window.matchMedia('(prefers-color-scheme: dark)').matches);
  const copyDiagnostics = (): void => {
    void store.api.copyDiagnostics().then(result => {
      if (result.ok) { setLayoutSaved(false); setDiagnosticStatus('脱敏诊断已复制，可直接粘贴反馈；没有上传任何数据。'); }
      else { void store.action(Promise.resolve(result)); }
    });
  };
  const add = (): void => { setEditing(null); setAdding(true); };
  useEffect(() => { store.start(); return () => store.stop(); }, []);
  useEffect(() => store.api.onOpenSettings(() => setSettings(true)), []);
  useEffect(() => { document.documentElement.dataset.theme = snapshot?.settings.theme ?? 'system'; }, [snapshot?.settings.theme]);
  useEffect(() => {
    const resize = (): void => setViewport({ width: Math.max(1, window.innerWidth), height: Math.max(1, window.innerHeight) });
    const media = window.matchMedia('(prefers-color-scheme: dark)'); const theme = (): void => setDark(media.matches);
    window.addEventListener('resize', resize); media.addEventListener('change', theme);
    return () => { window.removeEventListener('resize', resize); media.removeEventListener('change', theme); };
  }, []);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.key.toLowerCase() === 'k') {
        const current = store.getSnapshot();
        if (current?.appearance?.settings.sidebarCollapsed) void store.action(store.api.updateAppearance({ sidebarCollapsed: false })).then(() => document.querySelector<HTMLInputElement>('[aria-label="搜索导航"]')?.focus());
        else document.querySelector<HTMLInputElement>('[aria-label="搜索导航"]')?.focus();
        event.preventDefault();
      }
      if (event.ctrlKey && event.key === ',') { setSettings(true); event.preventDefault(); }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'a') { add(); event.preventDefault(); }
    };
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  }, []);
  if (snapshot === null) return <main className="local-loading"><h1>DshDeck</h1><p>{error?.message ?? '正在读取本地工作台…'}</p><button type="button" onClick={() => { void store.refresh(); }}>重试本地接口</button><button type="button" onClick={copyDiagnostics}>复制诊断</button><button type="button" onClick={() => { void store.action(store.api.openLogs()); }}>打开日志</button>{diagnosticStatus !== '' && <p role="status">{diagnosticStatus}</p>}</main>;
  const appearance = snapshot.appearance?.settings ?? DEFAULT_APPEARANCE;
  const image = snapshot.appearance?.image ?? null;
  const hasBackground = appearance.backgroundEnabled && image !== null && snapshot.appearance?.imageState === 'ready';
  const frame = hasBackground && image !== null ? cropFrame(image, viewport, appearance.crop) : null;
  const resolvedDark = snapshot.settings.theme === 'dark' || snapshot.settings.theme === 'system' && dark;
  const navigationTint = resolvedDark ? '22,22,27' : '239,239,244';
  const conversationTint = resolvedDark ? '16,16,20' : '245,245,250';
  const style = { gridTemplateColumns: `${appearance.sidebarCollapsed ? 54 : snapshot.settings.sidebarWidth}px minmax(0,1fr)`,
    '--navigation-fill': hasBackground ? `rgba(${navigationTint},${panelAlpha(appearance.sessionTransparency, false)})` : 'var(--sidebar)',
    '--conversation-fill': hasBackground ? `rgba(${conversationTint},${panelAlpha(appearance.sessionTransparency, true)})` : 'var(--background)' } as CSSProperties;
  const legacy = snapshot.web?.context === null && snapshot.web.serverId !== null && (snapshot.web.state === 'ready' || snapshot.web.state === 'loading' || snapshot.web.state === 'failed');
  const context = legacy ? null : snapshot.selected;
  const server = snapshot.servers.find(server => server.config.id === (legacy ? snapshot.web?.serverId : context?.serverId));
  const workspace = server?.tree.find(workspace => workspace.workspaceId === context?.workspaceId);
  const row = [...(server?.unassigned ?? []), ...(server?.tree.flatMap(workspace => workspace.sessions) ?? [])].find(session => session.sessionId === context?.sessionId);
  const ready = context !== null && server?.state === 'readonly-ready' && server.directoryReady !== false && !server.authenticationOpen && row !== undefined && !row.archived;
  const webReady = snapshot.web?.state === 'ready' && sameWebContext(snapshot.web.context, context);
  const toggleSidebar = (): void => { void store.action(store.api.updateAppearance({ sidebarCollapsed: !appearance.sidebarCollapsed })); };
  const openMenu = (): void => {
    void store.api.openCommandMenu().then(async result => {
      if (!result.ok) { await store.action(Promise.resolve(result)); return; }
      if (result.value === 'settings') setSettings(true);
      else if (result.value === 'add-server') add();
      else if (result.value === 'logs') await store.action(store.api.openLogs());
      else if (result.value === 'copy-diagnostics') copyDiagnostics();
      else if (result.value === 'licenses') await store.action(store.api.openLicenses());
      else if (result.value === 'close-web') await store.action(store.api.closeFallback());
      else if (result.value === 'disconnect' && server !== undefined && server.config.id !== 'demo') await store.action(store.api.disconnectServer(server.config.id));
      else if (result.value === 'toggle-web-sidebar') await store.action(store.api.toggleWebSidebar());
      else if (result.value === 'layout-folder') await store.action(store.api.openWebLayouts());
      else if (result.value === 'cache-layout') {
        const saved = await store.api.cacheWebLayout();
        if (saved.ok) { setLayoutSaved(true); setDiagnosticStatus(`功能区结构已缓存：${saved.value.name}。可打开快照目录反馈；未采集正文或输入值，没有上传。`); }
        else await store.action(Promise.resolve(saved));
      }
    });
  };
  return <><div className="workbench-background" aria-hidden="true" style={image !== null && frame !== null ? {
    backgroundImage: `url("${image.assetUrl}")`, backgroundSize: `${image.width * frame.scale}px ${image.height * frame.scale}px`,
    backgroundPosition: `${viewport.width / 2 - frame.centerX * frame.scale}px ${viewport.height / 2 - frame.centerY * frame.scale}px` } : { backgroundImage: 'none' }} />
    <div className={`workbench-root ${hasBackground ? 'has-wallpaper' : ''}`} style={style}>
      <header className="compact-toolbar">
        <button type="button" className="icon-button navigation-toggle" onClick={toggleSidebar} title={appearance.sidebarCollapsed ? '展开左侧导航' : '折叠为关注图标栏'} aria-label={appearance.sidebarCollapsed ? '展开左侧导航' : '折叠左侧导航'} aria-expanded={!appearance.sidebarCollapsed}><WorkbenchIcon name="sidebar" size={18} /></button>
        <div className="compact-breadcrumb" title={context === null ? '' : `${server?.config.alias ?? '服务器'} › ${workspace?.title ?? '未归属工作区'}\n会话 ID：${context.sessionId}`}>
          {server !== undefined && <><span className="breadcrumb-server">{server.config.alias}</span><span className="breadcrumb-separator">›</span></>}
          {context !== null && <><span className="breadcrumb-workspace">{workspace?.title ?? '未归属工作区'}</span><span className="breadcrumb-separator">›</span></>}
          <strong className="breadcrumb-session">{legacy ? '原网页（整站）' : snapshot.conversation?.title ?? (snapshot.demo ? '选择演示会话' : '从左侧选择会话')}</strong>
          {row?.followed && <span className="header-follow-mark" aria-label="已关注"><WorkbenchIcon name="star" size={13} /></span>}
        </div>
        <div className="compact-actions" role="group" aria-label="当前会话操作">
          <button type="button" disabled={!ready} title="关注只控制任务灯和提醒，不控制后台预同步" aria-label={row?.followed ? '取消关注会话' : '关注会话'} aria-pressed={row?.followed ?? false} onClick={() => { if (context !== null) void store.action(store.api.setFollowed(context, !row?.followed)); }}><WorkbenchIcon name="star" size={15} /><span>关注</span></button>
          <button type="button" disabled={!ready} title="立即同步当前会话缓存" aria-label="立即同步" onClick={() => { if (context !== null) void store.action(store.api.syncNow(context)); }}><WorkbenchIcon name="refresh" size={15} /><span>同步</span></button>
          <button type="button" disabled={!ready} title="标为未读" aria-label="标为未读" onClick={() => { if (context !== null) void store.action(store.api.setManualUnread(context, true)); }}><WorkbenchIcon name="unread" size={15} /><span>未读</span></button>
          <button type="button" disabled={!ready || context?.serverId === 'demo'} aria-pressed={webReady} aria-label={webReady ? '切换原生缓存面板' : '打开当前会话原网页'} title={webReady ? '切换原生缓存面板' : '显示服务器原网页和插件'} onClick={() => {
            if (context === null) return;
            void store.action(webReady ? store.api.updateAppearance({ viewMode: 'native' }) : store.api.openFallback(context.serverId));
          }}><WorkbenchIcon name={webReady ? 'chat' : 'external'} size={15} /><span>{webReady ? '原生缓存' : '原网页'}</span></button>
          <button type="button" className="icon-button command-menu" aria-label="设置、日志与其他操作" aria-haspopup="menu" title="设置／日志／复制诊断／缓存原网页／关闭兼容页" onClick={openMenu}><WorkbenchIcon name="menu" size={19} /></button>
        </div>
      </header>
      {appearance.sidebarCollapsed ? <SessionRail snapshot={snapshot} store={store} onExpand={toggleSidebar} onAdd={add} /> : <SessionTree snapshot={snapshot} store={store} onAdd={add} onEdit={server => { setEditing(server); setAdding(true); }} />}
      <div className="workbench-right">
        {diagnosticStatus !== '' && <div className="global-error" role="status"><span>{diagnosticStatus}</span>{layoutSaved && <button type="button" onClick={() => { void store.action(store.api.openWebLayouts()); }}>快照目录</button>}<button type="button" onClick={() => setDiagnosticStatus('')} aria-label="关闭诊断提示">×</button></div>}
        {error !== null && <div className="global-error" role="status"><span>{error.message}</span><button type="button" onClick={() => store.clearError()} aria-label="关闭提示">×</button></div>}
        <ConversationPane snapshot={snapshot} store={store} overlayOpen={adding || settings} />
      </div>
      <ServerSettings store={store} editing={editing} open={adding} close={() => setAdding(false)} />
      <WorkbenchSettingsDialog snapshot={snapshot} store={store} open={settings} close={() => setSettings(false)} />
    </div>
  </>;
}
