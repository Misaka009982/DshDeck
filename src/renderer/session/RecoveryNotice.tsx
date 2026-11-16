import { useEffect, useState } from 'react';
import type { RecoveryView } from '../../shared/recovery.js';
import { recoveryText } from '../../shared/recovery.js';

export function RecoveryNotice({ recovery, conversation = false, retry, disconnect }: { readonly recovery: RecoveryView; readonly conversation?: boolean; readonly retry: () => void; readonly disconnect?: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return <div className="recovery-notice" role="status">
    <span className={`recovery-spinner ${recovery.phase === 'stopped' ? 'is-stopped' : ''}`} aria-hidden="true" />
    <div><strong>{recoveryText(recovery, now, conversation)}</strong><small>保留可用缓存；恢复只读连接，不自动重登、重发输入或批准操作。</small></div>
    <button type="button" disabled={recovery.phase === 'connecting'} onClick={retry}>立即重试</button>
    {disconnect !== undefined && <button type="button" onClick={disconnect}>停止重连</button>}
  </div>;
}
