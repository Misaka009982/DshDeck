import { ProtocolFault, requireId } from '../../shared/faults.js';
import type { BasicCredentialInfo, CredentialInput } from '../../shared/contracts.js';
import type { CredentialVault } from './credential-vault.js';

export interface CredentialScope {
  readonly authProfileId: string;
  readonly origin: string;
  readonly host: string;
  readonly port: number;
  readonly realm: string;
  readonly scheme: 'basic';
}
interface StoredCredential {
  readonly scope: CredentialScope;
  readonly value: CredentialInput;
}

/** 密码只在 main 内存和系统加密层使用；不合并不同账户或认证范围。 */
export class CredentialStore {
  private readonly entries = new Map<string, StoredCredential>();
  private readonly targets = new Map<string, CredentialScope>();
  constructor(private readonly vault?: CredentialVault) {}

  set(scope: CredentialScope, value: CredentialInput): void {
    validateCredential(scope, value);
    const key = this.key(scope.authProfileId, scope.origin);
    const previous = this.entries.get(key);
    if (previous !== undefined && (previous.scope.realm !== scope.realm || previous.value.username !== value.username)) {
      throw new ProtocolFault('conflict');
    }
    this.entries.set(key, { scope: { ...scope }, value: { username: value.username, password: value.password } });
  }

  get(scope: CredentialScope): CredentialInput | undefined {
    const stored = this.entries.get(this.key(scope.authProfileId, scope.origin));
    if (stored === undefined) return this.vault?.get(scope);
    if (stored.scope.host !== scope.host || stored.scope.port !== scope.port || stored.scope.realm !== scope.realm || stored.scope.scheme !== scope.scheme) return undefined;
    return { ...stored.value };
  }

  authorizeTarget(scope: CredentialScope, target: string): void {
    const url = new URL(target);
    if (url.origin !== scope.origin || url.username !== '' || url.password !== '' || this.get(scope) === undefined) throw new ProtocolFault('forbidden');
    const key = JSON.stringify([scope.authProfileId, url.origin, url.pathname]);
    if (this.targets.size >= 2048 && !this.targets.has(key)) throw new ProtocolFault('budget');
    this.targets.set(key, { ...scope });
  }
  authorizationFor(authProfileId: string, target: string): string | undefined {
    const url = new URL(target);
    const known = this.targets.get(JSON.stringify([authProfileId, url.origin, url.pathname]));
    const stored = this.entries.get(this.key(authProfileId, url.origin));
    // 路径必须有真实挑战记录，不把根页面的 Realm 推断为所有业务端点的 Realm。
    if (known === undefined || stored === undefined || known.realm !== stored.scope.realm) return undefined;
    const value = stored.value;
    return `Basic ${Buffer.from(`${value.username}:${value.password}`, 'utf8').toString('base64')}`;
  }

  info(authProfileId: string, origin: string): BasicCredentialInfo {
    const info = this.vault?.info(authProfileId, origin) ?? { rememberAvailable: false, remembered: false, username: null, rejected: false, storageFailed: false };
    return { ...info, username: info.username ?? this.entries.get(this.key(authProfileId, origin))?.value.username ?? null };
  }
  knownScope(authProfileId: string, origin: string): CredentialScope | undefined {
    const scope = this.entries.get(this.key(authProfileId, origin))?.scope ?? this.vault?.scopeFor(authProfileId, origin);
    return scope === undefined ? undefined : { ...scope };
  }
  async remember(scope: CredentialScope, value: CredentialInput, remember: boolean): Promise<void> {
    validateCredential(scope, value);
    const previous = this.info(scope.authProfileId, scope.origin).username;
    if (previous !== null && previous !== value.username) throw new ProtocolFault('conflict');
    if (remember) { if (this.vault === undefined) throw new ProtocolFault('unsupported'); await this.vault.save(scope, value); }
    else await this.vault?.forget(scope.authProfileId, scope.origin);
    // 这是用户明确提交的更新，不把另一个账户的旧头拼接进来。
    this.entries.delete(this.key(scope.authProfileId, scope.origin)); this.set(scope, value);
  }
  rejectFor(authProfileId: string, target: string, submitted?: string): void {
    if (submitted !== undefined && submitted !== this.authorizationFor(authProfileId, target)) return;
    const scope = this.knownScope(authProfileId, new URL(target).origin); if (scope !== undefined) this.evict(scope);
  }
  async forget(authProfileId: string): Promise<void> { this.clear(authProfileId); await this.vault?.forget(authProfileId); }
  keepProfiles(profiles: ReadonlySet<string>): Promise<void> { return this.vault?.keepProfiles(profiles) ?? Promise.resolve(); }
  flush(): Promise<void> { return this.vault?.flush() ?? Promise.resolve(); }

  evict(scope: CredentialScope): void {
    if (this.get(scope) !== undefined) this.entries.delete(this.key(scope.authProfileId, scope.origin));
    for (const [key, target] of this.targets) if (target.authProfileId === scope.authProfileId && target.origin === scope.origin && target.realm === scope.realm) this.targets.delete(key);
    this.vault?.reject(scope);
  }

  clear(authProfileId: string): void {
    for (const [key, entry] of this.entries) if (entry.scope.authProfileId === authProfileId) this.entries.delete(key);
    for (const [key, scope] of this.targets) if (scope.authProfileId === authProfileId) this.targets.delete(key);
  }

  private key(authProfileId: string, origin: string): string {
    return JSON.stringify([authProfileId, origin]);
  }
}
function validateCredential(scope: CredentialScope, value: CredentialInput): void {
  requireId(scope.authProfileId);
  if (value.username.length === 0 || value.username.length > 256 || value.password.length > 4096 || /[:\r\n]/u.test(value.username) || /[\r\n]/u.test(value.password)
    || scope.realm.length > 1024 || /[\r\n]/u.test(scope.realm)) throw new ProtocolFault('protocol');
  const origin = new URL(scope.origin); const port = Number(origin.port || (origin.protocol === 'https:' ? 443 : 80));
  if (!['http:', 'https:'].includes(origin.protocol) || scope.origin !== origin.origin || scope.scheme !== 'basic' || origin.hostname !== scope.host || port !== scope.port) throw new ProtocolFault('protocol');
}
