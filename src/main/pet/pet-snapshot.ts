import { countTasks, taskMood } from '../../shared/domain.js';
import type { TaskProjection } from '../../shared/domain.js';

import type { PetViewNotice, PetViewSnapshot } from '../../shared/pet-view.js';

export function petSnapshot(instanceId: string, generation: number, revision: number, tasks: readonly TaskProjection[], notification: PetViewNotice | null = null, now = Date.now()): PetViewSnapshot {
  const mood = taskMood(tasks); const primary = tasks.find(task => task.color === mood);
  return {
    protocolVersion: 1, instanceId, generation, revision, generatedAt: now,
    tasks: tasks.slice(0, 256).map(task => ({
      id: task.id, sessionId: task.sessionId, source: 'other', agentLabel: 'dsh', title: task.title.slice(0, 160),
      projectName: null, workspanId: null, paneId: null, daemonOnly: false, sessionAlive: task.freshness === 'fresh',
      color: task.color, updatedAt: now, viewedAt: null,
      pendingAction: null,
    })),
    counts: countTasks(tasks), mood, cliLabel: primary === undefined ? null : { agentLabel: 'dsh', color: primary.color, otherTaskCount: Math.max(0, tasks.length - 1) }, notification, diagnostics: [], truncated: tasks.length > 256,
  };
}
export function petSettings(enabled: boolean) {
  return { enabled, petId: null, size: 100, position: null, lockPosition: false, alwaysOnTop: true,
    soundEnabled: false, showStatus: true, showCliLabel: true, showTaskArea: true, openOnHover: true,
    autoHideFullscreen: true, notificationsEnabled: true, agentInteractionEnabled: false };
}
