import { getCACertificates } from 'node:tls';

/** Node WS 保留证书验证，并使用默认与系统 CA；不导入私有例外。 */
export function tlsOptions(): { rejectUnauthorized: true; ca: string[] } {
  return {
    rejectUnauthorized: true,
    ca: [...new Set([...getCACertificates('default'), ...getCACertificates('system')])],
  };
}

export function isCertificateFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = Reflect.get(error, 'code') as unknown;
  const message = Reflect.get(error, 'message') as unknown;
  return (typeof code === 'string' && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|TLS/iu.test(code))
    || (typeof message === 'string' && /ERR_CERT_|ERR_SSL_|certificate/iu.test(message));
}
