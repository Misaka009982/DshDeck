import { ProtocolFault, requireKeys, requireRecord } from './faults.js';

export const PET_DRAG_MAX_MS = 60000;
export interface PetPoint { readonly x: number; readonly y: number }
export interface PetDragRequest { readonly gestureId: string; readonly phase: 'start' | 'move' | 'end' }

/** 页面只能声明手势阶段；窗口位置、鼠标位置和期限均由主进程取得。 */
export function parsePetDragRequest(value: unknown): PetDragRequest {
  const request = requireRecord(value); requireKeys(request, ['gestureId', 'phase']);
  if (typeof request.gestureId !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(request.gestureId)
    || request.phase !== 'start' && request.phase !== 'move' && request.phase !== 'end') throw new ProtocolFault('protocol');
  return { gestureId: request.gestureId, phase: request.phase };
}
interface DragGesture {
  readonly id: string; readonly origin: PetPoint; readonly cursor: PetPoint; readonly expiresAt: number;
}
/** 只保存一项有界手势；与 DOM 重绘、宠物精灵帧、会话快照代次无关。 */
export class PetDragState {
  private gesture: DragGesture | undefined;
  begin(id: string, origin: PetPoint, cursor: PetPoint, now: number, enabled: boolean): boolean {
    if (!enabled) return false;
    if (this.gesture !== undefined) return this.gesture.id === id;
    parsePetDragRequest({ gestureId: id, phase: 'start' }); validClock(now);
    this.gesture = { id, origin: point(origin), cursor: point(cursor), expiresAt: now + PET_DRAG_MAX_MS };
    return true;
  }
  matches(id?: string): boolean { return this.gesture !== undefined && (id === undefined || this.gesture.id === id); }
  move(id: string, cursor: PetPoint, now: number): PetPoint | undefined {
    const gesture = this.gesture;
    if (gesture === undefined || gesture.id !== id) return undefined;
    validClock(now); if (now >= gesture.expiresAt) return undefined;
    const current = point(cursor);
    return { x: bounded(gesture.origin.x + current.x - gesture.cursor.x), y: bounded(gesture.origin.y + current.y - gesture.cursor.y) };
  }
  end(id?: string): string | undefined {
    if (!this.matches(id)) return undefined;
    const ended = this.gesture?.id; this.gesture = undefined; return ended;
  }
}
function point(value: PetPoint): PetPoint {
  for (const number of [value.x, value.y]) if (!Number.isFinite(number) || Math.abs(number) > 1000000) throw new ProtocolFault('protocol');
  return { x: Math.round(value.x), y: Math.round(value.y) };
}
function validClock(now: number): void { if (!Number.isFinite(now) || now < 0) throw new ProtocolFault('protocol'); }
function bounded(value: number): number { return Math.max(-1000000, Math.min(1000000, value)); }
