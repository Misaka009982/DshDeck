import { Context } from '@deepseek-ai/cordis';
import { installConnection } from '@deepseek-ai/dsh-client-connection/client';
import type { ClientConnectionRpc, ConnectionHandle, RpcFetch } from '@deepseek-ai/dsh-client-connection/client';
import { ProtocolFault, remoteFault } from '../../shared/faults.js';
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
            if (this.lifetime.signal.aborted || init.signal?.aborted) throw new ProtocolFault('cancelled');
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
    if (this.lifetime.signal.aborted || signal?.aborted) throw new ProtocolFault('cancelled');
    const combined = signal === undefined ? this.lifetime.signal : AbortSignal.any([this.lifetime.signal, signal]);
    try {
      const result = await this.rpc.call('/api', request.endpoint, request.payload, combined);
      if (combined.aborted) throw new ProtocolFault('cancelled');
      if (!result.ok) throw remoteFault(result.error.code);
      return result.value;
    } catch (error) {
      if (combined.aborted) throw new ProtocolFault('cancelled');
      // 官方解码器可能含远程字段的错误文字不能传给 UI 或日志。
      throw error instanceof ProtocolFault ? error : new ProtocolFault('protocol');
    }
  }

  dispose(): void {
    this.lifetime.abort();
  }
}
