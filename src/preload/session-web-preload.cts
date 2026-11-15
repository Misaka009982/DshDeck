import { ipcRenderer } from 'electron';

/** 只有隔离世界的固定导航观察器；不暴露 bridge，不读取 Cookie、正文或其他存储键。 */
interface PageTarget { readonly origin: string; readonly path: string; readonly target: { readonly sessionId: string; readonly subagentAddress?: { parentSessionId: string; childSessionId: string; mode: string } } | null }
let target: PageTarget | undefined;
try {
  const argument = process.argv.find(value => value.startsWith('--dshdeck-web-target='));
  if (argument !== undefined && argument.length <= 8192) {
    const value: unknown = JSON.parse(decodeURIComponent(argument.slice('--dshdeck-web-target='.length)));
    if (value !== null && typeof value === 'object') {
      const data = value as Record<string, unknown>;
      if (typeof data.origin === 'string' && typeof data.path === 'string' && (data.target === null || typeof data.target === 'object')) target = data as unknown as PageTarget;
    }
  }
} catch { /* 参数不是可验证目标时不改动存储。 */ }
function allowed(): boolean { return process.isMainFrame === true && target !== undefined && location.origin === target.origin && location.pathname.startsWith(target.path); }
if (allowed() && target?.target !== null && target?.target !== undefined) {
  try { localStorage.setItem('dsh.sessions.current', JSON.stringify(target.target)); } catch { /* 存储不可用由就绪检查降级。 */ }
}
let observedFrame: HTMLElement | null = null;
let observer: MutationObserver | undefined;
let last = '';
function compactFrame(): boolean {
  const right = document.querySelector<HTMLElement>('[data-rightbar-col]');
  const frame = right?.parentElement; const center = right?.previousElementSibling; const sidebar = center?.previousElementSibling;
  if (frame === null || frame === undefined || !(center instanceof HTMLElement) || !(sidebar instanceof HTMLElement)
    || !frame.querySelector(':scope > [data-shell-overlay]') || !frame.querySelector(':scope > [data-shell-bottom]')) return false;
  if (!frame.hasAttribute('data-dshdeck-frame')) frame.setAttribute('data-dshdeck-frame', '');
  if (!sidebar.hasAttribute('data-dshdeck-sidebar')) sidebar.setAttribute('data-dshdeck-sidebar', '');
  if (!center.hasAttribute('data-dshdeck-center')) center.setAttribute('data-dshdeck-center', '');
  const tracks: string[] = []; let depth = 0; let start = 0; const template = frame.style.gridTemplateColumns;
  for (let index = 0; index <= template.length; index++) {
    const character = template[index]; if (character === '(') depth++; else if (character === ')') depth--;
    if ((character === ' ' && depth === 0) || index === template.length) { const track = template.slice(start, index).trim(); if (track !== '') tracks.push(track); start = index + 1; }
  }
  if (tracks.length === 3 && (tracks[2]?.length ?? 0) < 128 && frame.style.getPropertyValue('--dshdeck-right-track') !== tracks[2]) frame.style.setProperty('--dshdeck-right-track', tracks[2] ?? '0px');
  if (!document.body?.hasAttribute('data-dshdeck-show-sidebar') && frame.hasAttribute('data-sidebar-drawer') && !frame.hasAttribute('data-sidebar-collapsed') && center.hasAttribute('inert')) center.removeAttribute('inert');
  if (observedFrame !== frame) {
    observer?.disconnect(); observedFrame = frame; observer = new MutationObserver(() => { compactFrame(); });
    observer.observe(frame, { attributes: true, attributeFilter: ['style', 'data-sidebar-collapsed', 'data-sidebar-drawer'] });
  }
  return true;
}
function report(): void {
  if (!allowed()) return;
  let sessionId: string | null = null;
  try {
    const raw = localStorage.getItem('dsh.sessions.current');
    if (raw !== null && raw.length <= 8192) {
      const value = JSON.parse(raw) as { sessionId?: unknown };
      if (typeof value?.sessionId === 'string' && value.sessionId.length <= 256) sessionId = value.sessionId;
    }
  } catch { /* 不回传原始导航值。 */ }
  const frameReady = compactFrame();
  const phase = document.querySelector<HTMLElement>('[data-phase]')?.dataset.phase;
  const input = document.querySelector<HTMLElement>('[data-composer-input]');
  const mounted = phase === 'active' || phase === 'hero' && input?.isContentEditable === true;
  const state = { sessionId, ready: frameReady && mounted && document.readyState === 'complete', dark: document.body?.hasAttribute('data-ds-dark-theme') ?? false };
  const serialized = JSON.stringify(state);
  if (serialized !== last) { last = serialized; ipcRenderer.send('session-web:state', state); }
}
if (process.isMainFrame) {
  const timer = setInterval(report, 500);
  window.addEventListener('DOMContentLoaded', report, { once: true });
  window.addEventListener('unload', () => { clearInterval(timer); observer?.disconnect(); }, { once: true });
}
