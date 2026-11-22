// SPDX-License-Identifier: AGPL-3.0-or-later
// 移植自 CLI-Manager/pet-e/src/renderer/app.ts，2026-11-16 移除问答／审批和子进程协议，改用受限内置 bridge；见 NOTICE.txt 与 LICENSE。
import type { PetBridge, PetViewConfig, PetViewSnapshot, PetViewTask, NativePetAction, PetMouseRegion } from '../../shared/pet-view.js';
import type { TaskColor } from '../../shared/domain.js';
import { escapePetText, PetPanelHover, PET_COLOR_ORDER, PET_LABELS, petSpriteClass } from './pet-model.js';

declare global { interface Window { readonly dshDeckPet: PetBridge } }
const root = document.querySelector<HTMLElement>('#app');
if (root === null) throw new Error('pet_root_missing');
const app: HTMLElement = root;
let config: PetViewConfig | null = null;
let snapshot: PetViewSnapshot | null = null;
const panelHover = new PetPanelHover();
let panelTimer: number | undefined;
let panelTimerAt: number | null = null;
let notificationTimer: number | undefined;
let mouseRegion: PetMouseRegion = 'none';
let lastMousePosition: { x: number; y: number } | null = null;
let error = '';
let disposed = false;
interface DragGesture { readonly gestureId: string; readonly pointerId: number; frame: number | undefined; moveBusy: boolean; dirty: boolean }
let gesture: DragGesture | undefined;

type PendingAction = NativePetAction extends infer T ? T extends NativePetAction ? Omit<T, 'actionId' | 'snapshotRevision'> : never : never;
function send(action: PendingAction): void {
  if (snapshot === null || disposed) return;
  void window.dshDeckPet.action({ ...action, actionId: crypto.randomUUID(), snapshotRevision: snapshot.revision } as NativePetAction).then(reply => {
    if (disposed) return; error = reply.ok ? '' : reply.error.message; render();
  });
}
function mouseRegionAt(target: Element | null): PetMouseRegion {
  if (target?.closest('.lights, .pet-toolbar, .task-panel, .notification, .pet-error, .pet.missing')) return 'controls';
  return target?.closest('.pet-shell') ? 'body' : 'none';
}
function setMouseInteractive(value: PetMouseRegion): void {
  const region = config?.visible === true ? value : 'none';
  if (mouseRegion === region || disposed) return; mouseRegion = region;
  void window.dshDeckPet.setMouseInteractive(region);
}
function updatePanelTimer(): void {
  const closeAt = panelHover.closeAt;
  if (closeAt === panelTimerAt) return;
  window.clearTimeout(panelTimer); panelTimer = undefined; panelTimerAt = closeAt;
  if (closeAt === null || disposed) return;
  const timer: number = window.setTimeout(() => {
    if (panelTimer !== timer || disposed) return;
    panelTimer = undefined; panelTimerAt = null;
    if (panelHover.expire(performance.now())) render(); else updatePanelTimer();
  }, Math.max(0, closeAt - performance.now()));
  panelTimer = timer;
}
function updatePanelPointer(target: Element | null, canOpen = false): boolean {
  if (disposed || config === null || !config.visible || !config.settings.showTaskArea) { panelHover.close(); updatePanelTimer(); return false; }
  const raw = target?.closest<HTMLElement>('button.light[data-color]')?.dataset.color;
  const color = (PET_COLOR_ORDER as readonly string[]).includes(raw ?? '') ? raw as TaskColor : null;
  const available = color !== null && snapshot !== null && snapshot.counts[color] > 0 ? color : null;
  const changed = panelHover.pointer(available, Boolean(target?.closest('.task-panel')), canOpen && config.settings.openOnHover && gesture === undefined, performance.now());
  updatePanelTimer(); return changed;
}
function refreshMouseInteraction(): void {
  const target = lastMousePosition === null ? null : document.elementFromPoint(lastMousePosition.x, lastMousePosition.y);
  setMouseInteractive(gesture !== undefined ? 'body' : mouseRegionAt(target));
  // 快照重绘只保持或撤销现有期限，不生成新的悬停展开动作。
  updatePanelPointer(target);
}
function finishDrag(notify = true): void {
  const current = gesture; if (current === undefined) return;
  gesture = undefined;
  if (current.frame !== undefined) window.cancelAnimationFrame(current.frame);
  document.documentElement.classList.remove('pet-position-dragging');
  if (app.hasPointerCapture(current.pointerId)) app.releasePointerCapture(current.pointerId);
  if (notify) void window.dshDeckPet.drag({ gestureId: current.gestureId, phase: 'end' }).then(reply => {
    if (!reply.ok && !disposed && gesture === undefined) { error = reply.error.message; render(); }
  });
  refreshMouseInteraction();
}
function scheduleDragMove(current: DragGesture): void {
  if (disposed || gesture !== current || current.moveBusy || current.frame !== undefined || !current.dirty) return;
  current.frame = window.requestAnimationFrame(() => {
    current.frame = undefined;
    if (disposed || gesture !== current || !current.dirty) return;
    current.dirty = false; current.moveBusy = true;
    void window.dshDeckPet.drag({ gestureId: current.gestureId, phase: 'move' }).then(reply => {
      current.moveBusy = false;
      if (disposed || gesture !== current) return;
      if (!reply.ok || !reply.value) { if (!reply.ok) error = reply.error.message; finishDrag(false); render(); }
      else scheduleDragMove(current);
    });
  });
}
function petMarkup(value: PetViewConfig): string {
  const pet = value.pet;
  if (pet === null) return '<button class="pet missing" data-command="settings" type="button">请在主窗口选择宠物库</button>';
  return `<div class="pet" title="${escapePetText(pet.displayName)}"><div class="sprite-viewport"><img class="${petSpriteClass(value, snapshot?.mood ?? 'idle')}" src="${escapePetText(pet.spritePath)}" alt="${escapePetText(pet.displayName)}" draggable="false" /></div></div>`;
}
function lightsMarkup(value: PetViewConfig): string {
  if (snapshot === null || !value.settings.showTaskArea) return '';
  const expandedColor = panelHover.color;
  return `<div class="lights" role="toolbar" aria-label="关注会话状态">${PET_COLOR_ORDER.filter(color => snapshot !== null && snapshot.counts[color] > 0).map(color =>
    `<button type="button" class="light ${color}${expandedColor === color ? ' active' : ''}" data-color="${color}" title="${escapePetText(PET_LABELS[color])}"><span class="dot"></span><span class="count">${snapshot?.counts[color] ?? 0}</span></button>`).join('')}</div>`;
}
function taskMarkup(task: PetViewTask): string {
  return `<article class="task-row ${task.color}"><div class="task-copy"><strong>${escapePetText(task.agentLabel)}</strong><span>${escapePetText(task.title)}</span>${task.sessionAlive ? '' : '<small class="ended">状态更新后可跳回</small>'}</div><button type="button" data-command="open" data-task="${escapePetText(task.id)}"${task.sessionAlive ? '' : ' disabled'}>跳回</button></article>`;
}
function taskPanel(value: PetViewConfig): string {
  const expandedColor = panelHover.color;
  if (snapshot === null || expandedColor === null || !value.settings.showTaskArea) return '';
  const tasks = snapshot.tasks.filter(task => task.color === expandedColor);
  return `<section class="task-panel"><header><strong>${escapePetText(PET_LABELS[expandedColor])}</strong><button type="button" data-command="collapse" aria-label="收起任务">×</button></header><div class="task-list">${tasks.map(taskMarkup).join('') || '<p class="empty">暂无可显示的关注会话。</p>'}${snapshot.truncated ? '<p class="empty">宠物列表最多展示 256 项，其余请在主窗口查看；计数仍来自完整关注投影。</p>' : ''}</div></section>`;
}
function render(): void {
  if (config === null || disposed) { app.replaceChildren(); setMouseInteractive('none'); return; }
  const notice = snapshot?.notification;
  const notification = notice !== null && notice !== undefined && config.settings.notificationsEnabled && notice.expiresAt > Date.now()
    ? `<aside class="notification" role="status" aria-live="polite"><strong>${escapePetText(notice.title)}</strong><span>${escapePetText(notice.message)}</span></aside>` : '';
  const mood = snapshot?.mood ?? 'idle';
  const status = config.settings.showStatus ? `<div class="status-label ${mood}">${escapePetText(PET_LABELS[mood])}</div>` : '';
  const cli = config.settings.showCliLabel && snapshot?.cliLabel != null ? `<div class="cli-label ${snapshot.cliLabel.color}">${escapePetText(snapshot.cliLabel.agentLabel)}</div>` : '';
  app.innerHTML = `${notification}<div class="pet-shell${notification ? ' notification-active' : ''}">${petMarkup(config)}<div class="pet-toolbar"><button type="button" data-command="settings" title="宠物设置" aria-label="宠物设置">⚙</button><button type="button" data-command="close" title="关闭宠物" aria-label="关闭宠物">×</button></div>${lightsMarkup(config)}${status}${cli}</div>${taskPanel(config)}${error ? `<aside class="pet-error" role="status">${escapePetText(error)}</aside>` : ''}`;
  queueMicrotask(refreshMouseInteraction);
}
// 捕获放在稳定的 #app，不放在每份会话快照都会重建的精灵节点上。
app.addEventListener('pointerdown', event => {
  if (disposed || gesture !== undefined || config === null || !config.visible || config.settings.lockPosition || event.button !== 0 || !event.isPrimary) return;
  const target = event.target instanceof Element ? event.target.closest('.pet') : null;
  if (target === null || target.classList.contains('missing') || target.closest('button') !== null) return;
  event.preventDefault(); lastMousePosition = { x: event.clientX, y: event.clientY };
  const current: DragGesture = { gestureId: crypto.randomUUID(), pointerId: event.pointerId, frame: undefined, moveBusy: true, dirty: false };
  gesture = current; setMouseInteractive('body');
  try { app.setPointerCapture(event.pointerId); }
  catch { finishDrag(false); return; }
  document.documentElement.classList.add('pet-position-dragging');
  void window.dshDeckPet.drag({ gestureId: current.gestureId, phase: 'start' }).then(reply => {
    current.moveBusy = false;
    if (disposed || gesture !== current) return;
    if (!reply.ok || !reply.value) {
      error = reply.ok ? '宠物当前不可拖动，请检查锁定或显示状态。' : reply.error.message;
      finishDrag(false); render();
    } else scheduleDragMove(current);
  });
});
app.addEventListener('pointermove', event => {
  const current = gesture; if (current === undefined || current.pointerId !== event.pointerId) return;
  if (event.pointerType === 'mouse' && (event.buttons & 1) === 0) { finishDrag(); return; }
  lastMousePosition = { x: event.clientX, y: event.clientY }; current.dirty = true; scheduleDragMove(current);
});
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) app.addEventListener(name, event => {
  if (gesture?.pointerId === event.pointerId) finishDrag();
});
window.addEventListener('blur', () => finishDrag());
app.addEventListener('click', event => {
  const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
  if (target === null || target.disabled) return;
  const color = target.dataset.color;
  if ((PET_COLOR_ORDER as readonly string[]).includes(color ?? '')) { updatePanelPointer(target); panelHover.toggle(color as TaskColor, performance.now()); updatePanelTimer(); render(); return; }
  switch (target.dataset.command) {
    case 'collapse': panelHover.close(); break;
    case 'settings': send({ kind: 'open-settings' }); break;
    case 'close': send({ kind: 'close-pet' }); break;
    case 'open': if (target.dataset.task !== undefined) send({ kind: 'open-task', taskId: target.dataset.task }); break;
  }
  updatePanelTimer(); render();
});
app.addEventListener('pointerover', event => {
  if (gesture !== undefined || config === null || snapshot === null || !config.settings.openOnHover || !config.settings.showTaskArea || event.pointerType === 'touch') return;
  lastMousePosition = { x: event.clientX, y: event.clientY };
  const target = event.target instanceof Element ? event.target : null;
  if (updatePanelPointer(target, true)) render();
});
document.addEventListener('mousemove', event => {
  lastMousePosition = { x: event.clientX, y: event.clientY };
  const target = event.target instanceof Element ? event.target : null;
  setMouseInteractive(gesture !== undefined ? 'body' : mouseRegionAt(target));
  updatePanelPointer(target);
});
document.documentElement.addEventListener('mouseleave', () => { lastMousePosition = null; updatePanelPointer(null); if (gesture === undefined) setMouseInteractive('none'); });
function acceptConfig(value: PetViewConfig): void {
  config = value; document.documentElement.lang = value.language; document.documentElement.classList.toggle('theme-light', value.theme === 'light');
  document.documentElement.classList.toggle('pet-position-locked', value.settings.lockPosition);
  if (!value.visible || value.settings.lockPosition) finishDrag();
  if (!value.visible) setMouseInteractive('none');
  if (!value.visible || !value.settings.showTaskArea) panelHover.close();
  updatePanelTimer(); render();
}
function acceptSnapshot(value: PetViewSnapshot): void {
  if (snapshot !== null && snapshot.instanceId === value.instanceId && snapshot.generation === value.generation && snapshot.revision > value.revision) return;
  snapshot = value; error = '';
  const expandedColor = panelHover.color;
  if (expandedColor !== null && value.counts[expandedColor] === 0) panelHover.close();
  updatePanelTimer();
  window.clearTimeout(notificationTimer);
  if (value.notification !== null && value.notification.expiresAt > Date.now()) notificationTimer = window.setTimeout(render, Math.min(60000, value.notification.expiresAt - Date.now()));
  render();
}
const stopDrag = window.dshDeckPet.onDragEnded(gestureId => { if (gesture?.gestureId === gestureId) finishDrag(false); });
const stopConfig = window.dshDeckPet.onConfig(acceptConfig); const stopSnapshot = window.dshDeckPet.onSnapshot(acceptSnapshot);
window.addEventListener('beforeunload', () => { finishDrag(); disposed = true; stopDrag(); stopConfig(); stopSnapshot(); window.clearTimeout(notificationTimer); window.clearTimeout(panelTimer); panelHover.close(); panelTimer = undefined; panelTimerAt = null; }, { once: true });
void window.dshDeckPet.ready().then(reply => {
  if (disposed) return;
  if (reply.ok) { acceptConfig(reply.value.config); acceptSnapshot(reply.value.snapshot); }
  else { error = reply.error.message; render(); }
});
