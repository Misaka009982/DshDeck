import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ServerConfig, ServerInput } from '../../shared/contracts.js';
import { createPartitionName, normalizeServerInput } from '../../shared/server-config.js';
import { ProtocolFault, requireId, requireKeys, requireRecord } from '../../shared/faults.js';

/** 文件仅保存地址、别名与随机身份；不会序列化运行快照或认证材料。 */
export class ServerStore {
  private configs: ServerConfig[] = [];
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    let text: string;
    try { text = await readFile(this.path, 'utf8'); }
    catch (error) {
      if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') return;
      throw new ProtocolFault('protocol');
    }
    if (Buffer.byteLength(text, 'utf8') > 256 * 1024) throw new ProtocolFault('budget');
    let value: unknown;
    try { value = JSON.parse(text) as unknown; } catch { throw new ProtocolFault('protocol'); }
    if (!Array.isArray(value) || value.length > 64) throw new ProtocolFault('protocol');
    const configs = value.map(item => {
      const record = requireRecord(item);
      requireKeys(record, ['id', 'alias', 'baseUrl', 'authProfileId']);
      const id = requireId(record.id);
      const authProfileId = requireId(record.authProfileId);
      createPartitionName(authProfileId);
      return { ...normalizeServerInput({ alias: record.alias, baseUrl: record.baseUrl }), id, authProfileId };
    });
    if (new Set(configs.map(config => config.id)).size !== configs.length
      || new Set(configs.map(config => config.authProfileId)).size !== configs.length) throw new ProtocolFault('protocol');
    this.configs = configs;
  }

  all(): readonly ServerConfig[] { return this.configs.map(config => ({ ...config })); }

  add(value: ServerInput): Promise<ServerConfig> {
    const input = normalizeServerInput(value);
    return this.mutate(configs => {
      if (configs.length >= 64) throw new ProtocolFault('budget');
      const config = { ...input, id: randomUUID(), authProfileId: randomUUID() };
      return { configs: [...configs, config], config };
    });
  }

  edit(id: string, value: ServerInput): Promise<ServerConfig> {
    const input = normalizeServerInput(value);
    return this.mutate(configs => {
      const previous = configs.find(config => config.id === id);
      if (previous === undefined) throw new ProtocolFault('not-found');
      const config = { ...input, id, authProfileId: previous.baseUrl === input.baseUrl ? previous.authProfileId : randomUUID() };
      return { configs: configs.map(item => item.id === id ? config : item), config };
    });
  }

  private mutate(update: (configs: readonly ServerConfig[]) => { configs: ServerConfig[]; config: ServerConfig }): Promise<ServerConfig> {
    const task = this.writing.then(async () => {
      const next = update(this.configs);
      const content = `${JSON.stringify(next.configs, null, 2)}\n`;
      if (Buffer.byteLength(content, 'utf8') > 256 * 1024) throw new ProtocolFault('budget');
      await mkdir(dirname(this.path), { recursive: true });
      const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
        await rename(temporaryPath, this.path);
      } catch (error) {
        await unlink(temporaryPath).catch(() => {});
        throw error;
      }
      this.configs = next.configs;
      return { ...next.config };
    });
    this.writing = task.then(() => {}, () => {});
    return task;
  }
}
