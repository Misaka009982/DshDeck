import type { ConnectionState, IpcResult, ProbeSampleInput, ServerSnapshot } from '../shared/contracts.js';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!(found instanceof HTMLElement)) throw new Error('本地界面结构不完整。');
  return found as T;
}
const api = window.dshDeck;
const list = element('server-list');
const dialog = element<HTMLDialogElement>('server-dialog');
const form = element<HTMLFormElement>('server-form');
const nameInput = element<HTMLInputElement>('server-name');
const urlInput = element<HTMLInputElement>('server-url');
const sessionSelect = element<HTMLSelectElement>('sample-session');
let servers: readonly ServerSnapshot[] = [];
let selectedId: string | null = null;
let editingId: string | null = null;
let samplingId: string | null = null;
let refreshing = false;
let savingServer = false;
let listKey = '';
let sessionKey = '';

const stateLabels: Record<ConnectionState, string> = {
  idle: '未连接', authenticating: '正在登录', probing: '验证协议', 'readonly-ready': '只读 PoC 就绪',
  'auth-required': '需要认证', denied: '访问被拒绝', incompatible: '协议不兼容', failed: '连接失败', cancelled: '已取消',
};
function selected(): ServerSnapshot | undefined { return servers.find(server => server.config.id === selectedId); }
function notice(message: string): void { const target = element('notice'); target.textContent = message; target.hidden = message === ''; }
function fail<T>(result: IpcResult<T>): boolean { if (result.ok) return false; notice(result.error.message); return true; }
function button(text: string, clicked: () => void): HTMLButtonElement {
  const control = document.createElement('button');
  control.type = 'button'; control.textContent = text; control.addEventListener('click', clicked);
  return control;
}

function render(): void {
  const key = JSON.stringify(servers.map(server => [server.config.id, server.config.alias, server.state, server.generation, server.authenticationOpen, server.failure?.kind, selectedId]));
  if (key !== listKey) {
    listKey = key;
    list.replaceChildren();
    for (const server of servers) {
      const row = document.createElement('div');
      row.className = `server-row${server.config.id === selectedId ? ' selected' : ''}`;
      row.setAttribute('role', 'listitem');
      const select = button('', () => { selectedId = server.config.id; notice(''); render(); });
      select.className = 'server-select';
      const name = document.createElement('span'); name.className = 'server-name'; name.textContent = server.config.alias;
      const state = document.createElement('span'); state.className = 'server-state'; state.textContent = server.authenticationOpen ? server.failure === null ? '等待网页登录' : '登录页加载失败' : stateLabels[server.state];
      select.append(name, state);
      const actions = document.createElement('div'); actions.className = 'server-row-actions';
      const connect = button('连接', () => { void connectServer(server.config.id); });
      connect.title = `连接 ${server.config.alias}；失效时打开内置浏览器`;
      const login = button('重登', () => {
        selectedId = server.config.id;
        void api.authenticateServer(server.config.id).then(result => {
          if (selectedId === server.config.id && !fail(result)) notice('已打开该服务器的独立认证窗口。');
          void refresh();
        });
      });
      login.title = '手动打开内置浏览器重新登录';
      actions.append(connect, login); row.append(select, actions); list.append(row);
    }
    if (servers.length === 0) { const hint = document.createElement('p'); hint.className = 'muted small'; hint.textContent = '尚未添加服务器'; list.append(hint); }
  }
  const server = selected();
  element('empty-state').hidden = server !== undefined;
  element('server-detail').hidden = server === undefined;
  element<HTMLButtonElement>('edit-server').disabled = server === undefined;
  element<HTMLButtonElement>('disconnect-server').disabled = server === undefined;
  element('server-title').textContent = server?.config.alias ?? '选择服务器';
  element('connection-state').textContent = server === undefined ? '' : server.authenticationOpen ? server.failure === null ? '等待网页登录' : '登录页加载失败' : stateLabels[server.state];
  if (server === undefined) return;
  element('server-address').textContent = server.config.baseUrl;
  element('protocol-hint').textContent = server.failure?.message
    ?? (server.state === 'readonly-ready' ? 'RPC 会话目录与 WS 工作区 baseline 已通过本轮读取；完整会话功能、流量和副作用仍待验证。' : '点击左侧“连接”复用登录态；失效时会弹出浏览器。需要手动重登时点击“重登”。');
  const directory = element('directory');
  directory.replaceChildren();
  if (server.workspaces.length === 0) {
    const hint = document.createElement('p'); hint.className = 'muted';
    hint.textContent = server.state === 'readonly-ready' ? '服务器返回的真实工作区目录为空。' : '尚未通过真实目录验证，不显示假工作区。';
    directory.append(hint);
  } else {
    for (const workspace of server.workspaces) {
      const item = document.createElement('div'); item.className = 'directory-item';
      const title = document.createElement('h3'); title.textContent = workspace.title;
      const detail = document.createElement('p'); detail.textContent = `${workspace.sessionIds.length} 个会话 · ${workspace.path}`;
      item.append(title, detail); directory.append(item);
    }
  }
  const nextSessionKey = JSON.stringify([server.config.id, server.generation, server.sessions.map(session => [session.sessionId, session.running])]);
  if (nextSessionKey !== sessionKey) {
    sessionKey = nextSessionKey;
    const previous = sessionSelect.value;
    sessionSelect.replaceChildren();
    for (const session of server.sessions) {
      const option = document.createElement('option'); option.value = session.sessionId;
      option.textContent = `${session.running ? '运行中' : '非运行'} · ${session.sessionId}`;
      sessionSelect.append(option);
    }
    if (server.sessions.some(session => session.sessionId === previous)) sessionSelect.value = previous;
    else sessionSelect.value = server.sessions.find(session => session.running)?.sessionId ?? server.sessions[0]?.sessionId ?? '';
  }
  element<HTMLButtonElement>('start-sample').disabled = server.state !== 'readonly-ready' || server.sessions.length === 0 || samplingId !== null;
  element<HTMLButtonElement>('stop-sample').disabled = samplingId !== server.config.id;
  element('sample-output').textContent = server.sample === null ? (samplingId === server.config.id ? '正在进行用户启动的受控采样…' : '尚未采样。') : JSON.stringify(server.sample, null, 2);
}

async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const result = await api.listServers();
    if (fail(result) || !result.ok) return;
    servers = result.value;
    if (selectedId !== null && !servers.some(server => server.config.id === selectedId)) selectedId = null;
    render();
  } finally { refreshing = false; }
}
async function connectServer(id: string): Promise<void> {
  selectedId = id; render(); notice('正在验证该服务器的 RPC 与 WS…');
  const result = await api.connectServer(id);
  if (selectedId === id && !fail(result) && result.ok) {
    notice(result.value.state === 'authenticating' ? '登录已失效，已打开内置浏览器；登录后点击“已登录，验证连接”。'
      : result.value.failure?.message ?? (result.value.state === 'readonly-ready' ? '只读协议 PoC 就绪。' : stateLabels[result.value.state]));
  }
  await refresh();
}
function openServerDialog(server?: ServerSnapshot): void {
  if (savingServer || dialog.open) return;
  editingId = server?.config.id ?? null;
  element('server-dialog-title').textContent = server === undefined ? '添加服务器' : '编辑服务器';
  nameInput.value = server?.config.alias ?? '';
  urlInput.value = server?.config.baseUrl ?? '';
  element('server-form-error').hidden = true;
  dialog.showModal();
  nameInput.focus();
}
element('add-server').addEventListener('click', () => openServerDialog());
element('edit-server').addEventListener('click', () => { const server = selected(); if (server !== undefined) openServerDialog(server); });
for (const id of ['close-server-dialog', 'cancel-server-dialog']) element(id).addEventListener('click', () => { if (!savingServer) dialog.close(); });
dialog.addEventListener('cancel', event => { if (savingServer) event.preventDefault(); });
form.addEventListener('submit', event => {
  event.preventDefault();
  if (savingServer) return;
  savingServer = true;
  void (async () => {
    const save = element<HTMLButtonElement>('save-server'); save.disabled = true;
    try {
      const input = { alias: nameInput.value.trim(), baseUrl: urlInput.value.trim() };
      const result = editingId === null ? await api.addServer(input) : await api.editServer(editingId, input);
      if (!result.ok) { const error = element('server-form-error'); error.textContent = result.error.message; error.hidden = false; return; }
      selectedId = result.value.config.id; dialog.close(); notice('服务器已保存，点击左侧“连接”开始认证和协议验证。');
      await refresh();
    } finally { savingServer = false; save.disabled = false; }
  })();
});
element('disconnect-server').addEventListener('click', () => {
  const server = selected(); if (server === undefined) return;
  void api.disconnectServer(server.config.id).then(result => {
    if (selectedId === server.config.id && !fail(result)) notice('已结束本地读取，远程任务未被停止。');
    void refresh();
  });
});
element<HTMLFormElement>('sample-form').addEventListener('submit', event => {
  event.preventDefault();
  const server = selected(); if (server === undefined || samplingId !== null) return;
  const input: ProbeSampleInput = {
    sessionId: sessionSelect.value,
    mode: element<HTMLSelectElement>('sample-mode').value === 'realtime' ? 'realtime' : 'periodic',
    stateStream: element<HTMLSelectElement>('sample-state-stream').value === 'control' ? 'control' : 'observe-state',
    durationSeconds: Number(element<HTMLInputElement>('sample-duration').value),
    intervalSeconds: Number(element<HTMLInputElement>('sample-interval').value),
  };
  samplingId = server.config.id; render();
  void api.runSample(server.config.id, input).then(result => {
    if (selectedId === server.config.id && selected()?.generation === server.generation && !fail(result)) notice('样本结束。只统计已解码载荷，不能替代线上总字节和副作用验收。');
  }).finally(() => { samplingId = null; void refresh(); });
});
element('stop-sample').addEventListener('click', () => {
  if (samplingId === null) return;
  void api.stopSample(samplingId).then(result => { if (!fail(result)) notice('已请求停止本地采样，不发送远程停止命令。'); });
});
// 这里只刷新本地 IPC 快照，不为后台服务器启动网络轮询。
void refresh();
setInterval(() => { void refresh(); }, 1000);
