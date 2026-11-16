import type { AuthPageState } from '../shared/contracts.js';

const api = window.dshDeckAuth;
const form = document.getElementById('auth-link-form') as HTMLFormElement;
const link = document.getElementById('auth-link') as HTMLInputElement;
const note = document.getElementById('auth-note') as HTMLElement;
const status = document.getElementById('auth-status') as HTMLElement;
const finish = document.getElementById('finish-auth') as HTMLButtonElement;
const open = form.querySelector('button') as HTMLButtonElement;
let baseUrl = '';
let disposed = false;
let refreshing = false;
let revision = -1;
let page: AuthPageState | null = null;
function showPage(value: AuthPageState): void {
  page = value;
  if (revision === value.revision) return;
  revision = value.revision;
  status.textContent = value.message;
  status.className = value.state === 'failed' ? 'auth-status is-error' : 'auth-status';
  finish.disabled = value.state !== 'ready';
  open.textContent = value.state === 'failed' ? '重试页面' : '打开链接';
}
function showFailure(message: string): void { status.textContent = message; status.className = 'auth-status is-error'; }
async function refresh(): Promise<void> {
  if (disposed || refreshing) return;
  refreshing = true;
  try {
    const result = await api.pageState();
    if (disposed) return;
    if (result.ok) showPage(result.value); else showFailure(result.error.message);
  } finally { refreshing = false; }
}
void api.describe().then(result => {
  if (disposed) return;
  if (!result.ok) { note.textContent = result.error.message; return; }
  baseUrl = result.value.baseUrl;
  (document.getElementById('auth-title') as HTMLElement).textContent = `浏览器登录 · ${result.value.alias}`;
});
void refresh();
const timer = window.setInterval(() => { void refresh(); }, 500);
window.addEventListener('pagehide', () => { disposed = true; window.clearInterval(timer); link.value = ''; }, { once: true });
form.addEventListener('submit', event => {
  event.preventDefault();
  if (open.disabled || disposed) return;
  const target = link.value.trim() || baseUrl;
  link.value = ''; open.disabled = true;
  void api.navigate(target).then(async result => {
    await refresh();
    if (!disposed && !result.ok && page?.state !== 'failed' && page?.state !== 'cancelled') showFailure(result.error.message);
  }).finally(() => { if (!disposed) open.disabled = false; });
});
finish.addEventListener('click', () => {
  link.value = ''; finish.disabled = true;
  void api.finish().then(result => { if (!disposed && !result.ok) { showFailure(result.error.message); finish.disabled = false; } });
});
(document.getElementById('cancel-auth') as HTMLButtonElement).addEventListener('click', () => { link.value = ''; void api.cancel(); });
export {};
