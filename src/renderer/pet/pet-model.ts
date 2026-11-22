// SPDX-License-Identifier: AGPL-3.0-or-later
// 展示行为移植自 CLI-Manager/pet-e/src/renderer/app.ts、task-state.ts，2026-11-16 适配为内置、仅跳回；见 NOTICE.txt 与 LICENSE。
import type { PetViewConfig, PetViewSnapshot } from '../../shared/pet-view.js';
import type { TaskColor } from '../../shared/domain.js';

export const PET_COLOR_ORDER: readonly TaskColor[] = ['green', 'yellow', 'red', 'blue'];
export const PET_LABELS: Readonly<Record<TaskColor | 'idle', string>> = {
  green: '关注会话运行中', yellow: '等待你的交互', red: '关注会话异常', blue: '关注结果待查看', idle: '没有关注任务',
};
export function escapePetText(value: string): string {
  return value.replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character));
}
export function firstPetColor(snapshot: PetViewSnapshot | null): TaskColor | null {
  return snapshot === null ? null : PET_COLOR_ORDER.find(color => snapshot.counts[color] > 0) ?? null;
}
export const PET_PANEL_HIDE_DELAY_MS = 10000;

/** 只记录灯／气泡边界和固定离开期限；重绘与重复移开不得延长计时。 */
export class PetPanelHover {
  private expanded: TaskColor | null = null;
  private pointerTarget: TaskColor | 'panel' | null = null;
  private deadline: number | null = null;
  get color(): TaskColor | null { return this.expanded; }
  get closeAt(): number | null { return this.deadline; }
  pointer(color: TaskColor | null, insidePanel: boolean, canOpen: boolean, now: number): boolean {
    const previous = this.expanded; const target = insidePanel ? 'panel' : color;
    if (canOpen && !insidePanel && color !== null && target !== this.pointerTarget) this.expanded = color;
    this.pointerTarget = target; this.updateDeadline(now);
    return previous !== this.expanded;
  }
  toggle(color: TaskColor, now: number): void { this.expanded = this.expanded === color ? null : color; this.updateDeadline(now); }
  // 保留当前命中区域；同一灯上的重绘不能马上撤销用户的显式收起。
  close(): void { this.expanded = null; this.deadline = null; }
  expire(now: number): boolean {
    if (this.deadline === null || now < this.deadline) return false;
    this.close(); return true;
  }
  private updateDeadline(now: number): void {
    if (this.expanded === null || this.pointerTarget !== null) this.deadline = null;
    else this.deadline ??= now + PET_PANEL_HIDE_DELAY_MS;
  }
}
export function petSpriteClass(config: PetViewConfig, mood: TaskColor | 'idle'): string {
  const pet = config.pet; const state = pet?.states[mood] ?? pet?.states.idle ?? { row: 0, frames: 1 };
  const rows = pet?.spriteVersionNumber === 2 ? 11 : 9;
  const row = Math.min(rows - 1, Math.max(0, Math.round(state.row))); const frames = Math.min(8, Math.max(1, Math.round(state.frames)));
  return `sprite-sheet sprite-row-${row} sprite-rows-${rows} sprite-frames-${frames}${frames > 1 ? ' animated' : ''}`;
}
