import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ServerRow } from '../../shared/domain.js';
import type { WorkbenchClientStore } from '../state/workbench-store.js';

interface Props { readonly store: WorkbenchClientStore; readonly editing: ServerRow | null; readonly open: boolean; readonly close: () => void }
export function ServerSettings({ store, editing, open, close }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [alias, setAlias] = useState(''); const [url, setUrl] = useState('');
  const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) { setAlias(editing?.config.alias ?? ''); setUrl(editing?.config.baseUrl ?? ''); setError(''); if (!dialog.current?.open) dialog.current?.showModal(); }
    else dialog.current?.close();
  }, [open, editing]);
  const submit = (event: FormEvent): void => {
    event.preventDefault(); if (saving) return;
    setSaving(true); setError('');
    const input = { alias: alias.trim(), baseUrl: url.trim() };
    const request = editing === null ? store.api.addServer(input) : store.api.editServer(editing.config.id, input);
    void request.then(result => { if (result.ok) { close(); void store.refresh(); } else setError(result.error.message); }).finally(() => setSaving(false));
  };
  return <dialog ref={dialog} className="server-dialog" onCancel={event => { event.preventDefault(); if (!saving) close(); }}>
    <form onSubmit={submit} autoComplete="off">
      <header className="dialog-header"><h2>{editing === null ? '添加服务器' : '编辑服务器'}</h2><button type="button" className="icon-button" onClick={close} disabled={saving} aria-label="关闭">×</button></header>
      <label>服务器名<input value={alias} onChange={event => setAlias(event.target.value)} placeholder="例如：开发服务器" maxLength={64} required autoFocus /></label>
      <label>服务器链接<input type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://server.example/dsh/" maxLength={2048} required /></label>
      <p className="muted small">保存配置与连接分开。只保存干净入口；需要 Token 时，在独立认证窗口临时打开官方启动链接。</p>
      <p className="muted small">HTTP 不加密；HTTPS 证书错误不会被跳过。不同账户使用独立条目。</p>
      {error !== '' && <p className="form-error" role="alert">{error}</p>}
      <footer className="dialog-actions"><button type="button" onClick={close} disabled={saving}>取消</button><button type="submit" className="primary" disabled={saving}>{saving ? '保存中…' : '保存'}</button></footer>
    </form>
  </dialog>;
}
