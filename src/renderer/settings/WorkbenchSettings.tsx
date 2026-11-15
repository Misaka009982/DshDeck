import { useEffect, useRef } from 'react';
import type { WorkbenchSnapshot, WorkbenchSettings } from '../../shared/domain.js';
import type { WorkbenchClientStore } from '../state/workbench-store.js';
import { SyncSettings } from './SyncSettings.js';

export function WorkbenchSettingsDialog({ snapshot, store, open, close }: { readonly snapshot: WorkbenchSnapshot; readonly store: WorkbenchClientStore; readonly open: boolean; readonly close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (open && !dialog.current?.open) dialog.current?.showModal(); else if (!open) dialog.current?.close(); }, [open]);
  const change = (settings: WorkbenchSettings): void => { void store.action(store.api.updateSettings(settings)); };
  return <dialog ref={dialog} className="settings-dialog" onCancel={event => { event.preventDefault(); close(); }}>
    <header className="dialog-header"><h2>工作台设置</h2><button className="icon-button" type="button" aria-label="关闭" onClick={close}>×</button></header>
    <SyncSettings settings={snapshot.settings} change={change} />
    <section className="settings-section"><h3>外观与通知</h3><label>主题<select value={snapshot.settings.theme} onChange={event => change({ ...snapshot.settings, theme: event.target.value as WorkbenchSettings['theme'] })}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
      <label>左侧宽度（px）<input type="range" min={200} max={480} step={10} value={snapshot.settings.sidebarWidth} onChange={event => change({ ...snapshot.settings, sidebarWidth: Number(event.target.value) })} /></label>
      <label className="checkbox-setting"><input type="checkbox" checked={snapshot.settings.notifications} onChange={event => change({ ...snapshot.settings, notifications: event.target.checked })} />启用关注会话的桌面提醒</label>
    </section>
    <section className="settings-section"><h3>本机 pet-e</h3><p className="muted small">只展示关注任务、提醒并点击跳回会话。不会在宠物中作答或批准，不下载或捆绑第三方图片。</p>
      <div className="path-setting"><span>{snapshot.pet.runtimeRoot ?? '未选择本机 companion'}</span><button type="button" onClick={() => { void store.action(store.api.choosePetPath('runtime')); }}>选择 pet-e</button></div>
      <div className="path-setting"><span>{snapshot.pet.resourceRoot ?? '未选择合法宠物资源'}</span><button type="button" onClick={() => { void store.action(store.api.choosePetPath('resources')); }}>选择资源</button></div>
      <label className="checkbox-setting"><input type="checkbox" checked={snapshot.settings.petEnabled} onChange={event => change({ ...snapshot.settings, petEnabled: event.target.checked })} />启用本机宠物</label>
      <p className="muted small" role="status">{snapshot.pet.message}</p>
    </section>
    <section className="settings-section"><h3>演示与兼容</h3><label className="checkbox-setting"><input type="checkbox" checked={snapshot.demo} onChange={event => { void store.action(store.api.setDemo(event.target.checked)); }} />显示合成演示数据（不联网，不执行任务）</label>
      <p className="muted small">真实部署兼容、认证、流量和缓存时延仍需在全部实现后统一验证。</p>
    </section>
    <footer className="dialog-actions"><button type="button" className="primary" onClick={close}>完成</button></footer>
  </dialog>;
}
