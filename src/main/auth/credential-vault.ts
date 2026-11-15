import type { BasicCredentialInfo, CredentialInput } from '../../shared/contracts.js';
import { ProtocolFault, requireId, requireKeys, requireRecord } from '../../shared/faults.js';
import type { CredentialScope } from './credential-store.js';
import { readJson, writeJson } from '../storage/json-file.js';

export interface CredentialCipher {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
interface SavedCredential { readonly scope: CredentialScope; readonly value: CredentialInput; readonly rejected: boolean }
const MAX_BYTES = 1024 * 1024;

/** 仅持久化真实 BasicAuth 挑战的完整 scope；账号密码一并交给系统加密，不做明文兜底。 */
export class CredentialVault {
  private encrypted = new Map<string, string>();
  private readonly records = new Map<string, SavedCredential>();
  private writing: Promise<void> = Promise.resolve();
  private healthy = true;
  private storageFailed = false;
  constructor(private readonly path: string, private readonly cipher: CredentialCipher) {}

  async load(): Promise<void> {
    try {
      const value = await readJson(this.path, MAX_BYTES); if (value === undefined) return;
      const data = requireRecord(value); requireKeys(data, ['version', 'entries']);
      if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > 128) throw new ProtocolFault('protocol');
      const encrypted = new Map<string, string>();
      for (const value of data.entries) {
        const entry = requireRecord(value); requireKeys(entry, ['key', 'encrypted']);
        if (typeof entry.key !== 'string' || entry.key.length > 2300 || typeof entry.encrypted !== 'string' || entry.encrypted.length > 65536
          || !/^[A-Za-z0-9+/]+={0,2}$/u.test(entry.encrypted) || encrypted.has(entry.key)) throw new ProtocolFault('protocol');
        const identity: unknown = JSON.parse(entry.key);
        if (!Array.isArray(identity) || identity.length !== 2 || typeof identity[1] !== 'string') throw new ProtocolFault('protocol');
        requireId(identity[0]); cleanOrigin(identity[1]);
        encrypted.set(entry.key, entry.encrypted);
        if (!this.cipher.isEncryptionAvailable()) continue;
        try {
          const plain = this.cipher.decryptString(Buffer.from(entry.encrypted, 'base64'));
          if (Buffer.byteLength(plain, 'utf8') > 32768) throw new ProtocolFault('budget');
          const saved = checkedSaved(JSON.parse(plain) as unknown);
          if (keyFor(saved.scope.authProfileId, saved.scope.origin) !== entry.key) throw new ProtocolFault('protocol');
          this.records.set(entry.key, saved);
        } catch { this.storageFailed = true; }
      }
      this.encrypted = encrypted;
    } catch { this.healthy = false; this.storageFailed = true; this.records.clear(); }
  }
  available(): boolean { return this.healthy && this.cipher.isEncryptionAvailable(); }
  info(authProfileId: string, origin: string): BasicCredentialInfo {
    const key = keyFor(authProfileId, origin); const record = this.records.get(key);
    return { rememberAvailable: this.available(), remembered: this.encrypted.has(key), username: record?.value.username ?? null,
      rejected: record?.rejected ?? false, storageFailed: this.storageFailed };
  }
  get(scope: CredentialScope): CredentialInput | undefined {
    const record = this.records.get(keyFor(scope.authProfileId, scope.origin));
    if (record === undefined || record.rejected || !sameScope(record.scope, scope)) return undefined;
    return { username: record.value.username, password: record.value.password };
  }
  scopeFor(authProfileId: string, origin: string): CredentialScope | undefined {
    const scope = this.records.get(keyFor(authProfileId, origin))?.scope; return scope === undefined ? undefined : { ...scope };
  }
  accepted(authProfileId: string, origin: string): { scope: CredentialScope; value: CredentialInput } | undefined {
    const record = this.records.get(keyFor(authProfileId, origin));
    if (record === undefined || record.rejected) return undefined;
    return { scope: { ...record.scope }, value: { username: record.value.username, password: record.value.password } };
  }
  save(scope: CredentialScope, value: CredentialInput): Promise<void> {
    const saved = checkedSaved({ scope, value: { username: value.username, password: value.password }, rejected: false });
    return this.enqueue(async () => {
      const key = keyFor(scope.authProfileId, scope.origin); const encrypted = this.encode(saved);
      const next = new Map(this.encrypted); next.set(key, encrypted);
      await this.persist(next); this.encrypted = next; this.records.set(key, saved);
    });
  }
  reject(scope: CredentialScope): void {
    const key = keyFor(scope.authProfileId, scope.origin); const record = this.records.get(key);
    if (record === undefined || record.rejected || !sameScope(record.scope, scope)) return;
    const rejected = { ...record, rejected: true }; this.records.set(key, rejected);
    void this.enqueue(async () => {
      // 更新密码先完成时，迟到的旧失败不能覆盖更新后的条目。
      if (this.records.get(key) !== rejected) return;
      const next = new Map(this.encrypted); next.set(key, this.encode(rejected));
      await this.persist(next); this.encrypted = next;
    }).catch(() => {});
  }
  forget(authProfileId: string, origin?: string): Promise<void> {
    for (const [key, record] of this.records) if (record.scope.authProfileId === authProfileId && (origin === undefined || record.scope.origin === origin)) this.records.delete(key);
    return this.enqueue(async () => {
      const next = new Map(this.encrypted);
      for (const key of next.keys()) {
        const identity = JSON.parse(key) as [string, string];
        if (identity[0] === authProfileId && (origin === undefined || identity[1] === origin)) next.delete(key);
      }
      await this.persist(next); this.encrypted = next;
    });
  }
  keepProfiles(profiles: ReadonlySet<string>): Promise<void> {
    return this.enqueue(async () => {
      const next = new Map(this.encrypted);
      for (const key of next.keys()) if (!profiles.has((JSON.parse(key) as [string, string])[0])) next.delete(key);
      if (next.size === this.encrypted.size) return;
      await this.persist(next); this.encrypted = next;
      for (const [key, record] of this.records) if (!profiles.has(record.scope.authProfileId)) this.records.delete(key);
    });
  }
  flush(): Promise<void> { return this.writing; }
  private encode(value: SavedCredential): string {
    if (!this.available()) throw new ProtocolFault('unsupported');
    const encrypted = this.cipher.encryptString(JSON.stringify(value)).toString('base64');
    if (encrypted.length === 0 || encrypted.length > 65536) throw new ProtocolFault('budget');
    return encrypted;
  }
  private persist(next: ReadonlyMap<string, string>): Promise<void> {
    if (!this.healthy) throw new ProtocolFault('protocol');
    if (next.size > 128) throw new ProtocolFault('budget');
    return writeJson(this.path, { version: 1, entries: [...next].map(([key, encrypted]) => ({ key, encrypted })) }, MAX_BYTES);
  }
  private enqueue(work: () => Promise<void>): Promise<void> {
    const task = this.writing.then(work); this.writing = task.then(() => {}, () => { this.storageFailed = true; }); return task;
  }
}
function keyFor(profile: string, origin: string): string { return JSON.stringify([requireId(profile), cleanOrigin(origin)]); }
function cleanOrigin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || value.length > 2048 || url.username !== '' || url.password !== '') throw new ProtocolFault('protocol');
  return value;
}
function sameScope(left: CredentialScope, right: CredentialScope): boolean {
  return left.authProfileId === right.authProfileId && left.origin === right.origin && left.host === right.host
    && left.port === right.port && left.realm === right.realm && left.scheme === right.scheme;
}
function checkedSaved(value: unknown): SavedCredential {
  const saved = requireRecord(value); requireKeys(saved, ['scope', 'value', 'rejected']);
  const scope = requireRecord(saved.scope); requireKeys(scope, ['authProfileId', 'origin', 'host', 'port', 'realm', 'scheme']);
  if (typeof scope.origin !== 'string' || typeof scope.host !== 'string' || typeof scope.realm !== 'string' || scope.realm.length > 1024
    || /[\r\n]/u.test(scope.realm) || scope.scheme !== 'basic' || typeof saved.rejected !== 'boolean') throw new ProtocolFault('protocol');
  const origin = cleanOrigin(scope.origin); const url = new URL(origin);
  if (url.hostname !== scope.host || Number(url.port || (url.protocol === 'https:' ? 443 : 80)) !== scope.port) throw new ProtocolFault('protocol');
  const input = requireRecord(saved.value); requireKeys(input, ['username', 'password']);
  if (typeof input.username !== 'string' || input.username.length === 0 || input.username.length > 256 || /[:\r\n]/u.test(input.username)
    || typeof input.password !== 'string' || input.password.length > 4096 || /[\r\n]/u.test(input.password)) throw new ProtocolFault('protocol');
  return { scope: { authProfileId: requireId(scope.authProfileId), origin, host: scope.host, port: scope.port as number, realm: scope.realm, scheme: 'basic' },
    value: { username: input.username, password: input.password }, rejected: saved.rejected };
}
