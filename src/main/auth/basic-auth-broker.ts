import { app } from 'electron';
import type { BrowserWindow, WebContents } from 'electron';
import { CredentialStore } from './credential-store.js';
import type { CredentialScope } from './credential-store.js';
import { promptCredential } from '../windows/credential-window.js';
import type { WindowAssets } from '../windows/window-assets.js';
import { IpcRegistry } from '../security/ipc-registry.js';

interface LoginBinding {
  readonly parent: BrowserWindow;
  readonly authProfileId: string;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly attempted: Set<string>;
}

/** 只响应已绑定认证页的实际挑战，不按 origin 猜测无 WebContents 请求的账户。 */
export class BasicAuthBroker {
  private readonly bindings = new Map<number, LoginBinding>();

  constructor(private readonly credentials: CredentialStore, assets: WindowAssets, ipc: IpcRegistry) {
    app.on('login', (event, contents, request, info, callback) => {
      event.preventDefault();
      const binding = contents === undefined || contents === null ? undefined : this.bindings.get(contents.id);
      if (binding === undefined || binding.parent.isDestroyed() || info.isProxy || info.scheme.toLowerCase() !== 'basic') { callback(); return; }
      let url: URL;
      try { url = new URL(request.url); } catch { callback(); return; }
      const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
      const host = (value: string): string => value.toLowerCase().replace(/^\[|\]$/gu, '');
      if (!binding.allowedOrigins.has(url.origin) || host(info.host) !== host(url.hostname) || info.port !== port) { callback(); return; }
      const scope: CredentialScope = {
        authProfileId: binding.authProfileId, origin: url.origin,
        host: url.hostname, port, realm: info.realm, scheme: 'basic',
      };
      const key = JSON.stringify([url.origin, info.realm, port]);
      // 挑战重复意味着本次自动/人工提交未获接受，停止自动尝试。
      if (binding.attempted.has(key)) { this.credentials.evict(scope); callback(); return; }
      binding.attempted.add(key);
      const cached = this.credentials.get(scope);
      if (cached !== undefined) { callback(cached.username, cached.password); return; }
      void promptCredential(binding.parent, { origin: url.origin, realm: info.realm },
        value => this.credentials.set(scope, value), assets, ipc).then(value => {
        if (value === undefined || contents === undefined || contents === null || contents.isDestroyed()
          || this.bindings.get(contents.id) !== binding) callback();
        else callback(value.username, value.password);
      }, () => callback());
    });
  }

  bind(contents: WebContents, parent: BrowserWindow, authProfileId: string, allowedOrigins: ReadonlySet<string>): void {
    this.bindings.set(contents.id, { parent, authProfileId, allowedOrigins, attempted: new Set() });
    const id = contents.id;
    contents.once('destroyed', () => this.bindings.delete(id));
  }

  /** 只有用户在认证工具栏明确重试才重置尝试；不做后台密码循环。 */
  reset(authProfileId: string): void {
    for (const binding of this.bindings.values()) if (binding.authProfileId === authProfileId) binding.attempted.clear();
  }
}
