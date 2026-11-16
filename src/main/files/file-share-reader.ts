import { FILE_JSON_BYTES, FILE_PREVIEW_BYTES, parseFileDirectory, parseFileWorkspace, requireFilePath } from '../../shared/files.js';
import type { FileDirectory, FilePreview, FileShareRequest, FileWorkspace } from '../../shared/files.js';
import { ProtocolFault, faultForAbort, requireId } from '../../shared/faults.js';

interface CachedDirectory { readonly sessionId: string; readonly value: FileDirectory; readonly at: number; readonly bytes: number }
type ReadFileShare = (request: FileShareRequest, signal: AbortSignal) => Promise<Response>;
const TEXT_SUFFIXES = new Set(['txt', 'md', 'markdown', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log', 'csv', 'tsv', 'xml', 'html', 'htm', 'css', 'scss', 'less', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'vue', 'svelte', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cc', 'sh', 'bash', 'zsh', 'fish', 'sql', 'ps1', 'bat', 'cmake', 'properties', 'gitignore', 'editorconfig', 'patch', 'diff']);

/** 按连接隔离的只读文件载体；目录缓存有界，正文仅在用户选文件后读取，不写磁盘。 */
export class FileShareReader {
  private readonly workspaces = new Map<string, { value: FileWorkspace; root: string | undefined }>();
  private readonly directories = new Map<string, CachedDirectory>();
  private active = 0;
  constructor(private readonly fetch: ReadFileShare, private readonly lifetime: AbortSignal, private readonly now: () => number = Date.now) {
    lifetime.addEventListener('abort', () => { this.workspaces.clear(); this.directories.clear(); }, { once: true });
  }
  async workspace(sessionId: string, signal: AbortSignal): Promise<FileWorkspace> {
    const id = requireId(sessionId);
    const value = await this.read({ operation: 'workspace', sessionId: id }, signal, async (response, active) => parseFileWorkspace(await readJson(response, active), id));
    const previous = this.workspaces.get(id);
    const same = previous?.value.available === true && value.available && previous.value.workspace === value.workspace;
    if (!same) this.clearSession(id);
    if (this.workspaces.size >= 32 && !this.workspaces.has(id)) this.clearSession(this.workspaces.keys().next().value ?? '');
    this.workspaces.set(id, { value, root: same ? previous?.root : undefined });
    return value;
  }
  async directory(sessionId: string, path: string, signal: AbortSignal): Promise<FileDirectory> {
    const id = requireId(sessionId); const checked = requireFilePath(path, true);
    this.check(signal);
    const workspace = this.workspaces.get(id)?.value ?? await this.workspace(id, signal);
    if (!workspace.available) throw new ProtocolFault('unsupported');
    const value = await this.read({ operation: 'directory', sessionId: id, path: checked }, signal,
      async (response, active) => parseFileDirectory(await readJson(response, active), checked));
    const current = this.workspaces.get(id);
    if (current === undefined || !current.value.available || current.value.workspace !== workspace.workspace) throw new ProtocolFault('cancelled');
    if (current.root !== undefined && current.root !== value.root) { this.clearSession(id); throw new ProtocolFault('conflict'); }
    current.root = value.root;
    const key = JSON.stringify([id, checked]); this.directories.delete(key);
    this.directories.set(key, { sessionId: id, value, at: this.now(), bytes: Buffer.byteLength(JSON.stringify(value), 'utf8') });
    let bytes = [...this.directories.values()].reduce((sum, item) => sum + item.bytes, 0);
    while (this.directories.size > 32 || bytes > FILE_JSON_BYTES) {
      const oldest = this.directories.keys().next().value; if (oldest === undefined) break;
      bytes -= this.directories.get(oldest)?.bytes ?? 0; this.directories.delete(oldest);
    }
    return value;
  }
  async preview(sessionId: string, path: string, signal: AbortSignal): Promise<FilePreview> {
    const id = requireId(sessionId); const checked = requireFilePath(path); this.check(signal);
    const parent = checked.includes('/') ? checked.slice(0, checked.lastIndexOf('/')) : '';
    const cached = this.directories.get(JSON.stringify([id, parent]));
    const age = cached === undefined ? Infinity : this.now() - cached.at;
    const directory = cached !== undefined && age >= 0 && age < 30000 ? cached.value : await this.directory(id, parent, signal);
    const entry = directory.entries.find(item => item.path === checked && item.type === 'file');
    if (entry === undefined) throw new ProtocolFault('not-found');
    if (entry.size !== null && entry.size > FILE_PREVIEW_BYTES) return { kind: 'unavailable', path: checked, reason: 'large', bytes: entry.size };
    const suffix = entry.name.includes('.') ? entry.name.slice(entry.name.lastIndexOf('.') + 1).toLowerCase() : '';
    if (suffix !== '' && !TEXT_SUFFIXES.has(suffix)) return { kind: 'unavailable', path: checked, reason: 'binary', bytes: entry.size };
    return this.read({ operation: 'preview', sessionId: id, path: checked }, signal, async (response, active) => {
      if (!/^attachment(?:;|$)/iu.test(response.headers.get('content-disposition') ?? '')) { void response.body?.cancel().catch(() => {}); throw new ProtocolFault('login-response'); }
      const bytes = await readBytes(response, active, FILE_PREVIEW_BYTES);
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { return { kind: 'unavailable', path: checked, reason: 'binary', bytes: bytes.byteLength } as const; }
      if (text.includes('\0')) return { kind: 'unavailable', path: checked, reason: 'binary', bytes: bytes.byteLength } as const;
      return { kind: 'text', path: checked, text, bytes: bytes.byteLength, modifiedAt: entry.modifiedAt } as const;
    });
  }
  private async read<T>(request: FileShareRequest, signal: AbortSignal, consume: (response: Response, signal: AbortSignal) => Promise<T>): Promise<T> {
    this.check(signal);
    if (this.active >= 4) throw new ProtocolFault('budget');
    this.active++;
    const active = AbortSignal.any([this.lifetime, signal, AbortSignal.timeout(15000)]);
    try {
      const response = await this.fetch(request, active);
      let kind: ConstructorParameters<typeof ProtocolFault>[0] | undefined;
      if (response.status === 401) kind = 'auth-required';
      else if (response.status === 403) kind = 'forbidden';
      else if (response.status === 404) kind = 'not-found';
      else if (response.status === 413) kind = 'budget';
      else if (response.status === 408 || response.status === 504) kind = 'timeout';
      else if (response.status >= 300 && response.status < 400) kind = 'login-response';
      else if (!response.ok) kind = 'network';
      if (kind !== undefined) { void response.body?.cancel().catch(() => {}); throw new ProtocolFault(kind); }
      const value = await consume(response, active);
      if (active.aborted) throw faultForAbort(active);
      return value;
    } catch (error) {
      throw active.aborted ? faultForAbort(active) : error instanceof ProtocolFault ? error : new ProtocolFault('network');
    } finally { this.active--; }
  }
  private check(signal: AbortSignal): void { if (this.lifetime.aborted) throw faultForAbort(this.lifetime); if (signal.aborted) throw faultForAbort(signal); }
  private clearSession(sessionId: string): void {
    this.workspaces.delete(sessionId);
    for (const [key, entry] of this.directories) if (entry.sessionId === sessionId) this.directories.delete(key);
  }
}
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const type = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (type !== 'application/json') { void response.body?.cancel().catch(() => {}); throw new ProtocolFault(type === 'text/html' ? 'login-response' : 'protocol'); }
  const bytes = await readBytes(response, signal, FILE_JSON_BYTES);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new ProtocolFault('protocol'); }
}
async function readBytes(response: Response, signal: AbortSignal, maximum: number): Promise<Uint8Array> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximum)) {
    void response.body?.cancel().catch(() => {}); throw new ProtocolFault(/^\d+$/u.test(length) ? 'budget' : 'protocol');
  }
  if (signal.aborted) { void response.body?.cancel().catch(() => {}); throw faultForAbort(signal); }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  const abort = (): void => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw faultForAbort(signal);
      const part = await reader.read();
      if (signal.aborted) throw faultForAbort(signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) throw new ProtocolFault('budget');
      chunks.push(part.value);
    }
  } catch (error) { abort(); throw error; }
  finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
