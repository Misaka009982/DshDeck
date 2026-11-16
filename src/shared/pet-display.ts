// SPDX-License-Identifier: AGPL-3.0-or-later
// 几何算法改编自 CLI-Manager/pet-e，2026-11-16 适配为本机显示契约；见 NOTICE.txt 与 LICENSE。
import { ProtocolFault, requireKeys, requireRecord } from './faults.js';

/** 内置宠物的本机显示偏好；位置不接受任意路径、网址或命令。 */
export interface PetDisplaySettings {
  readonly size: number;
  readonly position: { readonly x: number; readonly y: number } | null;
  readonly lockPosition: boolean;
  readonly alwaysOnTop: boolean;
  readonly soundEnabled: boolean;
  readonly showStatus: boolean;
  readonly showCliLabel: boolean;
  readonly showTaskArea: boolean;
  readonly openOnHover: boolean;
  readonly autoHideFullscreen: boolean;
  readonly notificationsEnabled: boolean;
}
const BOOLEAN_KEYS = ['lockPosition', 'alwaysOnTop', 'soundEnabled', 'showStatus', 'showCliLabel', 'showTaskArea', 'openOnHover', 'autoHideFullscreen', 'notificationsEnabled'] as const;
const KEYS = ['size', 'position', ...BOOLEAN_KEYS] as const;
export const DEFAULT_PET_DISPLAY: PetDisplaySettings = Object.freeze({
  size: 100, position: null, lockPosition: false, alwaysOnTop: true, soundEnabled: false,
  showStatus: true, showCliLabel: true, showTaskArea: true, openOnHover: true, autoHideFullscreen: true, notificationsEnabled: true,
});
export type PetDisplayPatch = Partial<PetDisplaySettings>;
export function parsePetDisplayPatch(value: unknown): PetDisplayPatch {
  const data = requireRecord(value); requireKeys(data, [], KEYS);
  const patch: Record<string, unknown> = {};
  if (Object.hasOwn(data, 'size')) {
    if (typeof data.size !== 'number' || !Number.isSafeInteger(data.size) || data.size < 50 || data.size > 200 || data.size % 5 !== 0) throw new ProtocolFault('protocol');
    patch.size = data.size;
  }
  if (Object.hasOwn(data, 'position')) {
    if (data.position === null) patch.position = null;
    else {
      const position = requireRecord(data.position); requireKeys(position, ['x', 'y']);
      if (typeof position.x !== 'number' || typeof position.y !== 'number' || !Number.isSafeInteger(position.x) || !Number.isSafeInteger(position.y)
        || Math.abs(position.x) > 1000000 || Math.abs(position.y) > 1000000) throw new ProtocolFault('protocol');
      patch.position = { x: position.x, y: position.y };
    }
  }
  for (const key of BOOLEAN_KEYS) if (Object.hasOwn(data, key)) {
    if (typeof data[key] !== 'boolean') throw new ProtocolFault('protocol');
    patch[key] = data[key];
  }
  return patch as PetDisplayPatch;
}
export function parsePetDisplay(value: unknown): PetDisplaySettings {
  const data = requireRecord(value); requireKeys(data, KEYS);
  return { ...DEFAULT_PET_DISPLAY, ...parsePetDisplayPatch(data) };
}
export interface PetWorkArea { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
/** 移植 CLI-Manager/pet-e 的 380×540 基准几何；显示器校正不启动任何外部运行器。 */
export function petWindowGeometry(settings: PetDisplaySettings, area: PetWorkArea): { readonly bounds: PetWorkArea; readonly scale: number } {
  for (const value of [area.x, area.y, area.width, area.height]) if (!Number.isSafeInteger(value)) throw new ProtocolFault('protocol');
  if (area.width < 1 || area.height < 1 || area.width > 65536 || area.height > 65536) throw new ProtocolFault('protocol');
  const scale = Math.min(2, Math.max(.5, settings.size / 100), area.width / 380, area.height / 540);
  const width = Math.min(area.width, Math.max(1, Math.round(380 * scale))); const height = Math.min(area.height, Math.max(1, Math.round(540 * scale)));
  const clampX = (value: number): number => Math.min(area.x + area.width - width, Math.max(area.x, Math.round(value)));
  const clampY = (value: number): number => Math.min(area.y + area.height - height, Math.max(area.y, Math.round(value)));
  return { bounds: { x: clampX(settings.position?.x ?? area.x + area.width - width - 24), y: clampY(settings.position?.y ?? area.y + area.height - height - 24), width, height }, scale };
}
