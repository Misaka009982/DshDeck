import { ProtocolFault, requireKeys, requireRecord } from './faults.js';
import type { ServerInput } from './contracts.js';

export function normalizeServerInput(input: unknown): ServerInput {
  const record = requireRecord(input);
  requireKeys(record, ['alias', 'baseUrl']);
  if (typeof record.alias !== 'string' || typeof record.baseUrl !== 'string') throw new ProtocolFault('protocol');
  const alias = record.alias.trim();
  const rawUrl = record.baseUrl.trim();
  if (alias.length === 0 || alias.length > 64 || rawUrl.length > 2048
    || /[\u0000-\u0020\u007f\\]/u.test(rawUrl) || /%(?:2e|2f|5c)/iu.test(rawUrl)) {
    throw new ProtocolFault('protocol');
  }
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new ProtocolFault('protocol'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== ''
    || url.search !== '' || url.hash !== '' || url.hostname === '') throw new ProtocolFault('protocol');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  if (url.href.length > 2048) throw new ProtocolFault('protocol');
  return { alias, baseUrl: url.href };
}

export function createPartitionName(authProfileId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(authProfileId)) throw new ProtocolFault('protocol');
  return `persist:dshdeck-${authProfileId}`;
}

export function isHttpNavigation(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === '';
  } catch { return false; }
}
