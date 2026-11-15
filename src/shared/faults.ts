export type FaultKind =
  | 'auth-required' | 'forbidden' | 'not-found' | 'login-response'
  | 'protocol' | 'unsupported' | 'network' | 'tls' | 'cancelled'
  | 'budget' | 'timeout' | 'conflict' | 'uncertain';

export interface PublicFailure {
  readonly kind: FaultKind;
  readonly message: string;
}

const messages: Record<FaultKind, string> = {
  'auth-required': '业务请求仍需认证，请在该服务器的内置浏览器中登录。',
  forbidden: '请求被权限或 Host/Origin 策略拒绝，不会自动重试密码或降低安全设置。',
  'not-found': '该部署未提供当前协议端点，或请求的实体已不可用。',
  'login-response': '业务请求返回了网页登录内容，而不是协议响应。',
  protocol: '响应结构与固定协议契约不匹配，不能标记为已联通。',
  unsupported: '当前客户端尚未支持该认证、网络或协议组合，请使用兼容页面或提供版本信息。',
  network: '当前服务器的网络载体失败，请检查入口和网络状态。',
  tls: '证书验证失败，请修复证书或系统信任；不会跳过 TLS 验证。',
  cancelled: '已取消本地认证或读取，没有发送远程停止命令。',
  budget: '单次读取超过正文预算，已停止读取，不会静默截断为完整结果。',
  timeout: '本次受控读取未在期限内完成，可由用户明确重试。',
  uncertain: '请求已进入网络，但送达结果未知；不会自动重发。请先查看会话或重新连接核实。',
  conflict: '同一请求或入口出现了冲突身份，不能重复发送或拼接不同 Authorization。',
};

/** 错误只携带本地分类，不复制远程正文、凭据、URL 查询或 cause。 */
export class ProtocolFault extends Error {
  readonly kind: FaultKind;

  constructor(kind: FaultKind) {
    super(messages[kind]);
    this.name = 'ProtocolFault';
    this.kind = kind;
  }
}

export function toPublicFailure(error: unknown): PublicFailure {
  const fault = error instanceof ProtocolFault ? error : new ProtocolFault('network');
  return { kind: fault.kind, message: fault.message };
}

export function remoteFault(code: string): ProtocolFault {
  if (code === 'remote-access/denied') return new ProtocolFault('forbidden');
  if (code === 'session/not-found' || code === 'workspace/not-found') return new ProtocolFault('not-found');
  if (code === 'gateway/cancelled') return new ProtocolFault('cancelled');
  if (['gateway/method-unavailable', 'gateway/service-unavailable', 'gateway/definition-unavailable', 'gateway/lookup-not-found'].includes(code)) return new ProtocolFault('unsupported');
  if (code === 'gateway/interactions-forbidden') return new ProtocolFault('forbidden');
  return new ProtocolFault('protocol');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ProtocolFault('protocol');
  return value;
}

export function requireKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const keys = Reflect.ownKeys(value);
  if (!required.every(key => Object.hasOwn(value, key))
    || keys.some(key => typeof key !== 'string' || (!required.includes(key) && !optional.includes(key)))) {
    throw new ProtocolFault('protocol');
  }
}

export function requireId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ProtocolFault('protocol');
  }
  return value;
}
