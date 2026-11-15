import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ServerRow } from '../shared/domain.js';
import { SessionTree } from './navigation/SessionTree.js';
import { ConversationPane } from './session/ConversationPane.js';
import { ServerSettings } from './settings/ServerSettings.js';
import { WorkbenchSettingsDialog } from './settings/WorkbenchSettings.js';
import { WorkbenchClientStore } from './state/workbench-store.js';

const store = new WorkbenchClientStore(window.dshDeck);
export function App() {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const error = useSyncExternalStore(store.subscribe, store.getError);
  const [adding, setAdding] = useState(false); const [editing, setEditing] = useState<ServerRow | null>(null); const [settings, setSettings] = useState(false);
  useEffect(() => { store.start(); return () => store.stop(); }, []);
  useEffect(() => store.api.onOpenSettings(() => setSettings(true)), []);
  useEffect(() => { document.documentElement.dataset.theme = snapshot?.settings.theme ?? 'system'; }, [snapshot?.settings.theme]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.key.toLowerCase() === 'k') { document.querySelector<HTMLInputElement>('[aria-label="搜索导航"]')?.focus(); event.preventDefault(); }
      if (event.ctrlKey && event.key === ',') { setSettings(true); event.preventDefault(); }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'a') { setEditing(null); setAdding(true); event.preventDefault(); }
    };
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  }, []);
  if (snapshot === null) return <main className="local-loading"><h1>DshDeck</h1><p>{error?.message ?? '正在读取本地工作台…'}</p><button type="button" onClick={() => { void store.refresh(); }}>重试本地接口</button></main>;
  return <div className="workbench-root" style={{ gridTemplateColumns: `${snapshot.settings.sidebarWidth}px minmax(0, 1fr)` }}>
    <SessionTree snapshot={snapshot} store={store} onAdd={() => { setEditing(null); setAdding(true); }} onEdit={server => { setEditing(server); setAdding(true); }} />
    <div className="workbench-right">
      <header className="global-toolbar"><span>{snapshot.demo ? '演示模式 · 合成数据不联网' : '多服务器会话工作台'}</span><div><button type="button" onClick={() => setSettings(true)}>设置</button><button type="button" onClick={() => { void store.action(store.api.closeFallback()); }}>关闭兼容页</button>{snapshot.selected !== null && snapshot.selected.serverId !== 'demo' && <button type="button" onClick={() => { void store.action(store.api.disconnectServer(snapshot.selected?.serverId ?? '')); }}>断开服务器</button>}</div></header>
      {error !== null && <div className="global-error" role="status"><span>{error.message}</span><button type="button" onClick={() => store.clearError()} aria-label="关闭提示">×</button></div>}
      <ConversationPane snapshot={snapshot} store={store} />
      <footer className="verification-note">候选协议 0.2.2-rc.3 · 实机兼容与性能待统一验证</footer>
    </div>
    <ServerSettings store={store} editing={editing} open={adding} close={() => setAdding(false)} />
    <WorkbenchSettingsDialog snapshot={snapshot} store={store} open={settings} close={() => setSettings(false)} />
  </div>;
}
