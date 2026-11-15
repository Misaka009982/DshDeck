import { countTasks, taskMood } from '../../shared/domain.js';
import type { TaskProjection } from '../../shared/domain.js';

export function petSnapshot(instanceId: string, generation: number, revision: number, tasks: readonly TaskProjection[], notification: unknown = null, now = Date.now()) {
  return {
    protocolVersion: 1, instanceId, generation, revision, generatedAt: now,
    tasks: tasks.map(task => ({
      id: task.id, sessionId: task.sessionId, source: 'other', agentLabel: 'dsh', title: task.title.slice(0, 160),
      projectName: null, workspanId: null, paneId: null, daemonOnly: false, sessionAlive: task.freshness === 'fresh',
      color: task.color, updatedAt: now, viewedAt: null,
      pendingAction: null,
    })),
    counts: countTasks(tasks), mood: taskMood(tasks), cliLabel: null, notification, diagnostics: [],
  };
}
export function petSettings(enabled: boolean) {
  return { enabled, petId: null, size: 100, position: null, lockPosition: false, alwaysOnTop: true,
    soundEnabled: false, showStatus: true, showCliLabel: true, showTaskArea: true, openOnHover: true,
    autoHideFullscreen: true, notificationsEnabled: true, agentInteractionEnabled: false };
}
