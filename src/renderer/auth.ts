const api = window.dshDeckAuth;
const form = document.getElementById('auth-link-form') as HTMLFormElement;
const link = document.getElementById('auth-link') as HTMLInputElement;
const note = document.getElementById('auth-note') as HTMLElement;
let baseUrl = '';
void api.describe().then(result => {
  if (!result.ok) { note.textContent = result.error.message; return; }
  baseUrl = result.value.baseUrl;
  (document.getElementById('auth-title') as HTMLElement).textContent = `浏览器登录 · ${result.value.alias}`;
});
form.addEventListener('submit', event => {
  event.preventDefault();
  const target = link.value.trim() || baseUrl;
  link.value = '';
  void api.navigate(target).then(result => {
    note.textContent = result.ok ? '页面已加载；完成网页登录后点击“已登录，验证连接”。验证使用左侧保存的入口，临时链接不会替换它；原网页业务流仍禁用。' : result.error.message;
  });
});
(document.getElementById('finish-auth') as HTMLButtonElement).addEventListener('click', () => { link.value = ''; void api.finish(); });
(document.getElementById('cancel-auth') as HTMLButtonElement).addEventListener('click', () => { link.value = ''; void api.cancel(); });
export {};
