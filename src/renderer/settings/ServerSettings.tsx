import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { BasicCredentialInfo } from '../../shared/contracts.js';
import type { ServerRow } from '../../shared/domain.js';
import type { WorkbenchClientStore } from '../state/workbench-store.js';

interface Props { readonly store: WorkbenchClientStore; readonly editing: ServerRow | null; readonly open: boolean; readonly close: () => void }
export function ServerSettings({ store, editing, open, close }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [alias, setAlias] = useState(''); const [url, setUrl] = useState('');
  const [proxyMode, setProxyMode] = useState<'system' | 'direct'>('system');
  const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  const [credential, setCredential] = useState<{ id: string; info: BasicCredentialInfo } | null>(null);
  const [credentialBusy, setCredentialBusy] = useState(false);
  const credentialInfo = credential?.id === editing?.config.id ? credential?.info : undefined;
  useEffect(() => {
    setCredential(null);
    if (!open || editing === null) return;
    let current = true;
    void store.api.basicCredentialInfo(editing.config.id).then(result => {
      if (current && result.ok) setCredential({ id: editing.config.id, info: result.value });
    });
    return () => { current = false; };
  }, [open, editing?.config.id, store]);
  const changeCredential = (forget: boolean): void => {
    if (editing === null || credentialBusy) return;
    const id = editing.config.id; setCredentialBusy(true); setError('');
    void (forget ? store.api.forgetBasicCredentials(id) : store.api.editBasicCredentials(id)).then(async result => {
      if (!result.ok) { setError(result.error.message); return; }
      const info = await store.api.basicCredentialInfo(id);
      if (info.ok) setCredential({ id, info: info.value });
    }).finally(() => setCredentialBusy(false));
  };
  useEffect(() => {
    if (open) { setAlias(editing?.config.alias ?? ''); setUrl(editing?.config.baseUrl ?? ''); setProxyMode(editing?.config.proxyMode ?? 'system'); setError(''); if (!dialog.current?.open) dialog.current?.showModal(); }
    else dialog.current?.close();
  }, [open, editing]);
  const submit = (event: FormEvent): void => {
    event.preventDefault(); if (saving) return;
    setSaving(true); setError('');
    const input = { alias: alias.trim(), baseUrl: url.trim(), proxyMode };
    const request = editing === null ? store.api.addServer(input) : store.api.editServer(editing.config.id, input);
    void request.then(result => { if (result.ok) { close(); void store.refresh(); } else setError(result.error.message); }).finally(() => setSaving(false));
  };
  return <dialog ref={dialog} className="server-dialog" onCancel={event => { event.preventDefault(); if (!saving) close(); }}>
    <form onSubmit={submit} autoComplete="off">
      <header className="dialog-header"><h2>{editing === null ? '添加服务器' : '编辑服务器'}</h2><button type="button" className="icon-button" onClick={close} disabled={saving} aria-label="关闭">×</button></header>
      <label>服务器名<input value={alias} onChange={event => setAlias(event.target.value)} placeholder="例如：开发服务器" maxLength={64} required autoFocus /></label>
      <label>服务器链接<input type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://server.example/dsh/" maxLength={2048} required /></label>
      <p className="muted small">保存配置与连接分开。只保存干净入口；需要 Token 时，在独立认证窗口临时打开官方启动链接。</p>
      <label>连接路线<select value={proxyMode} onChange={event => setProxyMode(event.target.value as 'system' | 'direct')}><option value="system">使用系统代理策略</option><option value="direct">直接连接（不使用 HTTP 系统代理）</option></select></label>
      <p className="muted small">Tailnet 地址可能不在系统代理绕过列表；只有明确选择直连才改变路线。端口原样保留，切换路线后需重新连接，Cookie 不删除。</p>
      <p className="muted small">HTTP 不加密；HTTPS 证书错误不会被跳过。不同账户使用独立条目。</p>
      {editing !== null && <fieldset className="credential-setting"><legend>HTTP 账号密码</legend>
        <p className="muted small">{credentialInfo === undefined ? '读取保存状态…' : credentialInfo.remembered ? `已系统加密保存${credentialInfo.username === null ? '' : ` · ${credentialInfo.username}`}${credentialInfo.rejected ? ' · 认证被拒绝，已停止自动尝试' : ''}` : '尚未保存；连接时在 HTTP 认证弹窗勾选“记住”。网页登录表单仍使用 Cookie。'}</p>
        {credentialInfo?.storageFailed && <p className="muted small" role="status">安全存储读取或写入失败；不会降级明文保存，不影响已有 Cookie。</p>}
        <div className="dialog-actions"><button type="button" disabled={credentialBusy || !credentialInfo?.remembered || credentialInfo.username === null || url !== editing.config.baseUrl} onClick={() => changeCredential(false)}>更新密码</button><button type="button" disabled={credentialBusy || !credentialInfo?.remembered} onClick={() => changeCredential(true)}>忘记账号密码</button></div>
        <p className="muted small">更换账号请新增独立服务器条目；修改入口后不迁移旧密码。这里不会回显已保存密码。</p>
      </fieldset>}
      {error !== '' && <p className="form-error" role="alert">{error}</p>}
      <footer className="dialog-actions"><button type="button" onClick={close} disabled={saving}>取消</button><button type="submit" className="primary" disabled={saving}>{saving ? '保存中…' : '保存'}</button></footer>
    </form>
  </dialog>;
}
