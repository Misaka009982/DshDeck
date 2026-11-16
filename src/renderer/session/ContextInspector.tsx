import { useEffect, useRef } from 'react';
import { contextOccupancy, tokenTotals } from '../../shared/native-controls.js';
import type { NativeSnapshot } from '../../shared/native-controls.js';

interface Props { readonly native: NativeSnapshot | undefined; readonly open: boolean; readonly setOpen: (open: boolean) => void }
export function ContextInspector({ native, open, setOpen }: Props) {
  const root = useRef<HTMLDivElement>(null); const values = native?.values;
  const occupancy = contextOccupancy(values?.contextPressure); const usage = tokenTotals(values?.tokenUsage); const stats = values?.sessionStats;
  const speed = stats !== undefined && stats.decodeMs > 0 ? stats.decodeTokens / (stats.decodeMs / 1000) : null;
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent): void => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', outside); window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape); };
  }, [open]);
  return <div className="context-inspector" ref={root}>
    <button type="button" className="composer-option context-reading" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}
      title="当前上下文来自服务器 contextPressure；累计 Token 另列，不用于冒充当前上下文。">{occupancy === null ? '上下文未知' : `上下文 ≈ ${occupancy.percent}%`}</button>
    <div className="session-stat-readings" aria-label="当前会话统计">
      {stats !== undefined && <span title="完整会话已结束模型步骤的统计">{count(stats.turns)} 轮 · {count(stats.steps)} 步</span>}
      {speed !== null && <span title="有记录解码耗时的步骤平均输出速度">{speed.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} Token/s</span>}
      {usage !== null && <span title="整会话累计账单，不是当前上下文">{count(usage.total)} Token</span>}
      {usage?.cacheHit !== null && usage?.cacheHit !== undefined && <span title="累计缓存读取 / 累计全部输入">缓存 {percent(usage.cacheHit)}%</span>}
    </div>
    {open && <div className="native-popover context-popover" role="dialog" aria-label="上下文与会话统计">
      <header><strong>上下文与统计</strong><button type="button" onClick={() => setOpen(false)} aria-label="关闭上下文详情">×</button></header>
      <section><h4>当前上下文（近似）</h4>
        {occupancy === null ? <p className="muted">服务器未提供完整分子和容量，不能计算当前占用。</p> : <>
          <div className="context-meter" role="progressbar" aria-label="近似上下文用量" aria-valuemin={0} aria-valuemax={100} aria-valuenow={occupancy.percent}><span style={{ width: `${occupancy.percent}%` }} /></div>
          <dl><dt>{values?.contextPressure?.projectedTokens === undefined ? '近期请求输入' : '下一请求近似输入'}</dt><dd>{count(occupancy.usedTokens)} Token</dd><dt>已知容量</dt><dd>{count(occupancy.contextWindow)} Token</dd></dl>
        </>}
        <p className="muted">分子与容量可能来自不同时间；切换模型后要等新请求更新。这里不作为计费或权限判断。</p>
        {values?.contextBreakdown !== undefined && <dl><dt>系统提示（估计）</dt><dd>{count(values.contextBreakdown.systemTokens)}</dd><dt>工具定义（估计）</dt><dd>{count(values.contextBreakdown.toolsTokens)}</dd><dt>消息内容（估计）</dt><dd>{count(values.contextBreakdown.messageTokens)}</dd></dl>}
        {values?.contextBreakdown !== undefined && <p className="muted">组成使用启发式估计，不能相加冒充上面的实际占用。</p>}
      </section>
      <section><h4>整会话累计账单</h4>{usage === null || values?.tokenUsage === undefined ? <p className="muted">服务器尚未提供累计账单。</p> : <dl>
        <dt>非缓存输入</dt><dd>{count(values.tokenUsage.uncachedInputTokens)}</dd><dt>缓存读取</dt><dd>{count(values.tokenUsage.cacheReadTokens)}</dd><dt>缓存写入</dt><dd>{count(values.tokenUsage.cacheWriteTokens)}</dd>
        <dt>输出</dt><dd>{count(values.tokenUsage.outputTokens)}</dd><dt>累计总计</dt><dd>{count(usage.total)} Token</dd><dt>缓存命中</dt><dd>{usage.cacheHit === null ? '未知' : `${percent(usage.cacheHit)}%`}</dd>
      </dl>}</section>
      <section><h4>步骤与速度</h4>{stats === undefined ? <p className="muted">没有可用的完整会话统计，不填入假值。</p> : <dl>
        <dt>已记录轮次 / 步骤</dt><dd>{count(stats.turns)} / {count(stats.steps)}</dd><dt>模型累计耗时</dt><dd>{duration(stats.llmMs)}</dd><dt>工具累计耗时</dt><dd>{duration(stats.toolMs)}</dd>
        <dt>平均首 Token 等待</dt><dd>{stats.ttftSteps === 0 ? '未知' : duration(stats.ttftMs / stats.ttftSteps)}</dd><dt>平均解码速度</dt><dd>{speed === null ? '未知' : `${speed.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} Token/s`}</dd>
      </dl>}</section>
      <p className="muted">{native === undefined ? '等待元信息基线' : `投影水位 #${native.asOfSeq} · ${native.state === 'live' ? '实时' : native.state === 'stale' ? '已过期' : '缓存'}`}</p>
      {native !== undefined && native.invalid.length > 0 && <p className="native-field-warning">部分字段结构尚未适配：{native.invalid.join('、')}。其余正文保留。</p>}
      {native?.failure !== null && native?.failure !== undefined && <p className="native-field-warning">元信息暂不可实时更新（{native.failure.kind}），保留上次数据；点击当前会话可重新接入。</p>}
    </div>}
  </div>;
}
function count(value: number): string { return value.toLocaleString('zh-CN'); }
function percent(value: number): string { return value > 99.9 && value < 100 ? '>99.9' : value.toLocaleString('zh-CN', { maximumFractionDigits: 1 }); }
function duration(ms: number): string { return `${(ms / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}s`; }
