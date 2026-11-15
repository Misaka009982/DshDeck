import type { CredentialScope } from './credential-store.js';

/** 只支持明确、唯一的 Basic realm 挑战；未知或多个认证空间不猜测，不记录原始认证头。 */
export function basicChallengeScope(authProfileId: string, target: string, header: string | null): CredentialScope | undefined {
  if (header === null || header.length > 4096 || /[\r\n]/u.test(header)) return undefined;
  const values = [...header.matchAll(/(?:^|,)\s*Basic\s+realm\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^\s,]+))/giu)];
  if (values.length !== 1) return undefined;
  const matched = values[0]; const realm = (matched?.[1] ?? matched?.[2] ?? '').replace(/\\(.)/gu, '$1');
  if (realm.length > 1024) return undefined;
  let url: URL; try { url = new URL(target); } catch { return undefined; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') return undefined;
  return { authProfileId, origin: url.origin, host: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), realm, scheme: 'basic' };
}
