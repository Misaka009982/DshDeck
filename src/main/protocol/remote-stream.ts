import { REMOTE_EVENT_STREAM_ENDPOINT, REMOTE_EVENT_STREAM_PAYLOAD } from '@deepseek-ai/dsh-api-gateway/stream-protocol';
import type { ProtocolFault } from '../../shared/faults.js';
import { ReadOnlyMux } from './read-only-mux.js';
import type { ReadSubscription } from './read-only-mux.js';

/** 共享同一物理 WS；仅工作台显式开放事件接管，PoC 保持原只读类。 */
export class RemoteMux extends ReadOnlyMux {
  events(item: (value: unknown) => void, failed: (fault: ProtocolFault) => void): ReadSubscription {
    return this.subscribeTrusted({ endpoint: REMOTE_EVENT_STREAM_ENDPOINT, payload: REMOTE_EVENT_STREAM_PAYLOAD }, 'state', item, failed);
  }
}
