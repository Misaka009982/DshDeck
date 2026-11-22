// SPDX-License-Identifier: AGPL-3.0-or-later
// 协议字段移植自 CLI-Manager/pet-e，2026-11-16 适配为同进程、受限 IPC；保留原作者权利，见 NOTICE.txt 与 LICENSE。
import type { IpcResult } from './contracts.js';
import type { TaskColor } from './domain.js';
import type { PetDisplaySettings } from './pet-display.js';
import type { PetDragRequest } from './pet-drag.js';
import { ProtocolFault, requireId, requireKeys, requireRecord } from './faults.js';

export const PET_APP_SCHEME = 'dshdeck-pet-app';
export const PET_ASSET_SCHEME = 'dshdeck-pet-asset';
export const PET_PAGE_URL = `${PET_APP_SCHEME}://app/index.html`;
export interface PetViewTask {
  readonly id: string; readonly sessionId: string; readonly source: 'other'; readonly agentLabel: string; readonly title: string;
  readonly projectName: null; readonly workspanId: null; readonly paneId: null; readonly daemonOnly: false;
  readonly sessionAlive: boolean; readonly color: TaskColor; readonly updatedAt: number; readonly viewedAt: null; readonly pendingAction: null;
}
export interface PetViewNotice { readonly id: string; readonly title: string; readonly message: string; readonly createdAt: number; readonly expiresAt: number }
export interface PetViewSnapshot {
  readonly protocolVersion: 1; readonly instanceId: string; readonly generation: number; readonly revision: number; readonly generatedAt: number;
  readonly tasks: readonly PetViewTask[]; readonly counts: Readonly<Record<TaskColor, number>>; readonly mood: TaskColor | 'idle';
  readonly cliLabel: { readonly agentLabel: string; readonly color: TaskColor; readonly otherTaskCount: number } | null;
  readonly notification: PetViewNotice | null; readonly diagnostics: readonly never[]; readonly truncated: boolean;
}
export interface PetViewAsset {
  readonly id: string; readonly displayName: string; readonly spritePath: string; readonly spriteVersionNumber: 1 | 2;
  readonly states: Readonly<Record<TaskColor | 'idle', { readonly row: number; readonly frames: number }>>;
}
export interface PetViewConfig {
  readonly language: 'zh-CN'; readonly visible: boolean; readonly theme: 'light' | 'dark';
  readonly settings: PetDisplaySettings; readonly pet: PetViewAsset | null;
}
export type PetMouseRegion = 'none' | 'body' | 'controls';
export function parsePetMouseRegion(value: unknown): PetMouseRegion {
  if (value !== 'none' && value !== 'body' && value !== 'controls') throw new ProtocolFault('protocol');
  return value;
}
/** 锁定主体穿透，灯／气泡／按钮仍可点击；运行器另校验当前可见与拖动状态。 */
export function petMouseInteractive(region: PetMouseRegion, locked: boolean): boolean {
  return region === 'controls' || region === 'body' && !locked;
}
export type NativePetAction =
  | { readonly actionId: string; readonly snapshotRevision: number; readonly kind: 'open-task'; readonly taskId: string }
  | { readonly actionId: string; readonly snapshotRevision: number; readonly kind: 'open-settings' | 'open-licenses' | 'close-pet' };
export function parseNativePetAction(value: unknown, snapshotRevision: number): NativePetAction {
  const data = requireRecord(value); const actionId = requireId(data.actionId);
  if (actionId.length > 160 || data.snapshotRevision !== snapshotRevision) throw new ProtocolFault('cancelled');
  if (data.kind === 'open-task') {
    requireKeys(data, ['actionId', 'kind', 'snapshotRevision', 'taskId']);
    if (typeof data.taskId !== 'string' || data.taskId.length === 0 || data.taskId.length > 1024 || /[\u0000-\u001f\u007f]/u.test(data.taskId)) throw new ProtocolFault('protocol');
    return { actionId, kind: 'open-task', snapshotRevision, taskId: data.taskId };
  }
  requireKeys(data, ['actionId', 'kind', 'snapshotRevision']);
  if (data.kind !== 'open-settings' && data.kind !== 'open-licenses' && data.kind !== 'close-pet') throw new ProtocolFault('forbidden');
  return { actionId, kind: data.kind, snapshotRevision };
}
/** 此 bridge 仅绑定宠物本地主框架，不能读取文件、认证材料或提交会话输入。 */
export interface PetBridge {
  ready(): Promise<IpcResult<{ readonly config: PetViewConfig; readonly snapshot: PetViewSnapshot }>>;
  setMouseInteractive(region: PetMouseRegion): Promise<IpcResult<void>>;
  drag(input: PetDragRequest): Promise<IpcResult<boolean>>;
  action(input: NativePetAction): Promise<IpcResult<void>>;
  onDragEnded(listener: (gestureId: string) => void): () => void;
  onConfig(listener: (config: PetViewConfig) => void): () => void;
  onSnapshot(listener: (snapshot: PetViewSnapshot) => void): () => void;
}
