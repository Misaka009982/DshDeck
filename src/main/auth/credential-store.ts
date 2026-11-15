import { ProtocolFault } from '../../shared/faults.js';
import type { CredentialInput } from '../../shared/contracts.js';

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

/** 首版只在 main 内存保留 BasicAuth，不保存密码、Token 或 Cookie JSON。 */
export class CredentialStore {
  private readonly entries = new Map<string, StoredCredential>();

  set(scope: CredentialScope, value: CredentialInput): void {
    if (value.username.length === 0 || value.username.length > 256 || value.password.length > 4096
      || /[:\r\n]/u.test(value.username) || /[\r\n]/u.test(value.password)) throw new ProtocolFault('protocol');
    const origin = new URL(scope.origin);
    const port = Number(origin.port || (origin.protocol === 'https:' ? 443 : 80));
    if (scope.scheme !== 'basic' || origin.hostname !== scope.host || port !== scope.port) throw new ProtocolFault('protocol');
    const key = this.key(scope.authProfileId, scope.origin);
    const previous = this.entries.get(key);
    if (previous !== undefined && (previous.scope.realm !== scope.realm || previous.value.username !== value.username)) {
      throw new ProtocolFault('conflict');
    }
    this.entries.set(key, { scope: { ...scope }, value: { username: value.username, password: value.password } });
  }

  get(scope: CredentialScope): CredentialInput | undefined {
    const stored = this.entries.get(this.key(scope.authProfileId, scope.origin));
    if (stored === undefined || stored.scope.host !== scope.host || stored.scope.port !== scope.port
      || stored.scope.realm !== scope.realm || stored.scope.scheme !== scope.scheme) return undefined;
    return { ...stored.value };
  }

  authorizationFor(authProfileId: string, target: string): string | undefined {
    const url = new URL(target);
    const stored = this.entries.get(this.key(authProfileId, url.origin));
    if (stored === undefined) return undefined;
    return `Basic ${Buffer.from(`${stored.value.username}:${stored.value.password}`, 'utf8').toString('base64')}`;
  }

  evict(scope: CredentialScope): void {
    if (this.get(scope) !== undefined) this.entries.delete(this.key(scope.authProfileId, scope.origin));
  }

  clear(authProfileId: string): void {
    for (const [key, entry] of this.entries) if (entry.scope.authProfileId === authProfileId) this.entries.delete(key);
  }

  private key(authProfileId: string, origin: string): string {
    return JSON.stringify([authProfileId, origin]);
  }
}
