// SPDX-License-Identifier: AGPL-3.0-or-later
// 移植自 CLI-Manager/pet-e/src/renderer/app.ts，2026-11-16 移除问答／审批和子进程协议，改用受限内置 bridge；见 NOTICE.txt 与 LICENSE。
import type { PetBridge, PetViewConfig, PetViewSnapshot, PetViewTask, NativePetAction } from '../../shared/pet-view.js';
import type { TaskColor } from '../../shared/domain.js';
import { escapePetText, firstPetColor, PET_COLOR_ORDER, PET_LABELS, petSpriteClass } from './pet-model.js';

declare global { interface Window { readonly dshDeckPet: PetBridge } }
const root = document.querySelector<HTMLElement>('#app');
if (root === null) throw new Error('pet_root_missing');
const app: HTMLElement = root;
let config: PetViewConfig | null = null;
let snapshot: PetViewSnapshot | null = null;
let expandedColor: TaskColor | null = null;
let notificationTimer: number | undefined;
let mouseInteractive = false;
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
function setMouseInteractive(value: boolean): void {
  const interactive = value && config?.visible === true;
  if (mouseInteractive === interactive || disposed) return; mouseInteractive = interactive;
  void window.dshDeckPet.setMouseInteractive(interactive);
}
function refreshMouseInteraction(): void {
  if (gesture !== undefined) { setMouseInteractive(true); return; }
  if (lastMousePosition === null) { setMouseInteractive(false); return; }
  const target = document.elementFromPoint(lastMousePosition.x, lastMousePosition.y);
  setMouseInteractive(Boolean(target?.closest('.pet-shell, .task-panel, .notification, .pet-error')));
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
  return `<div class="lights" role="toolbar" aria-label="关注会话状态">${PET_COLOR_ORDER.filter(color => snapshot !== null && snapshot.counts[color] > 0).map(color =>
    `<button type="button" class="light ${color}${expandedColor === color ? ' active' : ''}" data-color="${color}" title="${escapePetText(PET_LABELS[color])}"><span class="dot"></span><span class="count">${snapshot?.counts[color] ?? 0}</span></button>`).join('')}</div>`;
}
function taskMarkup(task: PetViewTask): string {
  return `<article class="task-row ${task.color}"><div class="task-copy"><strong>${escapePetText(task.agentLabel)}</strong><span>${escapePetText(task.title)}</span>${task.sessionAlive ? '' : '<small class="ended">状态更新后可跳回</small>'}</div><button type="button" data-command="open" data-task="${escapePetText(task.id)}"${task.sessionAlive ? '' : ' disabled'}>跳回</button></article>`;
}
function taskPanel(value: PetViewConfig): string {
  if (snapshot === null || expandedColor === null || !value.settings.showTaskArea) return '';
  const tasks = snapshot.tasks.filter(task => task.color === expandedColor);
  return `<section class="task-panel"><header><strong>${escapePetText(PET_LABELS[expandedColor])}</strong><button type="button" data-command="collapse" aria-label="收起任务">×</button></header><div class="task-list">${tasks.map(taskMarkup).join('') || '<p class="empty">暂无可显示的关注会话。</p>'}${snapshot.truncated ? '<p class="empty">宠物列表最多展示 256 项，其余请在主窗口查看；计数仍来自完整关注投影。</p>' : ''}</div></section>`;
}
function render(): void {
  if (config === null || disposed) { app.replaceChildren(); setMouseInteractive(false); return; }
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
  gesture = current; setMouseInteractive(true);
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
  if ((PET_COLOR_ORDER as readonly string[]).includes(color ?? '')) { expandedColor = expandedColor === color ? null : color as TaskColor; render(); return; }
  switch (target.dataset.command) {
    case 'collapse': expandedColor = null; break;
    case 'settings': send({ kind: 'open-settings' }); break;
    case 'close': send({ kind: 'close-pet' }); break;
    case 'open': if (target.dataset.task !== undefined) send({ kind: 'open-task', taskId: target.dataset.task }); break;
  }
  render();
});
app.addEventListener('pointerover', event => {
  if (gesture !== undefined || config === null || snapshot === null || !config.settings.openOnHover || !config.settings.showTaskArea || event.pointerType === 'touch') return;
  const target = event.target instanceof Element ? event.target : null;
  const color = target?.closest<HTMLElement>('[data-color]')?.dataset.color;
  const next = (PET_COLOR_ORDER as readonly string[]).includes(color ?? '') ? color as TaskColor : target?.closest('.pet-shell') ? firstPetColor(snapshot) : null;
  if (next !== null && next !== expandedColor && snapshot.counts[next] > 0) { expandedColor = next; render(); }
});
document.addEventListener('mousemove', event => {
  lastMousePosition = { x: event.clientX, y: event.clientY };
  const target = event.target instanceof Element ? event.target : null;
  setMouseInteractive(gesture !== undefined || Boolean(target?.closest('.pet-shell, .task-panel, .notification, .pet-error')));
});
document.documentElement.addEventListener('mouseleave', () => { lastMousePosition = null; if (gesture === undefined) setMouseInteractive(false); });
function acceptConfig(value: PetViewConfig): void {
  config = value; document.documentElement.lang = value.language; document.documentElement.classList.toggle('theme-light', value.theme === 'light');
  document.documentElement.classList.toggle('pet-position-locked', value.settings.lockPosition);
  if (!value.visible || value.settings.lockPosition) finishDrag();
  if (!value.visible) setMouseInteractive(false);
  if (!value.settings.showTaskArea) expandedColor = null;
  render();
}
function acceptSnapshot(value: PetViewSnapshot): void {
  if (snapshot !== null && snapshot.instanceId === value.instanceId && snapshot.generation === value.generation && snapshot.revision > value.revision) return;
  snapshot = value; error = '';
  if (expandedColor !== null && value.counts[expandedColor] === 0) expandedColor = null;
  window.clearTimeout(notificationTimer);
  if (value.notification !== null && value.notification.expiresAt > Date.now()) notificationTimer = window.setTimeout(render, Math.min(60000, value.notification.expiresAt - Date.now()));
  render();
}
const stopDrag = window.dshDeckPet.onDragEnded(gestureId => { if (gesture?.gestureId === gestureId) finishDrag(false); });
const stopConfig = window.dshDeckPet.onConfig(acceptConfig); const stopSnapshot = window.dshDeckPet.onSnapshot(acceptSnapshot);
window.addEventListener('beforeunload', () => { finishDrag(); disposed = true; stopDrag(); stopConfig(); stopSnapshot(); window.clearTimeout(notificationTimer); }, { once: true });
void window.dshDeckPet.ready().then(reply => {
  if (disposed) return;
  if (reply.ok) { acceptConfig(reply.value.config); acceptSnapshot(reply.value.snapshot); }
  else { error = reply.error.message; render(); }
});
