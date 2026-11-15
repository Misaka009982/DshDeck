const api = window.dshDeckCredential;
const form = document.getElementById('credential-form') as HTMLFormElement;
const username = document.getElementById('credential-username') as HTMLInputElement;
const password = document.getElementById('credential-password') as HTMLInputElement;
const remember = document.getElementById('credential-remember') as HTMLInputElement;
const error = document.getElementById('credential-error') as HTMLElement;
const submit = document.getElementById('submit-credential') as HTMLButtonElement;
void api.describe().then(result => {
  if (!result.ok) { error.textContent = result.error.message; error.hidden = false; return; }
  (document.getElementById('credential-origin') as HTMLElement).textContent = `${result.value.origin} · ${result.value.realm}`;
  username.value = result.value.username ?? '';
  username.readOnly = result.value.usernameLocked === true;
  if (result.value.saveOnly) { password.required = true; password.placeholder = '输入新密码；不会回显已保存密码'; }
  remember.disabled = !result.value.rememberAvailable;
  remember.checked = result.value.remembered === true && !remember.disabled;
  if (result.value.saveOnly) submit.textContent = '保存';
  if (remember.disabled) (document.getElementById('credential-storage-note') as HTMLElement).textContent = '系统安全存储不可用：仅用于本次认证，不会以明文保存。';
});
form.addEventListener('submit', event => {
  event.preventDefault();
  submit.disabled = true;
  const input = { username: username.value, password: password.value, remember: remember.checked && !remember.disabled };
  password.value = '';
  void api.submit(input).then(result => {
    if (!result.ok) { error.textContent = result.error.message; error.hidden = false; submit.disabled = false; }
  });
});
(document.getElementById('cancel-credential') as HTMLButtonElement).addEventListener('click', () => { password.value = ''; void api.cancel(); });
export {};
