import type { SessionPreference, WorkbenchSettings } from '../../shared/domain.js';
import type { AppearanceSettings } from '../../shared/appearance.js';
import { DEFAULT_APPEARANCE, parseAppearance, parseAppearancePatch } from '../../shared/appearance.js';
import type { PetDisplaySettings } from '../../shared/pet-display.js';
import { DEFAULT_PET_DISPLAY, parsePetDisplay, parsePetDisplayPatch } from '../../shared/pet-display.js';
import { ProtocolFault, requireId, requireKeys, requireRecord } from '../../shared/faults.js';
import { readJson, writeJson } from './json-file.js';

export const DEFAULT_SETTINGS: WorkbenchSettings = {
  syncIntervalSeconds: 10, notifications: true, sidebarWidth: 260, theme: 'system', petEnabled: false,
};
const DEFAULT_SESSION: SessionPreference = { followed: false, readSeq: -1, acknowledgedResult: null, manualUnread: false };
interface PreferenceData {
  readonly version: 1;
  readonly settings: WorkbenchSettings;
  readonly sessions: Readonly<Record<string, SessionPreference>>;
  readonly petResourceRoot: string | null;
  readonly petSelectionId: string | null;
  readonly petDisplay: PetDisplaySettings;
  readonly appearance: AppearanceSettings;
  readonly backgroundPath: string | null;
}

/** 只保存关注、阅读水位与界面偏好；草稿、正文和认证材料不写磁盘。 */
export class Preferences {
  private data: PreferenceData = { version: 1, settings: { ...DEFAULT_SETTINGS }, sessions: {}, petResourceRoot: null, petSelectionId: null,
    petDisplay: parsePetDisplay(DEFAULT_PET_DISPLAY), appearance: parseAppearance(DEFAULT_APPEARANCE), backgroundPath: null };
  private writing: Promise<void> = Promise.resolve();
  constructor(private readonly path: string, private readonly onChange: () => void = () => {},
    private readonly persist: (path: string, value: unknown, maxBytes: number) => Promise<void> = writeJson) {}
  async load(): Promise<void> {
    const value = await readJson(this.path, 2 * 1024 * 1024);
    if (value === undefined) return;
    const data = requireRecord(value);
    // 旧运行器字段仅兼容接收，不保存或要求该路径；宠物改由本应用承载。
    requireKeys(data, ['version', 'settings', 'sessions', 'petResourceRoot'], ['petRuntimeRoot', 'petSelectionId', 'petDisplay', 'appearance', 'backgroundPath']);
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
      petResourceRoot: parseLocalPath(data.petResourceRoot),
      petSelectionId: data.petSelectionId === undefined || data.petSelectionId === null ? null : requireId(data.petSelectionId),
      petDisplay: parsePetDisplay(data.petDisplay ?? DEFAULT_PET_DISPLAY),
      appearance: parseAppearance(data.appearance ?? DEFAULT_APPEARANCE), backgroundPath: data.backgroundPath === undefined ? null : parseLocalPath(data.backgroundPath),
    };
  }
  settings(): WorkbenchSettings { return { ...this.data.settings }; }
  appearance(): AppearanceSettings { return parseAppearance(this.data.appearance); }
  backgroundPath(): string | null { return this.data.backgroundPath; }
  updateAppearance(value: unknown): Promise<void> {
    const patch = parseAppearancePatch(value);
    return this.mutate(data => ({ ...data, appearance: parseAppearance({ ...data.appearance, ...patch }) }));
  }
  setBackgroundPath(value: string | null): Promise<void> {
    const backgroundPath = parseLocalPath(value);
    return this.mutate(data => ({ ...data, backgroundPath, appearance: { ...data.appearance, backgroundEnabled: backgroundPath !== null,
      crop: backgroundPath === data.backgroundPath ? data.appearance.crop : { ...DEFAULT_APPEARANCE.crop } } }));
  }
  session(key: string): SessionPreference { return { ...(this.data.sessions[key] ?? DEFAULT_SESSION) }; }
  hasSession(key: string): boolean { return Object.hasOwn(this.data.sessions, key); }
  petPaths(): { resourceRoot: string | null } { return { resourceRoot: this.data.petResourceRoot }; }
  petDisplay(): PetDisplaySettings { return parsePetDisplay(this.data.petDisplay); }
  updatePetDisplay(value: unknown): Promise<void> {
    const patch = parsePetDisplayPatch(value);
    return this.mutate(data => {
      const display = parsePetDisplay({ ...data.petDisplay, ...patch });
      return JSON.stringify(display) === JSON.stringify(data.petDisplay) ? data : { ...data, petDisplay: display };
    });
  }
  petSelection(): string | null { return this.data.petSelectionId; }
  setPetSelection(value: string | null): Promise<void> { const id = value === null ? null : requireId(value); return this.mutate(data => ({ ...data, petSelectionId: id })); }
  updateSettings(value: unknown, appearanceValue?: unknown): Promise<void> {
    const settings = parseSettings(value); const appearance = appearanceValue === undefined ? undefined : parseAppearance(appearanceValue);
    return this.mutate(data => ({ ...data, settings, ...(appearance === undefined ? {} : { appearance }) }));
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
  setPetLibrary(resourceRoot: string | null): Promise<void> {
    const resource = parseLocalPath(resourceRoot);
    return this.mutate(data => ({ ...data, petResourceRoot: resource,
      petSelectionId: resource === data.petResourceRoot ? data.petSelectionId : null }));
  }
  flush(): Promise<void> { return this.writing; }
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
