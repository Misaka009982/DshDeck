import { useState } from 'react';
import type { WorkbenchSettings } from '../../shared/domain.js';

export function SyncSettings({ settings, change }: { readonly settings: WorkbenchSettings; readonly change: (settings: WorkbenchSettings) => void }) {
  const [interval, setInterval] = useState(String(settings.syncIntervalSeconds));
  const valid = Number.isSafeInteger(Number(interval)) && Number(interval) >= 1 && Number(interval) <= 3600;
  return <section className="settings-section"><h3>后台同步与缓存</h3><p className="muted small">当前会话正文实时；所有运行中的后台会话按间隔预同步。关注只控制任务灯和提醒，不控制缓存资格。</p>
    <label>后台正文同步间隔（秒）<div className="inline-setting"><input type="number" min={1} max={3600} step={1} value={interval} onChange={event => setInterval(event.target.value)} /><button type="button" disabled={!valid} onClick={() => change({ ...settings, syncIntervalSeconds: Number(interval) })}>应用</button></div></label>
    <div className="sync-presets">{[5, 10, 30, 60].map(value => <button key={value} type="button" className={settings.syncIntervalSeconds === value ? 'active' : ''} onClick={() => { setInterval(String(value)); change({ ...settings, syncIntervalSeconds: value }); }}>{value} 秒</button>)}</div>
    {!valid && <p className="form-error">请输入 1–3600 的整数。</p>}
    <p className="muted small">必要状态通道不随正文间隔降频。64 MiB 有界内存缓存；超预算保留可用内容并提示，不静默改成后台实时订阅。</p>
  </section>;
}
