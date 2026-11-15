import { ProtocolFault } from '../../shared/faults.js';

export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** 在官方 RPC 解码前分类 HTTP 与登录响应，并限制已解码正文大小。 */
export async function acceptRpcResponse(response: Response, maxBytes = MAX_RESPONSE_BYTES, onBytes?: (bytes: number) => void): Promise<Response> {
  let kind: ConstructorParameters<typeof ProtocolFault>[0] | undefined;
  if (response.status === 401) kind = 'auth-required';
  else if (response.status === 403) kind = 'forbidden';
  else if (response.status === 404) kind = 'not-found';
  else if (response.status >= 300 && response.status < 400) kind = 'login-response';
  else if (response.status === 413) kind = 'budget';
  else if (response.status === 408 || response.status === 504) kind = 'timeout';
  else if (!response.ok) kind = 'network';
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (kind === undefined && (mediaType === 'text/html' || mediaType === 'application/xhtml+xml')) kind = 'login-response';
  if (kind === undefined && mediaType !== 'application/json' && mediaType !== 'multipart/form-data') kind = 'protocol';
  if (kind !== undefined) {
    await response.body?.cancel().catch(() => {});
    throw new ProtocolFault(kind);
  }
  if (response.body === null) throw new ProtocolFault('protocol');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      onBytes?.(part.value.byteLength);
      if (size > maxBytes) throw new ProtocolFault('budget');
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error instanceof ProtocolFault ? error : new ProtocolFault('network');
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(bytes, { status: response.status, headers: response.headers });
}
