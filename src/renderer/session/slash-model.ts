import type { CommandDescriptor } from '../../shared/native-controls.js';

export type LocalSlashAction = 'model' | 'context' | 'tasks' | 'goal';
export interface SlashCandidate { readonly name: string; readonly label: string; readonly description: string; readonly kind: 'local' | 'command'; readonly action?: LocalSlashAction; readonly input?: boolean }
const LOCAL: readonly SlashCandidate[] = [
  { name: 'model', label: '模型', description: '选择服务器模型与思考档位', kind: 'local', action: 'model' },
  { name: 'context', label: '上下文', description: '查看当前近似用量和整会话统计', kind: 'local', action: 'context' },
  { name: 'tasks', label: '任务列表', description: '查看服务器当前会话任务进度', kind: 'local', action: 'tasks' },
  { name: 'goal', label: '目标', description: '查看和管理当前会话目标', kind: 'local', action: 'goal' },
];

/** 只识别输入框的命令前缀，不扩展为全局快捷键或解析正文里的路径。 */
export function slashQuery(text: string): string | null { return /^\s*\/([^\s/]{0,128})$/u.exec(text)?.[1] ?? null; }
export function slashCandidates(commands: readonly CommandDescriptor[], query: string): readonly SlashCandidate[] {
  const known = new Set(commands.map(command => command.name));
  const rows: SlashCandidate[] = [...LOCAL.filter(command => !known.has(command.name)), ...commands.map(command => command.definitionId === '@deepseek-ai/dsh-command-goal'
    ? { name: command.name, label: '目标', description: '查看与管理当前会话目标；带参数的输入仍交给服务器命令', kind: 'local' as const, action: 'goal' as const }
    : { name: command.name, label: command.name, description: command.description, kind: 'command' as const, input: command.input !== undefined })];
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return rows.slice(0, 50);
  const rank = (candidate: SlashCandidate): number => candidate.name.toLocaleLowerCase().startsWith(needle) ? 0 : candidate.name.toLocaleLowerCase().includes(needle) ? 1
    : candidate.label.toLocaleLowerCase().includes(needle) ? 2 : candidate.description.toLocaleLowerCase().includes(needle) ? 3 : 4;
  return rows.filter(row => rank(row) < 4).sort((left, right) => rank(left) - rank(right)).slice(0, 50);
}
export function classifySlash(text: string, commands: readonly CommandDescriptor[]): { readonly kind: 'text' | 'unknown' } | { readonly kind: 'local'; readonly action: LocalSlashAction } | { readonly kind: 'command'; readonly name: string } {
  const line = text.trim(); if (!line.startsWith('/')) return { kind: 'text' };
  const token = /^\/([^\s/]+)(?:\s([\s\S]*))?$/u.exec(line); const name = token?.[1];
  if (name === undefined) return { kind: 'unknown' };
  const command = commands.find(command => command.name === name);
  if (command !== undefined) {
    if (command.definitionId === '@deepseek-ai/dsh-command-goal' && (token?.[2]?.trim() ?? '') === '') return { kind: 'local', action: 'goal' };
    return (token?.[2]?.trim() ?? '') === '' || command.input !== undefined ? { kind: 'command', name } : { kind: 'unknown' };
  }
  const local = LOCAL.find(command => command.name === name);
  return local?.action !== undefined && (token?.[2]?.trim() ?? '') === '' ? { kind: 'local', action: local.action } : { kind: 'unknown' };
}
