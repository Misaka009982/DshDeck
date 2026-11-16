import { ProtocolFault, requireId, requireKeys, requireRecord } from './faults.js';
import type { SessionContext } from './domain.js';

export interface FileReadScope { readonly context: SessionContext; readonly viewId: string }
export interface FilePathRead extends FileReadScope { readonly path: string }

/** 只复用 dsh-file-share 0.3.5 的只读契约，不复制插件实现或开放写入。 */
export type FileShareRequest = { readonly operation: 'workspace'; readonly sessionId: string }
  | { readonly operation: 'directory' | 'preview'; readonly sessionId: string; readonly path: string };
export type FileWorkspace = { readonly available: true; readonly workspace: string }
  | { readonly available: false; readonly message: string };
export interface ProjectFileEntry {
  readonly name: string;
  readonly path: string;
  readonly type: 'dir' | 'file';
  readonly size: number | null;
  readonly modifiedAt: number;
}
export interface FileDirectory {
  readonly root: string;
  readonly directory: string;
  readonly entries: readonly ProjectFileEntry[];
  readonly truncated: boolean;
  readonly filtered: boolean;
}
export type FilePreview = { readonly kind: 'text'; readonly path: string; readonly text: string; readonly bytes: number; readonly modifiedAt: number }
  | { readonly kind: 'unavailable'; readonly path: string; readonly reason: 'large' | 'binary'; readonly bytes: number | null };
export const FILE_LIST_LIMIT = 5000;
export const FILE_JSON_BYTES = 2 * 1024 * 1024;
export const FILE_PREVIEW_BYTES = 512 * 1024;

const PRIVATE_NAMES = new Set(['.git', '.svn', '.hg', '.bzr', 'node_modules', '.netrc', '.ssh', '.aws', '.dsh', '.trash',
  '.npmrc', '.pypirc', '.dockercfg', 'id_rsa', 'id_ed25519', 'auth.json', 'secrets.json', 'secrets.yaml', 'secrets.yml']);
export function sensitiveFileName(value: string): boolean {
  const name = value.toLowerCase();
  return PRIVATE_NAMES.has(name) || name === '.env' || name.startsWith('.env.')
    || /\.(?:pem|key|pfx|p12)$/u.test(name) || /^creds?.*\.(?:yaml|yml|json|txt)$/u.test(name);
}
/** Windows 客户端也按服务器相对路径处理；不把反斜线、盘符或越界路径改写成合法路径。 */
export function requireFilePath(value: unknown, allowRoot = false): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f\\:]/u.test(value)) throw new ProtocolFault('forbidden');
  if (value === '' && allowRoot) return value;
  const parts = value.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..' || part.length > 256 || sensitiveFileName(part))) throw new ProtocolFault('forbidden');
  return value;
}
export function fileShareUrl(baseUrl: string, value: FileShareRequest): URL {
  const request = requireRecord(value);
  const workspace = request.operation === 'workspace';
  if (!workspace && request.operation !== 'directory' && request.operation !== 'preview') throw new ProtocolFault('unsupported');
  requireKeys(request, workspace ? ['operation', 'sessionId'] : ['operation', 'sessionId', 'path']);
  const endpoint = workspace ? 'status' : request.operation === 'directory' ? 'list' : 'download';
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' && base.protocol !== 'https:' || base.username !== '' || base.password !== '' || base.search !== '' || base.hash !== '') throw new ProtocolFault('forbidden');
  const url = new URL(`dsh-file-share/api/${endpoint}`, base);
  url.searchParams.set('sessionId', requireId(request.sessionId));
  if (!workspace) url.searchParams.set('path', requireFilePath(request.path, request.operation === 'directory'));
  if (url.href.length > 16384) throw new ProtocolFault('budget');
  return url;
}
export function parseFileWorkspace(value: unknown, sessionId: string): FileWorkspace {
  const data = requireRecord(value);
  if (data.ok === false) {
    requireKeys(data, ['ok', 'error']);
    return { available: false, message: '文件插件未取得当前会话的工作区。请先在原网页打开该会话并确认插件版本；不会自动激活休眠 Agent。' };
  }
  requireKeys(data, ['ok', 'sessionId', 'workspace', 'readOnly', 'hideSensitive']);
  if (data.ok !== true || data.sessionId !== sessionId || typeof data.readOnly !== 'boolean' || typeof data.hideSensitive !== 'boolean') throw new ProtocolFault('protocol');
  return { available: true, workspace: metadataPath(data.workspace) };
}
export function parseFileDirectory(value: unknown, directory: string): FileDirectory {
  const checked = requireFilePath(directory, true);
  const data = requireRecord(value); requireKeys(data, ['root', 'dir', 'entries']);
  if (data.dir !== checked || !Array.isArray(data.entries)) throw new ProtocolFault('protocol');
  if (data.entries.length > FILE_LIST_LIMIT) throw new ProtocolFault('budget');
  const root = metadataPath(data.root); const encoder = new TextEncoder();
  let outputBytes = encoder.encode(JSON.stringify({ root, directory: checked, entries: [], truncated: false, filtered: false })).byteLength;
  const names = new Set<string>(); const entries: ProjectFileEntry[] = []; let filtered = false;
  for (const item of data.entries) {
    const entry = requireRecord(item); requireKeys(entry, ['name', 'type', 'size', 'mtime']);
    const name = requireId(entry.name);
    if (name.includes('/') || name === '.' || name === '..' || /[\\:]/u.test(name) || names.has(name)) throw new ProtocolFault('protocol');
    names.add(name);
    if (sensitiveFileName(name)) { filtered = true; continue; }
    const path = requireFilePath(checked === '' ? name : `${checked}/${name}`);
    if (entry.type !== 'dir' && entry.type !== 'file' || typeof entry.mtime !== 'number' || !Number.isSafeInteger(entry.mtime) || entry.mtime < 0
      || entry.size !== null && (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0)) throw new ProtocolFault('protocol');
    const projected: ProjectFileEntry = { name, path, type: entry.type, size: entry.type === 'dir' ? null : entry.size as number | null, modifiedAt: entry.mtime };
    outputBytes += encoder.encode(JSON.stringify(projected)).byteLength + 1;
    if (outputBytes > FILE_JSON_BYTES) throw new ProtocolFault('budget');
    entries.push(projected);
  }
  entries.sort((left, right) => left.type === right.type ? left.name.localeCompare(right.name, 'zh-CN') : left.type === 'dir' ? -1 : 1);
  return { root, directory: checked, entries, truncated: data.entries.length === FILE_LIST_LIMIT, filtered };
}
function metadataPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) throw new ProtocolFault('protocol');
  return value;
}
