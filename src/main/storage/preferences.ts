import type { SessionPreference, WorkbenchSettings } from '../../shared/domain.js';
import { ProtocolFault, requireKeys, requireRecord } from '../../shared/faults.js';
import { readJson, writeJson } from './json-file.js';

export const DEFAULT_SETTINGS: WorkbenchSettings = {
  syncIntervalSeconds: 10, notifications: true, sidebarWidth: 260, theme: 'system', petEnabled: false,
};
const DEFAULT_SESSION: SessionPreference = { followed: false, readSeq: -1, acknowledgedResult: null, manualUnread: false };
interface PreferenceData {
  readonly version: 1;
  readonly settings: WorkbenchSettings;
  readonly sessions: Readonly<Record<string, SessionPreference>>;
  readonly petRuntimeRoot: string | null;
  readonly petResourceRoot: string | null;
}

/** 只保存关注、阅读水位与界面偏好；草稿、正文和认证材料不写磁盘。 */
export class Preferences {
  private data: PreferenceData = { version: 1, settings: { ...DEFAULT_SETTINGS }, sessions: {}, petRuntimeRoot: null, petResourceRoot: null };
  private writing: Promise<void> = Promise.resolve();
  constructor(private readonly path: string, private readonly onChange: () => void = () => {},
    private readonly persist: (path: string, value: unknown, maxBytes: number) => Promise<void> = writeJson) {}
  async load(): Promise<void> {
    const value = await readJson(this.path, 2 * 1024 * 1024);
    if (value === undefined) return;
    const data = requireRecord(value);
    requireKeys(data, ['version', 'settings', 'sessions', 'petRuntimeRoot', 'petResourceRoot']);
    if (data.version !== 1) throw new ProtocolFault('unsupported');
    const sessions = requireRecord(data.sessions);
    if (Object.keys(sessions).length > 10000) throw new ProtocolFault('budget');
    const checked: Record<string, SessionPreference> = Object.create(null) as Record<string, SessionPreference>;
    for (const [key, value] of Object.entries(sessions)) {
      if (key.length > 1024) throw new ProtocolFault('protocol');
      checked[key] = parsePreference(value);
    }
    this.data = {
      version: 1, settings: parseSettings(data.settings), sessions: checked,
      petRuntimeRoot: parseLocalPath(data.petRuntimeRoot), petResourceRoot: parseLocalPath(data.petResourceRoot),
    };
  }
  settings(): WorkbenchSettings { return { ...this.data.settings }; }
  session(key: string): SessionPreference { return { ...(this.data.sessions[key] ?? DEFAULT_SESSION) }; }
  hasSession(key: string): boolean { return Object.hasOwn(this.data.sessions, key); }
  petPaths(): { runtimeRoot: string | null; resourceRoot: string | null } { return { runtimeRoot: this.data.petRuntimeRoot, resourceRoot: this.data.petResourceRoot }; }
  updateSettings(value: unknown): Promise<void> {
    const settings = parseSettings(value);
    return this.mutate(data => ({ ...data, settings }));
  }
  updateSession(key: string, apply: (value: SessionPreference) => SessionPreference): Promise<void> {
    if (key.length > 1024) throw new ProtocolFault('protocol');
    return this.mutate(data => {
      const previous = data.sessions[key] ?? DEFAULT_SESSION;
      const next = parsePreference(apply(previous));
      if (JSON.stringify(previous) === JSON.stringify(next)) return data;
      return { ...data, sessions: { ...data.sessions, [key]: next } };
    });
  }
  primeRead(key: string, cursor: number): Promise<void> {
    return this.mutate(data => data.sessions[key] !== undefined && (data.sessions[key].readSeq >= 0 || data.sessions[key].manualUnread) ? data : ({
      ...data, sessions: { ...data.sessions, [key]: { ...(data.sessions[key] ?? DEFAULT_SESSION), readSeq: cursor } },
    }));
  }
  setPetPaths(runtimeRoot: string | null, resourceRoot: string | null): Promise<void> {
    const runtime = parseLocalPath(runtimeRoot);
    const resource = parseLocalPath(resourceRoot);
    return this.mutate(data => ({ ...data, petRuntimeRoot: runtime, petResourceRoot: resource }));
  }
  private mutate(apply: (data: PreferenceData) => PreferenceData): Promise<void> {
    const task = this.writing.then(async () => {
      const next = apply(this.data);
      if (next === this.data) return;
      if (Object.keys(next.sessions).length > 10000) throw new ProtocolFault('budget');
      await this.persist(this.path, next, 2 * 1024 * 1024);
      this.data = next;
      this.onChange();
    });
    this.writing = task.catch(() => {});
    return task;
  }
}
export function parseSettings(value: unknown): WorkbenchSettings {
  const data = requireRecord(value);
  requireKeys(data, ['syncIntervalSeconds', 'notifications', 'sidebarWidth', 'theme', 'petEnabled']);
  if (typeof data.syncIntervalSeconds !== 'number' || !Number.isSafeInteger(data.syncIntervalSeconds) || data.syncIntervalSeconds < 1 || data.syncIntervalSeconds > 3600
    || typeof data.sidebarWidth !== 'number' || !Number.isSafeInteger(data.sidebarWidth) || data.sidebarWidth < 200 || data.sidebarWidth > 480
    || typeof data.notifications !== 'boolean' || typeof data.petEnabled !== 'boolean'
    || !['system', 'light', 'dark'].includes(String(data.theme))) throw new ProtocolFault('protocol');
  return {
    syncIntervalSeconds: data.syncIntervalSeconds, notifications: data.notifications, sidebarWidth: data.sidebarWidth,
    theme: data.theme as WorkbenchSettings['theme'], petEnabled: data.petEnabled,
  };
}
function parsePreference(value: unknown): SessionPreference {
  const data = requireRecord(value);
  requireKeys(data, ['followed', 'readSeq', 'acknowledgedResult', 'manualUnread']);
  if (typeof data.followed !== 'boolean' || typeof data.manualUnread !== 'boolean'
    || typeof data.readSeq !== 'number' || !Number.isSafeInteger(data.readSeq) || data.readSeq < -1
    || (data.acknowledgedResult !== null && (typeof data.acknowledgedResult !== 'string' || data.acknowledgedResult.length > 256))) throw new ProtocolFault('protocol');
  return { followed: data.followed, readSeq: data.readSeq, acknowledgedResult: data.acknowledgedResult as string | null, manualUnread: data.manualUnread };
}
function parseLocalPath(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f]/u.test(value)) throw new ProtocolFault('protocol');
  return value;
}
