import { Context } from '@deepseek-ai/cordis';
import { installConnection } from '@deepseek-ai/dsh-client-connection/client';
import type { ClientConnectionRpc, ConnectionHandle, RpcFetch } from '@deepseek-ai/dsh-client-connection/client';
import { ProtocolFault, remoteFault } from '../../shared/faults.js';
import { assertBusinessRequest } from './business-policy.js';
import type { BusinessRequest } from './business-policy.js';
import { acceptRpcResponse, MAX_RESPONSE_BYTES } from './http-response.js';

/** 请求关联和 multipart 复用官方实现；此句柄不会自动重试写操作。 */
export class RemoteRpc {
  private readonly rpc: ClientConnectionRpc;
  private readonly lifetime = new AbortController();
  constructor(fetch: RpcFetch, private readonly onBytes: (bytes: number) => void = () => {}) {
    const context = new Context();
    installConnection(context, { interactions: 'none', transport: { fetch: async (input, init) => {
      let response: Response;
      try { response = await fetch(input, init); }
      catch (error) {
        if (this.lifetime.signal.aborted || init.signal?.aborted) throw new ProtocolFault('cancelled');
        throw error instanceof ProtocolFault ? error : new ProtocolFault('network');
      }
      return acceptRpcResponse(response, MAX_RESPONSE_BYTES, this.onBytes);
    } } });
    const connection = context.get('connection') as ConnectionHandle | undefined;
    if (connection === undefined) throw new ProtocolFault('unsupported');
    this.rpc = connection.rpc;
  }
  async call(request: BusinessRequest, signal: AbortSignal): Promise<unknown> {
    assertBusinessRequest(request);
    const combined = AbortSignal.any([this.lifetime.signal, signal]);
    if (combined.aborted) throw new ProtocolFault('cancelled');
    try {
      const result = await this.rpc.call('/api', request.endpoint, request.payload, combined);
      if (combined.aborted) throw new ProtocolFault('cancelled');
      if (!result.ok) throw remoteFault(result.error.code);
      return result.value;
    } catch (error) {
      if (combined.aborted) throw new ProtocolFault('cancelled');
      throw error instanceof ProtocolFault ? error : new ProtocolFault('protocol');
    }
  }
  dispose(): void { this.lifetime.abort(); }
}
