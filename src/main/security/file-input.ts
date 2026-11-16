import { parseContext } from '../../shared/domain.js';
import { ProtocolFault, requireKeys, requireRecord } from '../../shared/faults.js';
import { requireFilePath } from '../../shared/files.js';
import type { FilePathRead, FileReadScope } from '../../shared/files.js';

/** viewId 是文件面板生命周期，不是任意 URL 或后台会话读取权限。 */
function readScope(data: Record<string, unknown>): FileReadScope {
  if (typeof data.viewId !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(data.viewId)) throw new ProtocolFault('protocol');
  return { context: parseContext(data.context), viewId: data.viewId };
}
export function parseFileReadScope(value: unknown): FileReadScope {
  const data = requireRecord(value); requireKeys(data, ['context', 'viewId']); return readScope(data);
}
export function parseFilePathRead(value: unknown, directory = false): FilePathRead {
  const data = requireRecord(value); requireKeys(data, ['context', 'viewId', 'path']);
  return { ...readScope(data), path: requireFilePath(data.path, directory) };
}
