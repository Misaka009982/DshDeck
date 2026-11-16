import { useMemo, useState } from 'react';
import type { ConversationView } from '../../shared/domain.js';
import type { RecordedFileChange } from './file-change-model.js';
import { recordedFileChanges } from './file-change-model.js';
import type { WorkbenchClientStore } from '../state/workbench-store.js';

export function FileChangesPanel({ view, store, onOpenOriginal }: { readonly view: ConversationView; readonly store: WorkbenchClientStore; readonly onOpenOriginal: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const result = useMemo(() => recordedFileChanges(view.events), [view.events]);
  const selected = result.changes.find(change => change.id === selectedId) ?? result.changes[0];
  return <div className="native-files-content">
    <div className="files-annotation">来自当前会话已加载的工具修改记录，不是实时 Git diff，也不是整文件快照。{view.hasGap ? '缓存存在缺口。' : ''}{result.omitted ? '部分记录未展示，可使用原网页核对。' : ''}{result.filtered ? '已隐藏敏感路径。' : ''}</div>
    <div className="files-split-view">
      <aside className="files-tree-pane" aria-label="已记录的修改">
        {result.changes.map(change => <button type="button" key={change.id} className={`file-change-row ${selected?.id === change.id ? 'is-selected' : ''}`} aria-pressed={selected?.id === change.id} onClick={() => setSelectedId(change.id)} title={change.path}>
          <span>{change.path}</span><small>#{change.seq}{change.stopped ? ' · 中途停止' : ' · 已记录'}</small>
        </button>)}
        {result.changes.length === 0 && <p className="files-empty">当前缓存没有有效的已应用修改片段；准备修改的参数不会算作修改结果。</p>}
        {view.hasMore && <button type="button" className="files-more" onClick={() => { void store.action(store.api.loadOlder(view.context)); }}>读取更早的会话记录</button>}
      </aside>
      <section className="files-preview-pane" aria-label="修改详情">{selected === undefined ? <p className="files-empty">选择一条修改查看详情；原网页可核对未适配的插件记录。</p> : <RecordedDiff change={selected} onOpenOriginal={onOpenOriginal} />}</section>
    </div>
  </div>;
}
function RecordedDiff({ change, onOpenOriginal }: { readonly change: RecordedFileChange; readonly onOpenOriginal: () => void }) {
  return <>
    <header className="files-preview-header"><strong title={change.path}>{change.path}</strong><small>事件 #{change.seq}{change.stopped ? ' · 仅部分结果' : ''}</small></header>
    {change.unavailable ? <div className="files-empty">这条修改超过本机展示预算，未截断成完整结果。<button type="button" onClick={onOpenOriginal}>原网页查看</button></div> : <>
      <p className="files-annotation">显示服务器记录的修改片段；未提供旧内容时，不能据此判断新建、完整覆盖或全部变更。</p>
      <div className="file-diff-columns">
        <section className="file-diff-before"><h3>修改前</h3>{change.oldText === null ? <p className="files-empty">未提供修改前内容。</p> : <pre>{change.oldText === '' ? '（空内容）' : change.oldText}</pre>}</section>
        <section className="file-diff-after"><h3>修改后</h3><pre>{change.newText === '' ? '（空内容）' : change.newText}</pre></section>
      </div>
    </>}
  </>;
}
