const api = window.dshDeckCredential;
const form = document.getElementById('credential-form') as HTMLFormElement;
const username = document.getElementById('credential-username') as HTMLInputElement;
const password = document.getElementById('credential-password') as HTMLInputElement;
const error = document.getElementById('credential-error') as HTMLElement;
const submit = document.getElementById('submit-credential') as HTMLButtonElement;
void api.describe().then(result => {
  if (!result.ok) { error.textContent = result.error.message; error.hidden = false; return; }
  (document.getElementById('credential-origin') as HTMLElement).textContent = `${result.value.origin} · ${result.value.realm}`;
});
form.addEventListener('submit', event => {
  event.preventDefault();
  submit.disabled = true;
  const input = { username: username.value, password: password.value };
  password.value = '';
  void api.submit(input).then(result => {
    if (!result.ok) { error.textContent = result.error.message; error.hidden = false; submit.disabled = false; }
  });
});
(document.getElementById('cancel-credential') as HTMLButtonElement).addEventListener('click', () => { password.value = ''; void api.cancel(); });
export {};
