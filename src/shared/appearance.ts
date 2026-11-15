import { ProtocolFault, requireKeys, requireRecord } from './faults.js';

export interface BackgroundCrop { readonly centerX: number; readonly centerY: number; readonly zoom: number }
export interface AppearanceSettings {
  readonly sidebarCollapsed: boolean;
  readonly viewMode: 'web' | 'native';
  readonly backgroundEnabled: boolean;
  readonly sessionTransparency: number;
  readonly crop: BackgroundCrop;
}
export type AppearancePatch = Partial<AppearanceSettings>;
export interface BackgroundImageInfo { readonly assetUrl: string; readonly name: string; readonly width: number; readonly height: number }
export interface AppearanceView {
  readonly settings: AppearanceSettings;
  readonly image: BackgroundImageInfo | null;
  readonly imageState: 'empty' | 'ready' | 'unavailable';
  readonly message: string;
}
export interface ImageSize { readonly width: number; readonly height: number }
export interface CropFrame extends ImageSize { readonly left: number; readonly top: number; readonly scale: number; readonly centerX: number; readonly centerY: number }
export const DEFAULT_APPEARANCE: AppearanceSettings = {
  sidebarCollapsed: false, viewMode: 'web', backgroundEnabled: false, sessionTransparency: 20,
  crop: { centerX: 0.5, centerY: 0.5, zoom: 1 },
};

export function parseAppearance(value: unknown): AppearanceSettings {
  const data = requireRecord(value); requireKeys(data, ['sidebarCollapsed', 'viewMode', 'backgroundEnabled', 'sessionTransparency', 'crop']);
  if (typeof data.sidebarCollapsed !== 'boolean' || typeof data.backgroundEnabled !== 'boolean' || data.viewMode !== 'web' && data.viewMode !== 'native'
    || typeof data.sessionTransparency !== 'number' || !Number.isSafeInteger(data.sessionTransparency) || data.sessionTransparency < 0 || data.sessionTransparency > 100) throw new ProtocolFault('protocol');
  return { sidebarCollapsed: data.sidebarCollapsed, viewMode: data.viewMode, backgroundEnabled: data.backgroundEnabled,
    sessionTransparency: data.sessionTransparency, crop: parseCrop(data.crop) };
}
export function parseAppearancePatch(value: unknown): AppearancePatch {
  const data = requireRecord(value); requireKeys(data, [], ['sidebarCollapsed', 'viewMode', 'backgroundEnabled', 'sessionTransparency', 'crop']);
  if (Object.keys(data).length === 0) throw new ProtocolFault('protocol');
  const checked = parseAppearance({ ...DEFAULT_APPEARANCE, ...data });
  const patch: AppearancePatch = {};
  for (const key of ['sidebarCollapsed', 'viewMode', 'backgroundEnabled', 'sessionTransparency', 'crop'] as const) {
    if (Object.hasOwn(data, key)) Object.assign(patch, { [key]: checked[key] });
  }
  return patch;
}
export function parseCrop(value: unknown): BackgroundCrop {
  const crop = requireRecord(value); requireKeys(crop, ['centerX', 'centerY', 'zoom']);
  for (const [key, min, max] of [['centerX', 0, 1], ['centerY', 0, 1], ['zoom', 1, 8]] as const) {
    const number = crop[key]; if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max) throw new ProtocolFault('protocol');
  }
  return { centerX: crop.centerX as number, centerY: crop.centerY as number, zoom: crop.zoom as number };
}
/** 框比例采用当前窗口，而非固定壁纸比例；有效中心夹在图片内，不改写用户保存的中心。 */
export function cropFrame(image: ImageSize, viewport: ImageSize, crop: BackgroundCrop): CropFrame {
  for (const size of [image, viewport]) if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) throw new ProtocolFault('protocol');
  const checked = parseCrop(crop);
  const scale = Math.max(viewport.width / image.width, viewport.height / image.height) * checked.zoom;
  const width = Math.min(image.width, viewport.width / scale); const height = Math.min(image.height, viewport.height / scale);
  const centerX = clamp(checked.centerX * image.width, width / 2, image.width - width / 2);
  const centerY = clamp(checked.centerY * image.height, height / 2, image.height - height / 2);
  return { left: centerX - width / 2, top: centerY - height / 2, width, height, scale, centerX, centerY };
}
export function panelAlpha(transparency: number, conversation: boolean): number {
  const value = clamp(transparency + (conversation ? 0 : 10), 0, 100);
  return (100 - value) / 100;
}
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
