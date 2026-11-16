import { createHash } from 'node:crypto';
import type { ServerConfig } from '../../shared/contracts.js';
import { ProtocolFault, requireId, requireKeys, requireRecord } from '../../shared/faults.js';
import { readJson, writeJson } from './json-file.js';

interface ConnectionIntent { readonly serverId: string; readonly identity: string; readonly day: string; readonly desired: boolean }
const MAX_BYTES = 64 * 1024;
export function localConnectionDay(date = new Date()): string {
  if (!Number.isFinite(date.getTime())) throw new ProtocolFault('protocol');
  return `${date.getFullYear().toString().padStart(4, '0')}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
}
/** 只保存身份指纹，不将服务器地址、密码、Cookie 或认证链接写入连接意图文件。 */
export function connectionIdentity(config: ServerConfig): string {
  return createHash('sha256').update(JSON.stringify([config.id, config.authProfileId, config.baseUrl, config.proxyMode ?? 'system']), 'utf8').digest('hex');
}

/** 每台服务器每日首次手动启用；同日重开可恢复，关闭应用与手动断开分开。 */
export class ConnectionIntentStore {
  private readonly records = new Map<string, ConnectionIntent>();
  private writing: Promise<void> = Promise.resolve();
  constructor(private readonly path: string, private readonly report: (error: unknown) => void = () => {},
    private readonly persist: (path: string, value: unknown, maximum: number) => Promise<void> = writeJson,
    private readonly read: (path: string, maximum: number) => Promise<unknown | undefined> = readJson) {}
  async load(): Promise<void> {
    try {
      const value = await this.read(this.path, MAX_BYTES); if (value === undefined) return;
      const data = requireRecord(value); requireKeys(data, ['version', 'servers']);
      if (data.version !== 1) throw new ProtocolFault('unsupported');
      if (!Array.isArray(data.servers) || data.servers.length > 64) throw new ProtocolFault('budget');
      const records = new Map<string, ConnectionIntent>();
      for (const item of data.servers) {
        const entry = requireRecord(item); requireKeys(entry, ['serverId', 'identity', 'day', 'desired']);
        const serverId = requireId(entry.serverId);
        if (records.has(serverId) || typeof entry.identity !== 'string' || !/^[\da-f]{64}$/u.test(entry.identity)
          || typeof entry.desired !== 'boolean') throw new ProtocolFault('protocol');
        records.set(serverId, { serverId, identity: entry.identity, desired: entry.desired, day: checkedDay(entry.day) });
      }
      this.records.clear(); for (const [id, intent] of records) this.records.set(id, intent);
    } catch (error) { this.records.clear(); this.report(error); }
  }
  shouldResume(config: ServerConfig, today = localConnectionDay()): boolean {
    const intent = this.records.get(config.id);
    return intent?.desired === true && intent.identity === connectionIdentity(config) && intent.day === checkedDay(today);
  }
  rememberVerified(config: ServerConfig, day: string): Promise<void> {
    if (!this.records.has(config.id) && this.records.size >= 64) return Promise.reject(new ProtocolFault('budget'));
    this.records.set(config.id, { serverId: config.id, identity: connectionIdentity(config), day: checkedDay(day), desired: true });
    return this.save();
  }
  disconnect(config: ServerConfig): Promise<void> {
    const previous = this.records.get(config.id); if (previous === undefined) return Promise.resolve();
    this.records.set(config.id, { ...previous, desired: false }); return this.save();
  }
  keepServers(configs: readonly ServerConfig[]): Promise<void> {
    const identities = new Map(configs.map(config => [config.id, connectionIdentity(config)])); let changed = false;
    for (const [id, intent] of this.records) {
      const identity = identities.get(id);
      if (identity === undefined) { this.records.delete(id); changed = true; }
      else if (identity !== intent.identity && intent.desired) { this.records.set(id, { ...intent, desired: false }); changed = true; }
    }
    return changed ? this.save() : Promise.resolve();
  }
  flush(): Promise<void> { return this.writing; }
  private save(): Promise<void> {
    const value = { version: 1, servers: [...this.records.values()].map(record => ({ ...record })) };
    const task = this.writing.then(() => this.persist(this.path, value, MAX_BYTES));
    this.writing = task.catch(error => this.report(error)); return task;
  }
}
function checkedDay(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new ProtocolFault('protocol');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(`${value}T12:00:00`);
  if (!Number.isFinite(date.getTime()) || date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day) throw new ProtocolFault('protocol');
  return value;
}
