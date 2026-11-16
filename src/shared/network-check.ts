import type { PublicFailure } from './faults.js';

/** 仅报告本机应用到保存入口的线路；HTTP 响应不等于 dsh RPC/WS 已授权。 */
export type NetworkCheckStep = { readonly state: 'open'; readonly elapsedMs: number }
  | { readonly state: 'response'; readonly elapsedMs: number; readonly httpStatus: number }
  | { readonly state: 'failed'; readonly elapsedMs: number; readonly failure: PublicFailure; readonly networkCode?: string }
  | { readonly state: 'skipped'; readonly elapsedMs: 0; readonly reason: 'proxy' };
export interface NetworkCheckReport {
  readonly checkedAt: number;
  readonly proxyMode: 'direct' | 'configured';
  readonly tcp: NetworkCheckStep;
  readonly http: NetworkCheckStep;
  readonly conclusion: 'http-reachable' | 'http-layer' | 'route-or-process' | 'proxy-managed';
}
