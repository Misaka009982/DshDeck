import { ProtocolFault, requireKeys, requireRecord } from './faults.js';

export interface WindowBounds { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface WindowState { readonly version: 1; readonly bounds: WindowBounds; readonly maximized: boolean }
export interface RestoredWindowState {
  readonly bounds: WindowBounds;
  readonly maximized: boolean;
  readonly minWidth: number;
  readonly minHeight: number;
}

export function parseWindowState(value: unknown): WindowState {
  const data = requireRecord(value); requireKeys(data, ['version', 'bounds', 'maximized']);
  if (data.version !== 1 || typeof data.maximized !== 'boolean') throw new ProtocolFault('protocol');
  const bounds = requireRecord(data.bounds); requireKeys(bounds, ['x', 'y', 'width', 'height']);
  return { version: 1, maximized: data.maximized, bounds: {
    x: integer(bounds.x, -131072, 131072), y: integer(bounds.y, -131072, 131072),
    width: integer(bounds.width, 1, 32768), height: integer(bounds.height, 1, 32768),
  } };
}

/** areas 的第一项是主显示器可用区域；屏外状态回退到主屏，不依赖旧显示器编号。 */
export function restoreWindowState(saved: WindowState | null, areas: readonly WindowBounds[]): RestoredWindowState {
  const available = areas.filter(area => [area.x, area.y, area.width, area.height].every(Number.isSafeInteger) && area.width > 0 && area.height > 0);
  const primary = available[0] ?? { x: 0, y: 0, width: 1920, height: 1080 };
  let area = primary; let overlap = 0;
  if (saved !== null) for (const candidate of available) {
    const shared = intersection(saved.bounds, candidate);
    if (shared > overlap) { overlap = shared; area = candidate; }
  }
  const minWidth = Math.min(860, Math.floor(area.width));
  const minHeight = Math.min(620, Math.floor(area.height));
  const width = clamp(saved?.bounds.width ?? 1280, minWidth, Math.floor(area.width));
  const height = clamp(saved?.bounds.height ?? 860, minHeight, Math.floor(area.height));
  const centered = saved === null || overlap === 0;
  const x = clamp(centered ? area.x + (area.width - width) / 2 : saved.bounds.x, area.x, area.x + area.width - width);
  const y = clamp(centered ? area.y + (area.height - height) / 2 : saved.bounds.y, area.y, area.y + area.height - height);
  return { bounds: { x: Math.round(x), y: Math.round(y), width, height }, maximized: saved?.maximized ?? false, minWidth, minHeight };
}
function intersection(left: WindowBounds, right: WindowBounds): number {
  return Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x))
    * Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
}
function clamp(value: number, low: number, high: number): number { return Math.round(Math.min(high, Math.max(low, value))); }
function integer(value: unknown, low: number, high: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < low || value > high) throw new ProtocolFault('protocol');
  return value;
}
