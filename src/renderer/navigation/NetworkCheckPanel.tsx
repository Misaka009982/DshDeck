import type { NetworkCheckReport, NetworkCheckStep } from '../../shared/network-check.js';

const conclusions: Record<NetworkCheckReport['conclusion'], string> = {
  'http-reachable': 'HTTP 线路可达；这不代表 dsh 已授权，请再点击连接。',
  'http-layer': 'TCP 端口可达，问题缩小到 HTTP/TLS 层；没有据此关闭证书验证。',
  'route-or-process': 'TCP 与 HTTP 均未成功；可用脱敏诊断继续核对线路或进程策略。',
  'proxy-managed': '采用系统代理策略，已跳过目标端口直连检查。',
};
export function NetworkCheckPanel({ report, error, busy, copy }: { readonly report: NetworkCheckReport | null; readonly error: string; readonly busy: boolean; readonly copy: () => void }) {
  return <div className="network-check-panel" role="status">
    {busy ? <span>正在检查保存入口的线路…</span> : report !== null ? <>
      <dl><dt>原生 TCP</dt><dd>{stepText(report.tcp)}</dd><dt>Electron HEAD</dt><dd>{stepText(report.http)}</dd></dl>
      <p>{conclusions[report.conclusion]}</p><button type="button" onClick={copy}>复制诊断</button>
    </> : error !== '' ? <p>{error}</p> : null}
  </div>;
}
function stepText(step: NetworkCheckStep): string {
  return step.state === 'skipped' ? '按代理策略跳过' : step.state === 'failed' ? `${step.networkCode ?? step.failure.kind} · ${step.elapsedMs}ms`
    : step.state === 'response' ? `HTTP ${step.httpStatus} · ${step.elapsedMs}ms` : `端口可达 · ${step.elapsedMs}ms`;
}
