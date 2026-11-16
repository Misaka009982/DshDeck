import { isRecord } from '../../shared/faults.js';

export const NETWORK_CODES = [
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ABORT_ERR',
  'ERR_FAILED', 'ERR_ABORTED', 'ERR_ACCESS_DENIED', 'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED', 'ERR_ADDRESS_UNREACHABLE', 'ERR_NAME_NOT_RESOLVED', 'ERR_TIMED_OUT',
  'ERR_CONNECTION_TIMED_OUT', 'ERR_PROXY_CONNECTION_FAILED', 'ERR_TUNNEL_CONNECTION_FAILED',
  'ERR_NETWORK_CHANGED', 'ERR_INTERNET_DISCONNECTED', 'ERR_BLOCKED_BY_CLIENT', 'ERR_BLOCKED_BY_RESPONSE',
  'ERR_INVALID_AUTH_CREDENTIALS', 'ERR_HTTP_RESPONSE_CODE_FAILURE', 'ERR_CERT_AUTHORITY_INVALID',
  'ERR_CERT_DATE_INVALID', 'ERR_CERT_COMMON_NAME_INVALID', 'ERR_SSL_PROTOCOL_ERROR',
  'ERR_SSL_VERSION_OR_CIPHER_MISMATCH', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID',
] as const;
export type NetworkCode = typeof NETWORK_CODES[number];
const KNOWN_CODES = new Set<string>(NETWORK_CODES);
export type NetworkProtocol = 'http:' | 'https:' | 'ws:' | 'wss:';
export type ResponseCategory = 'json' | 'multipart' | 'html' | 'other' | 'missing';
export type AddressKind = 'loopback' | 'tailnet-range' | 'private-ip' | 'public-ip' | 'ipv6' | 'hostname';
export interface NavigationFields {
  readonly networkProtocol?: NetworkProtocol;
  readonly originMatchesBase?: boolean;
  readonly pathMatchesBase?: boolean;
  readonly targetLoopback?: boolean;
  readonly targetAddressKind?: AddressKind;
  readonly targetPort?: number;
}

/** 原始错误只用于辨识固定码；不返回 message、cause、请求地址或任意字符串。 */
export function networkErrorCode(error: unknown): NetworkCode | undefined {
  if (!isRecord(error)) return undefined;
  try {
    const code = error.code;
    if (typeof code === 'string' && KNOWN_CODES.has(code)) return code as NetworkCode;
    const message = error.message;
    if (typeof message !== 'string') return undefined;
    for (const match of message.slice(0, 2048).matchAll(/\bnet::(ERR_[A-Z_]+)\b/gu)) {
      if (match[1] !== undefined && KNOWN_CODES.has(match[1])) return match[1] as NetworkCode;
    }
  } catch { /* 不允许异常对象的访问器拖垮诊断。 */ }
  return undefined;
}

/** 已知拒绝或证书错误不得被窗口结束标记掩盖。 */
export function isNavigationAborted(error: unknown, ended: boolean): boolean {
  const code = networkErrorCode(error);
  if (code === 'ERR_ABORTED' || code === 'ABORT_ERR' || ended && code === 'ERR_FAILED') return true;
  if (!ended || code !== undefined || !isRecord(error)) return false;
  try {
    const message = error.message;
    return error.name === 'AbortError' || (typeof message === 'string' && message.slice(0, 2048).includes('Object has been destroyed'));
  } catch { return false; }
}

/** 只返回协议、地址类别、端口和匹配标记，不导出主机、路径、查询或认证材料。 */
export function navigationFields(target: string, baseUrl: string): NavigationFields {
  try {
    const url = new URL(target); const base = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return {};
    const host = url.hostname;
    const parts = host.split('.');
    // 仅识别明确的 loopback 字面值，不做 DNS 判断，也不用于授权。
    const loopback = host === 'localhost' || host === '[::1]'
      || (parts.length === 4 && parts[0] === '127' && parts.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255));
    const numbers = parts.map(Number);
    const ipv4 = parts.length === 4 && parts.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
    const kind: AddressKind = loopback ? 'loopback' : !ipv4 ? host.startsWith('[') ? 'ipv6' : 'hostname'
      : numbers[0] === 100 && (numbers[1] ?? 0) >= 64 && (numbers[1] ?? 0) <= 127 ? 'tailnet-range'
      : numbers[0] === 10 || numbers[0] === 192 && numbers[1] === 168 || numbers[0] === 172 && (numbers[1] ?? 0) >= 16 && (numbers[1] ?? 0) <= 31 ? 'private-ip' : 'public-ip';
    return { networkProtocol: url.protocol, originMatchesBase: url.origin === base.origin,
      pathMatchesBase: url.pathname.startsWith(base.pathname), targetLoopback: loopback,
      targetAddressKind: kind, targetPort: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) };
  } catch { return {}; }
}

export function responseCategory(contentType: string | null): ResponseCategory {
  if (contentType === null || contentType === '') return 'missing';
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType === 'application/json') return 'json';
  if (mediaType === 'multipart/form-data') return 'multipart';
  if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') return 'html';
  return 'other';
}
