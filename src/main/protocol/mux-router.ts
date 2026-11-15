import type { RemoteStreamServerMessage } from '@deepseek-ai/dsh-api-gateway/stream-protocol';
import { ProtocolFault } from '../../shared/faults.js';

interface Registration {
  readonly generation: number;
  readonly listener: (frame: RemoteStreamServerMessage) => void;
}

/** 只分派当前代次的逻辑流；不从 ready 帧推导整个服务器的授权。 */
export class MuxRouter {
  private generation = 0;
  private readonly streams = new Map<string, Registration>();

  beginGeneration(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation <= this.generation) throw new ProtocolFault('protocol');
    this.generation = generation;
    this.streams.clear();
  }

  register(streamId: string, generation: number, listener: Registration['listener']): () => void {
    if (streamId.length === 0 || generation !== this.generation || this.streams.has(streamId)) throw new ProtocolFault('protocol');
    const registration = { generation, listener };
    this.streams.set(streamId, registration);
    return () => {
      if (this.streams.get(streamId) === registration) this.streams.delete(streamId);
    };
  }

  dispatch(frame: RemoteStreamServerMessage, generation: number): boolean {
    if (generation !== this.generation) return false;
    const registration = this.streams.get(frame.streamId);
    if (registration === undefined || registration.generation !== generation) return false;
    if (frame.type === 'error' || frame.type === 'end') this.streams.delete(frame.streamId);
    registration.listener(frame);
    return true;
  }
}
