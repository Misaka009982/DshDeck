import { ProtocolFault } from './faults.js';

/** 标题只作显示文本；空值代表未知，不推导任务状态或执行远程内容。 */
export function parseSessionTitle(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > 4096) throw new ProtocolFault('protocol');
  const title = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/gu, '').replace(/\s+/gu, ' ').trim();
  return title === '' ? undefined : title;
}
