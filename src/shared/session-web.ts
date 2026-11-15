import type { SessionContext } from './domain.js';
import { parseContext } from './domain.js';
import { ProtocolFault, requireId, requireKeys, requireRecord } from './faults.js';

export interface WebViewport { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly visible: boolean }
export interface SessionWebState {
  readonly state: 'closed' | 'loading' | 'ready' | 'failed';
  readonly serverId: string | null;
  readonly context: SessionContext | null;
  readonly dark: boolean;
  readonly message: string;
}
export interface WebPageState { readonly sessionId: string | null; readonly ready: boolean; readonly dark: boolean }
export const DSH_CURRENT_SESSION_KEY = 'dsh.sessions.current';
export function parseWebViewport(value: unknown): WebViewport {
  const viewport = requireRecord(value); requireKeys(viewport, ['x', 'y', 'width', 'height', 'visible']);
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const number = viewport[key]; if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0 || number > 32768) throw new ProtocolFault('protocol');
  }
  if (typeof viewport.visible !== 'boolean') throw new ProtocolFault('protocol');
  return { x: viewport.x as number, y: viewport.y as number, width: viewport.width as number, height: viewport.height as number, visible: viewport.visible };
}
export function parseWebPageState(value: unknown): WebPageState {
  const data = requireRecord(value); requireKeys(data, ['sessionId', 'ready', 'dark']);
  if (typeof data.ready !== 'boolean' || typeof data.dark !== 'boolean') throw new ProtocolFault('protocol');
  return { sessionId: data.sessionId === null ? null : requireId(data.sessionId), ready: data.ready, dark: data.dark };
}
export function webTargetArgument(baseUrl: string, context: SessionContext | null, parentSessionId?: string): string {
  const url = new URL(baseUrl);
  const target = context === null ? null : { sessionId: parseContext(context).sessionId,
    ...(parentSessionId === undefined ? {} : { subagentAddress: { parentSessionId: requireId(parentSessionId), childSessionId: context.sessionId, mode: 'unknown' } }) };
  return `--dshdeck-web-target=${encodeURIComponent(JSON.stringify({ origin: url.origin, path: url.pathname, target }))}`;
}
export function sameWebContext(left: SessionContext | null, right: SessionContext | null): boolean {
  return left !== null && right !== null && left.serverId === right.serverId && left.authProfileId === right.authProfileId && left.generation === right.generation && left.sessionId === right.sessionId && left.workspaceId === right.workspaceId;
}
