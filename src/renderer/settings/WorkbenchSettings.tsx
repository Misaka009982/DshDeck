import { useEffect, useRef, useState } from 'react';
import type { AppearanceSettings } from '../../shared/appearance.js';
import { DEFAULT_APPEARANCE } from '../../shared/appearance.js';
import { BackgroundSettings } from './BackgroundSettings.js';
import type { WorkbenchSnapshot, WorkbenchSettings } from '../../shared/domain.js';
import type { WorkbenchClientStore } from '../state/workbench-store.js';
import { SyncSettings } from './SyncSettings.js';

export function WorkbenchSettingsDialog({ snapshot, store, open, close }: { readonly snapshot: WorkbenchSnapshot; readonly store: WorkbenchClientStore; readonly open: boolean; readonly close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [appearance, setAppearance] = useState<AppearanceSettings>(snapshot.appearance?.settings ?? DEFAULT_APPEARANCE);
  const [applying, setApplying] = useState(false);
  useEffect(() => { if (open) setAppearance(snapshot.appearance?.settings ?? DEFAULT_APPEARANCE); }, [open, snapshot.appearance?.image?.assetUrl]);
  useEffect(() => { if (open && !dialog.current?.open) dialog.current?.showModal(); else if (!open) dialog.current?.close(); }, [open]);
  const change = (settings: WorkbenchSettings): void => { void store.action(store.api.updateSettings(settings)); };
  return <dialog ref={dialog} className="settings-dialog" onCancel={event => { event.preventDefault(); close(); }}>
    <header className="dialog-header"><h2>工作台设置</h2><button className="icon-button" type="button" aria-label="关闭" onClick={close}>×</button></header>
    <SyncSettings settings={snapshot.settings} change={change} />
    <section className="settings-section"><h3>外观与通知</h3><label>默认会话显示<select value={snapshot.appearance?.settings.viewMode ?? 'web'} onChange={event => { void store.action(store.api.updateAppearance({ viewMode: event.target.value as 'web' | 'native' })); }}><option value="web">原网页优先，缓存先显示</option><option value="native">原生缓存面板</option></select></label><label>主题<select value={snapshot.settings.theme} onChange={event => change({ ...snapshot.settings, theme: event.target.value as WorkbenchSettings['theme'] })}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
      <label>左侧宽度（px）<input type="range" min={200} max={480} step={10} value={snapshot.settings.sidebarWidth} onChange={event => change({ ...snapshot.settings, sidebarWidth: Number(event.target.value) })} /></label>
      <label className="checkbox-setting"><input type="checkbox" checked={snapshot.settings.notifications} onChange={event => change({ ...snapshot.settings, notifications: event.target.checked })} />启用关注会话的桌面提醒</label>
    </section>
    <BackgroundSettings appearance={snapshot.appearance} value={appearance} change={setAppearance} store={store} />
    <div className="dialog-actions"><button type="button" disabled={applying} onClick={() => {
      if (applying) return; setApplying(true);
      void store.action(store.api.updateAppearance({ backgroundEnabled: appearance.backgroundEnabled, sessionTransparency: appearance.sessionTransparency, crop: appearance.crop })).finally(() => setApplying(false));
    }}>{applying ? '应用中…' : '应用背景'}</button></div>
    <section className="settings-section"><h3>宠物</h3><p className="muted small">本项目自带宠物窗口，无需另外的运行器。只展示关注会话、提醒并点击跳回；不会在宠物中作答或批准，不下载或捆绑第三方图片。</p>
      <div className="path-setting"><span>{snapshot.pet.resourceRoot ?? '未选择本机宠物库'}</span><button type="button" onClick={() => { void store.action(store.api.choosePetPath('resources')); }}>选择宠物库</button><button type="button" disabled={snapshot.pet.scanning || snapshot.pet.resourceRoot === null} onClick={() => { void store.action(store.api.rescanPets()); }}>{snapshot.pet.scanning ? '扫描中…' : '重新扫描'}</button></div>
      {(snapshot.pet.choices?.length ?? 0) > 0 && <fieldset className="pet-library"><legend>可选宠物 · 桌面只显示一只</legend>{snapshot.pet.choices?.map(pet => <label className={`pet-choice ${pet.available ? '' : 'is-unavailable'}`} key={pet.id}>
        <input type="radio" name="pet-selection" value={pet.id} checked={snapshot.pet.selectedPetId === pet.id} disabled={!pet.available || snapshot.pet.scanning} onChange={() => { void store.action(store.api.selectPet(pet.id)); }} />
        <span><strong>{pet.name}</strong><small>{pet.message}</small></span>
      </label>)}</fieldset>}
      {snapshot.pet.truncated && <p className="muted small" role="status">扫描达到安全上限；请缩小宠物库目录，当前结果不代表全部资源。</p>}
      <label>宠物大小 · {snapshot.pet.display.size}%<input type="range" min={50} max={200} step={5} value={snapshot.pet.display.size} onChange={event => { void store.action(store.api.updatePetDisplay({ size: Number(event.target.value) })); }} /></label>
      <div className="pet-display-options">{([
        ['alwaysOnTop', '窗口置顶'], ['lockPosition', '锁定位置'], ['showTaskArea', '显示关注任务灯与列表'], ['openOnHover', '悬浮展开任务'],
        ['showStatus', '显示状态标签'], ['showCliLabel', '显示任务来源'], ['notificationsEnabled', '显示宠物提醒'], ['soundEnabled', '宠物声音（默认关闭）'],
        ['autoHideFullscreen', '主窗口全屏时隐藏'],
      ] as const).map(([key, label]) => <label className="checkbox-setting" key={key}><input type="checkbox" checked={snapshot.pet.display[key]} onChange={event => { void store.action(store.api.updatePetDisplay({ [key]: event.target.checked })); }} />{label}</label>)}</div>
      <div className="dialog-actions"><button type="button" onClick={() => { void store.action(store.api.updatePetDisplay({ position: null })); }}>重置宠物位置</button></div>
      <label className="checkbox-setting"><input type="checkbox" checked={snapshot.settings.petEnabled} onChange={event => change({ ...snapshot.settings, petEnabled: event.target.checked })} />启用内置宠物</label>
      <p className="muted small" role="status">{snapshot.pet.message}</p>
    </section>
    <section className="settings-section"><h3>演示与兼容</h3><label className="checkbox-setting"><input type="checkbox" checked={snapshot.demo} onChange={event => { void store.action(store.api.setDemo(event.target.checked)); }} />显示合成演示数据（不联网，不执行任务）</label>
      <p className="muted small">真实部署兼容、认证、流量和缓存时延仍需在全部实现后统一验证。</p>
    </section>
    <section className="settings-section"><h3>许可与源码</h3><p className="muted small">DshDeck 按 AGPL-3.0-or-later 提供；内置宠物改编自 CLI-Manager/pet-e，原作者保留权利。本程序不提供担保，可按许可复制、修改和再分发；第三方宠物图片不随包提供。</p><button type="button" onClick={() => { void store.action(store.api.openLicenses()); }}>查看完整许可与对应源码</button></section>
    <footer className="dialog-actions"><button type="button" className="primary" onClick={close}>完成</button></footer>
  </dialog>;
}
