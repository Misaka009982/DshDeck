import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ConversationView } from '../../shared/domain.js';
import type { JobPanelSnapshot, JobRow } from '../../shared/jobs.js';
import { isLiveJob, observableJob } from '../../shared/jobs.js';
import type { WorkbenchClientStore } from '../state/workbench-store.js';
import { WorkbenchIcon } from '../ui/WorkbenchIcon.js';
import { jobDuration, jobOutputStateLabel, jobOutputText, jobStatusLabel, mergeJobOutput, orderedJobs } from './job-view-model.js';
import type { DisplayJobOutput } from './job-view-model.js';

interface Props { readonly view: ConversationView; readonly store: WorkbenchClientStore; readonly available: boolean; readonly overlayOpen: boolean }
export function BackgroundJobPanel({ view, store, available, overlayOpen }: Props) {
  const [data, setData] = useState<JobPanelSnapshot | null>(null);
  const [output, setOutput] = useState<DisplayJobOutput | null>(null);
  const [open, setOpen] = useState(false); const [expanded, setExpanded] = useState<string | null>(null);
  const [settledOpen, setSettledOpen] = useState<boolean | null>(null);
  const [visible, setVisible] = useState(document.visibilityState === 'visible');
  const [now, setNow] = useState(Date.now()); const [copied, setCopied] = useState(''); const [notice, setNotice] = useState('');
  const [position, setPosition] = useState({ left: 12, top: 60, width: 560, height: 480 });
  const trigger = useRef<HTMLButtonElement>(null); const menu = useRef<HTMLDivElement>(null);
  const outputRef = useRef<DisplayJobOutput | null>(null); const revision = useRef<number | undefined>(undefined);
  const viewId = useRef(crypto.randomUUID()); const desired = useRef<string | null>(null); const force = useRef(false);
  const receivedAt = useRef(Date.now());
  desired.current = open && visible && !overlayOpen ? expanded : null;
  const contextKey = JSON.stringify([view.context.serverId, view.context.authProfileId, view.context.generation, view.context.workspaceId, view.context.sessionId]);
  const rows = orderedJobs(data?.rows ?? []); const live = rows.filter(isLiveJob); const settled = rows.filter(job => !isLiveJob(job));
  const row = rows.find(job => job.id === expanded);
  const fresh = available && data?.state === 'live' && data.context.generation === view.context.generation;

  useEffect(() => {
    if (!available) { setNotice('网络恢复前保留已加载的后台任务与输出缓存。'); return; }
    let alive = true; let timer: ReturnType<typeof setTimeout> | undefined;
    viewId.current = crypto.randomUUID(); revision.current = undefined;
    const context = view.context;
    const poll = async (): Promise<void> => {
      if (!alive) return;
      const requested = desired.current; const id = viewId.current; const previous = outputRef.current;
      const refresh = force.current; force.current = false;
      const reply = await store.api.jobView({ context, viewId: id, expandedJobId: requested,
        ...(revision.current === undefined ? {} : { sinceRevision: revision.current }),
        outputEpoch: previous !== null && previous.jobId === requested ? previous.epoch : null, outputCursor: previous !== null && previous.jobId === requested ? previous.cursor : null,
        ...(refresh ? { refresh: true } : {}) });
      if (!alive || id !== viewId.current) return;
      if (reply.ok) {
        if (reply.value !== null) {
          const next = reply.value; revision.current = next.revision; receivedAt.current = Date.now(); setData(next); setNotice('');
          if (next.output !== null && next.output.jobId === desired.current) {
            const merged = mergeJobOutput(outputRef.current, next.output); outputRef.current = merged; setOutput(merged);
          }
          if (next.state === 'live' && requested !== null && !next.rows.some(job => job.id === requested)) setExpanded(null);
        }
      } else if (reply.error.kind === 'cancelled') {
        // 冻结或超时收回租约后用新生命周期重新准入，不复用已释放的 viewId。
        viewId.current = crypto.randomUUID(); revision.current = undefined; setNotice('正在恢复后台任务查看…');
      } else setNotice(reply.error.message);
      if (alive) timer = setTimeout(() => { void poll(); }, document.visibilityState === 'visible' ? 300 : 1200);
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); void store.api.releaseJobs({ context, viewId: viewId.current }); };
  }, [contextKey, available, store]);
  useEffect(() => {
    const changed = (): void => setVisible(document.visibilityState === 'visible'); document.addEventListener('visibilitychange', changed);
    return () => { document.removeEventListener('visibilitychange', changed); };
  }, []);
  useEffect(() => { if (overlayOpen) setOpen(false); }, [overlayOpen]);
  useEffect(() => { if (data?.state === 'live' && rows.length === 0) { setOpen(false); setExpanded(null); } }, [data?.revision]);
  useEffect(() => {
    if (!open || !fresh || live.length === 0 || !visible) return;
    setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer);
  }, [open, fresh, live.length, visible]);
  useLayoutEffect(() => {
    if (!open || rows.length === 0 || trigger.current === null) return;
    const place = (): void => {
      const bounds = trigger.current?.getBoundingClientRect(); if (bounds === undefined) return;
      const width = Math.max(120, Math.min(620, window.innerWidth - 24)); const height = Math.max(80, Math.min(560, window.innerHeight - 24));
      setPosition({ width, height, left: Math.max(12, Math.min(bounds.right - width, window.innerWidth - width - 12)),
        top: Math.max(12, Math.min(bounds.bottom + 8, window.innerHeight - height - 12)) });
    };
    const observer = new ResizeObserver(place); observer.observe(trigger.current); window.addEventListener('resize', place); place();
    return () => { observer.disconnect(); window.removeEventListener('resize', place); };
  }, [open, rows.length]);
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent): void => { const target = event.target; if (target instanceof Node && !menu.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false); };
    const keyboard = (event: KeyboardEvent): void => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); setOpen(false); trigger.current?.focus({ preventScroll: true }); } };
    document.addEventListener('pointerdown', pointer); document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', keyboard); };
  }, [open]);
  if (rows.length === 0) return null;
  const count = live.length > 0 ? live.length : rows.length;
  const pane = open ? <div ref={menu} className="background-jobs-menu" role="region" aria-label="会话内后台任务" style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.height }}>
    <header><strong>{fresh ? '后台任务' : '后台任务缓存'}</strong><span className="muted small">只读查看</span><button type="button" disabled={!available} onClick={() => { force.current = true; setNotice('正在重新读取后台任务…'); }}>刷新</button><button type="button" className="icon-button" aria-label="关闭后台任务" onClick={() => setOpen(false)}>×</button></header>
    {notice !== '' && <p className="background-job-notice" role="status">{notice}</p>}
    {data?.failure !== null && data?.failure !== undefined && <p className="background-job-notice" role="status">{data.failure.message}</p>}
    <div className="background-jobs-list">
      {live.map(job => <JobItem key={job.id} job={job} current={expanded === job.id} fresh={fresh} now={fresh ? now : receivedAt.current} toggle={() => setExpanded(value => value === job.id ? null : job.id)} />)}
      {settled.length > 0 && <button type="button" className="background-job-section" aria-expanded={settledOpen ?? live.length === 0} onClick={() => setSettledOpen(value => !(value ?? live.length === 0))}><WorkbenchIcon name="chevron-down" size={12} />已结束 · {settled.length}</button>}
      {(settledOpen ?? live.length === 0) && settled.map(job => <JobItem key={job.id} job={job} current={expanded === job.id} fresh={fresh} now={receivedAt.current} toggle={() => setExpanded(value => value === job.id ? null : job.id)} />)}
      {row !== undefined && expanded !== null && <section className="background-job-panel" aria-label={`后台输出：${row.label}`}>
        <div className="background-job-command"><code>{row.label}</code><button type="button" onClick={() => {
          void navigator.clipboard.writeText(row.label).then(() => setCopied(row.id), () => setNotice('系统剪贴板暂不可用。'));
        }}>{copied === row.id ? '已复制' : '复制命令'}</button></div>
        {output?.jobId === row.id && output.gapBefore && <p className="background-job-notice">部分输出已被服务端或本机尾部预算淘汰，当前不是完整永久日志。</p>}
        {output?.jobId === row.id && output.failure !== null && <p className="background-job-notice" role="status">{output.failure.message} 已保留现有输出。</p>}
        {!available && <p className="background-job-notice">连接中断，先查看缓存；恢复并取得新任务列表后续接。</p>}
        <JobOutput output={output?.jobId === row.id ? output : null} />
        <p className="background-job-footer">{jobOutputStateLabel(output?.jobId === row.id ? output : null, fresh)} · 收起只停止输出订阅；停止任务请到原网页操作。</p>
      </section>}
    </div>
  </div> : null;
  return <div className="background-job-control"><button ref={trigger} type="button" className="background-job-trigger" title={fresh ? '查看会话内后台命令任务' : '查看已缓存后台任务'} aria-expanded={open} aria-haspopup="true"
    onClick={() => { setOpen(value => !value); setNow(Date.now()); }} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); queueMicrotask(() => menu.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })); } }}>
    {live.length > 0 && fresh ? <span className="job-running-dot" aria-hidden="true" /> : <WorkbenchIcon name="terminal" size={14} />}<span>{count} 个后台任务</span>
  </button>{pane !== null && createPortal(pane, document.body)}</div>;
}
function JobItem({ job, current, fresh, now, toggle }: { readonly job: JobRow; readonly current: boolean; readonly fresh: boolean; readonly now: number; readonly toggle: () => void }) {
  const body = <><span className={`job-state-dot job-${job.status}`} aria-hidden="true" /><span className="background-job-copy"><strong title={job.label}>{job.label}</strong><small><span>{job.kind}</span><span>{fresh ? job.progress ?? job.detail ?? jobStatusLabel(job) : '缓存状态'}</span><time>{jobDuration(job, now)}</time></small></span>{observableJob(job) && <WorkbenchIcon name="chevron-down" size={12} />}</>;
  return observableJob(job) ? <button type="button" className={`background-job-row ${current ? 'is-expanded' : ''} ${fresh ? '' : 'is-cached'}`} aria-expanded={current} onClick={toggle}>{body}</button> : <div className="background-job-row is-static">{body}</div>;
}
function JobOutput({ output }: { readonly output: DisplayJobOutput | null }) {
  const scroll = useRef<HTMLPreElement>(null); const atEnd = useRef(true);
  useLayoutEffect(() => { const element = scroll.current; if (element !== null && atEnd.current) element.scrollTop = element.scrollHeight; }, [output?.cursor, output?.jobId]);
  return <pre ref={scroll} className="background-job-output" onScroll={event => { const element = event.currentTarget; atEnd.current = element.scrollHeight - element.clientHeight - element.scrollTop < 24; }}>
    {output === null || output.text === '' ? '等待可读取的后台输出…' : jobOutputText(output.text)}
  </pre>;
}
