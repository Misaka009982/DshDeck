import { useEffect, useRef, useState } from 'react';
import type { ConversationView } from '../../shared/domain.js';
import type { FileDirectory, FilePreview, FileReadScope, FileWorkspace, ProjectFileEntry } from '../../shared/files.js';
import type { WorkbenchClientStore } from '../state/workbench-store.js';
import { cacheFileDirectory, FILE_TREE_LIMIT, FILE_TREE_PAGE, fileTreeRows } from './file-tree-model.js';
import { FileChangesPanel } from './FileChangesPanel.js';

interface Lease { readonly scope: FileReadScope; readonly active: () => boolean }
export function FilePanel({ view, store, available, onOpenOriginal }: { readonly view: ConversationView; readonly store: WorkbenchClientStore; readonly available: boolean; readonly onOpenOriginal: () => void }) {
  const [tab, setTab] = useState<'browse' | 'changes'>('browse');
  const [workspace, setWorkspace] = useState<FileWorkspace | null>(null);
  const [levels, setLevels] = useState<ReadonlyMap<string, FileDirectory>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState(''); const [query, setQuery] = useState(''); const [limit, setLimit] = useState(FILE_TREE_PAGE);
  const [preview, setPreview] = useState<FilePreview | null>(null); const [previewPath, setPreviewPath] = useState(''); const [previewBusy, setPreviewBusy] = useState(false); const [previewError, setPreviewError] = useState('');
  const lease = useRef<Lease | null>(null); const levelCache = useRef<ReadonlyMap<string, FileDirectory>>(new Map()); const loading = useRef(new Set<string>()); const previewEpoch = useRef(0);
  const closeLease = (): void => { const previous = lease.current; lease.current = null; if (previous !== null) void store.api.releaseFiles(previous.scope); };
  const loadDirectory = async (active: Lease, path: string): Promise<void> => {
    if (!active.active() || loading.current.has(path)) return;
    loading.current.add(path); setBusy(new Set(loading.current));
    try {
      const result = await store.api.fileDirectory({ ...active.scope, path });
      if (!active.active()) return;
      if (result.ok) { levelCache.current = cacheFileDirectory(levelCache.current, result.value); setLevels(levelCache.current); setError(''); }
      else setError(result.error.kind === 'cancelled' ? '本次文件读取已结束，可刷新文件面板。' : result.error.message);
    } catch { if (active.active()) setError('本地文件读取接口暂不可用。'); }
    finally { if (active.active()) { loading.current.delete(path); setBusy(new Set(loading.current)); } }
  };
  const start = (): void => {
    closeLease(); previewEpoch.current++; loading.current = new Set(); levelCache.current = new Map();
    setWorkspace(null); setLevels(levelCache.current); setExpanded(new Set()); setBusy(new Set()); setError(''); setPreview(null); setPreviewPath(''); setPreviewError(''); setPreviewBusy(false); setLimit(FILE_TREE_PAGE);
    if (!available) return;
    const active: Lease = { scope: { context: view.context, viewId: crypto.randomUUID() }, active: () => lease.current === active }; lease.current = active;
    void store.api.fileWorkspace(active.scope).then(async result => {
      if (!active.active()) return;
      if (!result.ok) { setError(result.error.message); return; }
      setWorkspace(result.value); if (result.value.available) await loadDirectory(active, '');
    }).catch(() => { if (active.active()) setError('本地工作区读取接口暂不可用。'); });
  };
  useEffect(() => { start(); return closeLease; }, [available, view.context.serverId, view.context.authProfileId, view.context.generation, view.context.sessionId, view.context.workspaceId, store]);
  const rows = fileTreeRows(levels, expanded, query, limit);
  const choose = (entry: ProjectFileEntry): void => {
    const active = lease.current; if (active === null || !available) return;
    if (entry.type === 'dir') {
      const next = new Set(expanded); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); setExpanded(next);
      if (next.has(entry.path) && !levelCache.current.has(entry.path)) void loadDirectory(active, entry.path);
      return;
    }
    const epoch = ++previewEpoch.current; setPreviewPath(entry.path); setPreview(null); setPreviewError(''); setPreviewBusy(true);
    void store.api.filePreview({ ...active.scope, path: entry.path }).then(result => {
      if (!active.active() || epoch !== previewEpoch.current) return;
      if (result.ok) setPreview(result.value); else setPreviewError(result.error.message);
    }).catch(() => { if (active.active() && epoch === previewEpoch.current) setPreviewError('本地文件预览接口暂不可用。'); })
      .finally(() => { if (active.active() && epoch === previewEpoch.current) setPreviewBusy(false); });
  };
  return <section className="native-files-panel" aria-label="原生只读项目文件与修改详情">
    <header className="native-files-toolbar"><div className="files-mode-buttons"><button type="button" aria-pressed={tab === 'browse'} onClick={() => setTab('browse')}>项目文件</button><button type="button" aria-pressed={tab === 'changes'} onClick={() => setTab('changes')}>修改详情</button></div>
      <span className="files-readonly-label">只读</span><button type="button" disabled={!available} onClick={start}>刷新目录</button><button type="button" onClick={onOpenOriginal}>原网页文件区</button>
    </header>
    {tab === 'changes' ? <FileChangesPanel view={view} store={store} onOpenOriginal={onOpenOriginal} /> : <>
      <div className="files-annotation">{workspace?.available ? <span title={workspace.workspace}>{workspace.workspace}</span> : '当前会话工作区'} · 目录按需展开，文件选中后才读取；不上传、不删除、不自动激活 Agent。</div>
      {!available ? <p className="files-empty">当前连接尚未就绪，暂停文件读取；修改详情仍可查看已有缓存。</p> : workspace !== null && !workspace.available ? <p className="files-empty">{workspace.message}</p> : workspace === null ? <div className="files-empty" role="status">{error || '正在读取会话工作区…'}</div> : <div className="files-split-view">
        <aside className="files-tree-pane" aria-label="项目文件树">
          <input className="files-search" value={query} onChange={event => { setQuery(event.target.value); setLimit(FILE_TREE_PAGE); }} placeholder="筛选已加载文件／路径" aria-label="筛选已加载文件和路径" />
          {error !== '' && <p className="files-local-error" role="status">{error}<button type="button" onClick={start}>重试目录</button></p>}
          {busy.size > 0 && <p className="files-annotation" role="status">正在读取 {busy.size} 个目录…</p>}
          {rows.rows.map(({ entry, depth }) => <div className="file-tree-item" key={entry.path}><button type="button" className={`file-tree-row ${entry.path === previewPath ? 'is-selected' : ''}`} style={{ paddingLeft: 10 + depth * 14 }} aria-expanded={entry.type === 'dir' ? expanded.has(entry.path) : undefined} onClick={() => choose(entry)} title={`${entry.path}${entry.size === null ? '' : ` · ${formatSize(entry.size)}`}`}>
            <span className="file-tree-glyph" aria-hidden="true">{entry.type === 'dir' ? expanded.has(entry.path) ? '▾' : '▸' : '·'}</span><span className="file-tree-name">{entry.type === 'dir' ? '▱ ' : ''}{query.trim() === '' ? entry.name : entry.path}</span><small>{entry.type === 'file' ? formatSize(entry.size) : ''}</small>
          </button>{entry.type === 'dir' && expanded.has(entry.path) && !levels.has(entry.path) && !busy.has(entry.path) && <button type="button" className="files-more" onClick={() => { const current = lease.current; if (current !== null) void loadDirectory(current, entry.path); }}>读取此目录</button>}</div>)}
          {levels.has('') && rows.rows.length === 0 && <p className="files-empty">{query.trim() === '' ? '目录为空。' : '已加载目录中没有匹配项；这不是整个工作区的搜索结果。'}</p>}
          {rows.more && (limit < FILE_TREE_LIMIT ? <button type="button" className="files-more" onClick={() => setLimit(value => value + FILE_TREE_PAGE)}>显示更多已加载项</button> : <p className="files-annotation">达到本机列表显示上限，请筛选路径或使用原网页。</p>)}
          {[...levels.values()].some(level => level.truncated) && <p className="files-annotation">部分目录达到插件的 5000 项上限，不能标为完整目录。</p>}
          {[...levels.values()].some(level => level.filtered) && <p className="files-annotation">已隐藏敏感路径。</p>}
        </aside>
        <section className="files-preview-pane" aria-label="文件只读预览">
          <header className="files-preview-header"><strong title={previewPath}>{previewPath || '文件预览'}</strong><small>{preview?.kind === 'text' ? formatSize(preview.bytes) : ''}</small></header>
          {previewBusy ? <p className="files-empty" role="status">正在读取所选文件…</p> : previewError !== '' ? <p className="files-empty" role="status">{previewError}</p> : preview === null ? <p className="files-empty">选择一个文件查看 UTF-8 文本或代码；图片、二进制与超大文件使用原网页查看。</p> : preview.kind === 'unavailable' ? <div className="files-empty">{preview.reason === 'large' ? '文件超过 512 KiB 预览预算，未下载正文。' : '不是受支持的 UTF-8 文本预览；不会执行或解码为 HTML。'}<button type="button" onClick={onOpenOriginal}>原网页查看</button></div> : <pre className="file-preview-text">{preview.text === '' ? '（空文件）' : preview.text}</pre>}
        </section>
      </div>}
    </>}
  </section>;
}
function formatSize(bytes: number | null): string { return bytes === null ? '' : bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1048576).toFixed(1)} MiB`; }
