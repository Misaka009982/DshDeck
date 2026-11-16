import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionContext } from '../../shared/domain.js';
import { currentModel } from '../../shared/native-controls.js';
import type { CatalogModel, ModelCatalog, ModelSelection, NativeSnapshot } from '../../shared/native-controls.js';
import type { WorkbenchClientStore } from '../state/workbench-store.js';

interface Props { readonly context: SessionContext; readonly native: NativeSnapshot | undefined; readonly store: WorkbenchClientStore; readonly disabled: boolean; readonly open: boolean; readonly setOpen: (open: boolean) => void }
export function ModelSelector({ context, native, store, disabled, open, setOpen }: Props) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [loading, setLoading] = useState(false); const [selecting, setSelecting] = useState(false);
  const [query, setQuery] = useState(''); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const alive = useRef(true); const root = useRef<HTMLDivElement>(null);
  const action = useRef<{ signature: string; id: string } | null>(null);
  const selected = currentModel(native?.values, catalog);
  const chosen = catalog?.groups.find(group => group.id === selected?.provider)?.models.find(model => model.id === selected?.model);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = (refresh = false): void => {
    if (disabled || loading) return;
    setLoading(true); setError('');
    void store.api.modelCatalog(context, refresh).then(result => {
      if (!alive.current) return;
      if (result.ok) setCatalog(result.value); else setError(`模型目录暂不可用（${result.error.kind}）；可重试或使用原网页。`);
    }).finally(() => { if (alive.current) setLoading(false); });
  };
  useEffect(() => { if (!disabled && catalog === null) load(); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    load();
    const close = (event: PointerEvent): void => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', close); window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', escape); };
  }, [open]);
  const rows = useMemo(() => {
    const filter = query.trim().toLocaleLowerCase();
    return (catalog?.groups ?? []).flatMap(group => group.models.map(model => ({ provider: group.id, providerName: group.name, model })))
      .filter(row => filter === '' || `${row.providerName} ${row.model.name} ${row.model.id}`.toLocaleLowerCase().includes(filter)).slice(0, 200);
  }, [catalog, query]);
  const choose = (selection: ModelSelection): void => {
    if (disabled || selecting) return;
    const signature = JSON.stringify(selection);
    const previous = action.current; const request = previous !== null && previous.signature === signature ? previous : { signature, id: crypto.randomUUID() };
    action.current = request; const requestId = request.id;
    setSelecting(true); setError(''); setNotice('');
    void store.api.selectModel({ context: { ...context }, requestId, selection }).then(result => {
      if (!alive.current) return;
      if (result.ok) { action.current = null; setNotice('服务器已接受选择；当前模型以随后的会话状态为准。'); setOpen(false); }
      else setError(result.error.kind === 'uncertain' || ['network', 'timeout'].includes(result.error.kind)
        ? '模型切换结果未知；不会自动重发，请先同步会话核实。' : `模型切换未完成（${result.error.kind}）；原选择保留。`);
      void store.refresh();
    }).finally(() => { if (alive.current) setSelecting(false); });
  };
  const pick = (provider: string, model: CatalogModel): void => {
    const same = selected?.provider === provider && selected.model === model.id;
    const effort = same ? selected?.reasoningEffort ?? model.reasoning?.defaultEffort : model.reasoning?.defaultEffort;
    choose({ provider, model: model.id, ...(effort === undefined ? {} : { reasoningEffort: effort }) });
  };
  return <div className="model-selector" ref={root}>
    <button type="button" className="composer-option" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)} disabled={disabled || selecting}
      title={selected === null ? '模型尚未取得；不使用固定假模型' : `${selected.provider} / ${selected.model}`}>{selecting ? '切换模型中…' : chosen?.name ?? selected?.model ?? (loading ? '读取模型…' : '选择模型')} <span aria-hidden="true">⌄</span></button>
    {chosen?.reasoning !== undefined && chosen.reasoning.efforts.length > 0 && selected !== null && <select className="reasoning-select" aria-label="模型思考档位" disabled={disabled || selecting}
      value={selected.reasoningEffort ?? chosen.reasoning.defaultEffort ?? ''} onChange={event => choose({ provider: selected.provider, model: selected.model, ...(event.target.value === '' ? {} : { reasoningEffort: event.target.value }) })}>
      <option value="">提供方默认</option>{selected.reasoningEffort !== undefined && !chosen.reasoning.efforts.some(effort => effort.id === selected.reasoningEffort) && <option value={selected.reasoningEffort} disabled>已保存档位：{selected.reasoningEffort}</option>}{chosen.reasoning.efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
    </select>}
    {open && <div className="native-popover model-popover" role="dialog" aria-label="选择会话模型">
      <header><strong>模型</strong><button type="button" onClick={() => load(true)} disabled={loading || selecting}>重读目录</button></header>
      <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索模型或提供方" aria-label="搜索模型" autoFocus />
      {loading && catalog === null && <p className="muted">正在读取服务器模型目录…</p>}
      <div className="model-options" role="list">{rows.map(row => <button type="button" role="listitem" key={JSON.stringify([row.provider, row.model.id])} className={selected?.provider === row.provider && selected.model === row.model.id ? 'is-current' : ''}
        disabled={selecting || disabled || !catalog?.routableProviders.includes(row.provider)} onClick={() => pick(row.provider, row.model)}>
        <span>{row.model.name}</span><small>{row.providerName}{row.model.description === undefined ? '' : ` · ${row.model.description}`}</small>
      </button>)}</div>
      {catalog !== null && !loading && rows.length === 0 && <p className="muted">没有可用匹配模型；不会自动切到其他提供方。</p>}
      {rows.length === 200 && <p className="muted">列表最多显示 200 项，可继续搜索。</p>}
      {catalog?.failures.map(failure => <p className="native-field-warning" key={failure.id}>{failure.name}：{failure.message}</p>)}
      <p className="muted">这里只切换当前会话模型；提供方认证与权限配置仍在原网页完成。</p>
    </div>}
    {error !== '' && <span className="native-control-error" role="status" title={error}>{error}</span>}
    {notice !== '' && <span className="native-control-notice" role="status" title={notice}>选择已接受</span>}
  </div>;
}
