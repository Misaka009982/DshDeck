import { Context } from '@deepseek-ai/cordis';
import { installConnection } from '@deepseek-ai/dsh-client-connection/client';
import type { ClientConnectionRpc, ConnectionHandle, RpcFetch } from '@deepseek-ai/dsh-client-connection/client';
import { ProtocolFault, faultForAbort, remoteFault } from '../../shared/faults.js';
import { acceptRpcResponse, MAX_RESPONSE_BYTES } from './http-response.js';
import { assertReadRequest } from './read-policy.js';
import type { ReadRequest } from './read-policy.js';

/** 只安装官方 Connection RPC 句柄，不启动恢复控制器、Host 或 Agent 插件。 */
export class ReadOnlyRpc {
  private readonly rpc: ClientConnectionRpc;
  private readonly lifetime = new AbortController();

  constructor(fetch: RpcFetch, onHttpBytes?: (bytes: number) => void) {
    const context = new Context();
    installConnection(context, {
      interactions: 'none',
      transport: {
        fetch: async (input, init) => {
          let response: Response;
          try { response = await fetch(input, init); }
          catch (error) {
            if (this.lifetime.signal.aborted) throw faultForAbort(this.lifetime.signal);
            if (init.signal?.aborted) throw faultForAbort(init.signal);
            throw error instanceof ProtocolFault ? error : new ProtocolFault('network');
          }
          return acceptRpcResponse(response, MAX_RESPONSE_BYTES, onHttpBytes);
        },
      },
    });
    const connection = context.get('connection') as ConnectionHandle | undefined;
    if (connection === undefined) throw new ProtocolFault('unsupported');
    this.rpc = connection.rpc;
  }

  async call(request: ReadRequest, signal?: AbortSignal): Promise<unknown> {
    assertReadRequest(request);
    const combined = signal === undefined ? this.lifetime.signal : AbortSignal.any([this.lifetime.signal, signal]);
    if (combined.aborted) throw faultForAbort(combined);
    try {
      const result = await this.rpc.call('/api', request.endpoint, request.payload, combined);
      if (combined.aborted) throw faultForAbort(combined);
      if (!result.ok) throw remoteFault(result.error.code);
      return result.value;
    } catch (error) {
      if (combined.aborted) throw faultForAbort(combined);
      // 官方解码器可能含远程字段的错误文字不能传给 UI 或日志。
      throw error instanceof ProtocolFault ? error : new ProtocolFault('protocol');
    }
  }

  dispose(): void {
    this.lifetime.abort();
  }
}
