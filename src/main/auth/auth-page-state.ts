import type { AuthPageState } from '../../shared/contracts.js';
import { navigationFields, networkErrorCode } from '../logging/connection-details.js';
import { isCertificateFailure } from './tls-policy.js';

const LOAD_CODES: Readonly<Record<number, string>> = {
  [-2]: 'ERR_FAILED', [-3]: 'ERR_ABORTED', [-100]: 'ERR_CONNECTION_CLOSED', [-101]: 'ERR_CONNECTION_RESET',
  [-102]: 'ERR_CONNECTION_REFUSED', [-105]: 'ERR_NAME_NOT_RESOLVED', [-106]: 'ERR_INTERNET_DISCONNECTED',
  [-107]: 'ERR_SSL_PROTOCOL_ERROR', [-109]: 'ERR_ADDRESS_UNREACHABLE', [-113]: 'ERR_SSL_VERSION_OR_CIPHER_MISMATCH',
  [-118]: 'ERR_CONNECTION_TIMED_OUT', [-130]: 'ERR_PROXY_CONNECTION_FAILED', [-200]: 'ERR_CERT_COMMON_NAME_INVALID',
  [-201]: 'ERR_CERT_DATE_INVALID', [-202]: 'ERR_CERT_AUTHORITY_INVALID',
};

/** 认证控制页只取得受控状态；未知错误正文和真实地址始终不进入快照。 */
export class AuthPageStatus {
  private epoch = 0;
  private revision = 0;
  private protocol: 'http:' | 'https:' | undefined;
  private port: number | undefined;
  private value: AuthPageState = { revision: 0, state: 'loading', message: '正在打开服务器登录页…', failure: null };
  constructor(private readonly changed: (state: AuthPageState) => void = () => {}) {}
  begin(target: string, baseUrl: string): number {
    const fields = navigationFields(target, baseUrl);
    this.protocol = fields.networkProtocol === 'http:' || fields.networkProtocol === 'https:' ? fields.networkProtocol : undefined;
    this.port = fields.targetPort;
    const epoch = ++this.epoch;
    this.publish('loading', `正在打开${this.endpoint()}登录页…`);
    return epoch;
  }
  current(): AuthPageState { return { ...this.value, failure: this.value.failure === null ? null : { ...this.value.failure } }; }
  ready(epoch: number): void {
    if (epoch !== this.epoch) return;
    this.publish('ready', '登录页已加载；完成网页登录后点击“已登录，验证连接”。');
  }
  cancel(epoch: number): void { if (epoch === this.epoch) this.publish('cancelled', '本次页面导航已取消；可重新打开保存入口。'); }
  failLoad(epoch: number, code: number): void {
    const known = LOAD_CODES[code];
    this.fail(epoch, known === undefined ? {} : { code: known });
  }
  fail(epoch: number, error: unknown): void {
    if (epoch !== this.epoch) return;
    const code = networkErrorCode(error);
    if (code === 'ERR_ABORTED' || code === 'ABORT_ERR') { this.cancel(epoch); return; }
    let certificate = false;
    try { certificate = code?.startsWith('ERR_SSL_') === true || isCertificateFailure(error); } catch { /* 不读取失败对象的任意正文。 */ }
    const endpoint = this.endpoint();
    const message = certificate ? `${endpoint}证书校验未通过。内网 HTTPS 也需要可信证书；程序不会自动绕过校验。`
      : code === 'ERR_CONNECTION_REFUSED' || code === 'ECONNREFUSED' ? `${endpoint}连接被拒绝。请核对入口、监听端口与应用网络访问；这不是 Cookie 失效。`
      : code === 'ERR_PROXY_CONNECTION_FAILED' || code === 'ERR_TUNNEL_CONNECTION_FAILED' ? `${endpoint}代理连接失败。请核对该服务器的连接路线。`
      : code === 'ERR_CONNECTION_TIMED_OUT' || code === 'ERR_TIMED_OUT' || code === 'ETIMEDOUT' ? `${endpoint}页面加载超时。请核对网络与服务器可达性。`
      : `${endpoint}页面加载失败。可重试；详细错误分类已写入脱敏日志。`;
    this.publish('failed', message, { kind: certificate ? 'tls' : 'network', message });
  }
  private endpoint(): string { return this.protocol === undefined ? '' : `${this.protocol === 'https:' ? 'HTTPS' : 'HTTP'}${this.port === undefined ? '' : ` ${this.port}`} `; }
  private publish(state: AuthPageState['state'], message: string, failure: AuthPageState['failure'] = null): void {
    this.value = { revision: ++this.revision, state, message, failure };
    this.changed(this.current());
  }
}
