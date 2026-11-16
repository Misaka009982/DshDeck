import { ProtocolFault, requireId, requireKeys, requireRecord } from './faults.js';
import type { PublicFailure } from './faults.js';
import type { SessionContext } from './domain.js';

export interface ModelSelection { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
export interface ModelReasoning { readonly efforts: readonly { readonly id: string; readonly name: string; readonly description?: string }[]; readonly defaultEffort?: string }
export interface CatalogModel { readonly id: string; readonly name: string; readonly description?: string; readonly reasoning?: ModelReasoning }
export interface ModelCatalog {
  readonly default: ModelSelection;
  readonly routableProviders: readonly string[];
  readonly groups: readonly { readonly id: string; readonly name: string; readonly models: readonly CatalogModel[] }[];
  readonly failures: readonly { readonly id: string; readonly name: string; readonly message: string }[];
}
export interface GoalRef { readonly id: string; readonly revision: number }
export interface GoalSnapshot extends GoalRef {
  readonly objective: string;
  readonly phase: 'active' | 'paused' | 'blocked' | 'complete';
  readonly maxGoalRounds: number;
  readonly blockedReason?: { readonly code: string; readonly message: string };
}
export interface GoalProjection { readonly goal: GoalSnapshot; readonly roundsStarted: number; readonly createdAt: number; readonly updatedAt: number }
export type GoalAction = { readonly kind: 'create'; readonly objective: string }
  | { readonly kind: 'edit'; readonly ref: GoalRef; readonly objective: string }
  | { readonly kind: 'pause' | 'resume' | 'clear'; readonly ref: GoalRef };
export interface SelectModelInput { readonly context: SessionContext; readonly requestId: string; readonly selection: ModelSelection }
export interface GoalActionInput { readonly context: SessionContext; readonly requestId: string; readonly action: GoalAction }
export interface CommandDescriptor { readonly name: string; readonly description: string; readonly definitionId?: string; readonly input?: { readonly hint: string; readonly attachments?: boolean } }
export interface CommandExecution { readonly commandId: string; readonly result: { readonly kind: 'success' | 'error'; readonly text?: string } }
export interface ContextPressure { readonly projectedTokens?: number; readonly pressureTokens?: number; readonly contextWindow?: number }
export interface ContextBreakdown { readonly systemTokens: number; readonly toolsTokens: number; readonly messageTokens: number }
export interface TokenUsage { readonly uncachedInputTokens: number; readonly cacheReadTokens: number; readonly cacheWriteTokens: number; readonly outputTokens: number }
export interface SessionStats { readonly turns: number; readonly steps: number; readonly llmMs: number; readonly toolMs: number; readonly ttftMs: number; readonly ttftSteps: number; readonly decodeMs: number; readonly decodeTokens: number }
export interface NativeValues {
  readonly modelSelection?: { readonly lastUsed: ModelSelection | null; readonly next: ModelSelection | null };
  readonly contextPressure?: ContextPressure;
  readonly contextBreakdown?: ContextBreakdown;
  readonly tokenUsage?: TokenUsage;
  readonly sessionStats?: SessionStats;
  readonly todos?: readonly { readonly content: string; readonly status: 'pending' | 'in_progress' | 'completed' }[] | null;
  readonly goal?: GoalProjection | null;
}
export const NATIVE_KEYS = ['modelSelection', 'contextPressure', 'contextBreakdown', 'tokenUsage', 'sessionStats', 'todos', 'goal'] as const;
export type NativeKey = typeof NATIVE_KEYS[number];
export interface NativeSnapshot {
  readonly asOfSeq: number;
  readonly values: NativeValues;
  readonly invalid: readonly NativeKey[];
  readonly state: 'cached' | 'live' | 'stale';
  readonly failure: PublicFailure | null;
}
export type NativeFrame = { readonly kind: 'baseline'; readonly asOfSeq: number; readonly values: Readonly<Record<string, unknown>> }
  | { readonly kind: 'change'; readonly seq: number; readonly changes: readonly { readonly key: string; readonly val: unknown }[] };

/** 仅保留已核对的界面投影；坏字段单独降级，未知插件字段不进入原生缓存。 */
export function parseNativeValues(value: unknown): { readonly values: NativeValues; readonly invalid: readonly NativeKey[] } {
  const data = requireRecord(value); const values: Record<string, unknown> = {}; const invalid: NativeKey[] = [];
  for (const key of NATIVE_KEYS) {
    if (!Object.hasOwn(data, key)) continue;
    try {
      const raw = data[key];
      if (key === 'modelSelection') { const selection = requireRecord(raw); values[key] = { lastUsed: selection.lastUsed === null ? null : parseModelSelection(selection.lastUsed), next: selection.next === null ? null : parseModelSelection(selection.next) }; }
      else if (key === 'contextPressure') {
        const pressure = requireRecord(raw); const known: Record<string, number> = {};
        for (const field of ['projectedTokens', 'pressureTokens', 'contextWindow'] as const) if (pressure[field] !== undefined) known[field] = nonnegative(pressure[field], field === 'contextWindow' ? 1 : 0);
        values[key] = known;
      } else if (key === 'contextBreakdown') values[key] = numericRecord(raw, ['systemTokens', 'toolsTokens', 'messageTokens']);
      else if (key === 'tokenUsage') values[key] = numericRecord(raw, ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']);
      else if (key === 'sessionStats') {
        const stats = numericRecord(raw, ['turns', 'steps', 'ttftSteps', 'decodeTokens']); const timing = requireRecord(raw);
        for (const field of ['llmMs', 'toolMs', 'ttftMs', 'decodeMs']) stats[field] = finiteNonnegative(timing[field]);
        values[key] = stats;
      }
      else if (key === 'todos') values[key] = raw === null ? null : list(raw, 200).map(item => {
        const todo = requireRecord(item);
        if (todo.status !== 'pending' && todo.status !== 'in_progress' && todo.status !== 'completed') throw new ProtocolFault('protocol');
        return { content: boundedString(todo.content, 4096), status: todo.status };
      });
      else if (key === 'goal') {
        if (raw === null) values[key] = null;
        else { const goal = requireRecord(raw); values[key] = { goal: parseGoalSnapshot(goal.goal), roundsStarted: nonnegative(goal.roundsStarted), createdAt: nonnegative(goal.createdAt), updatedAt: nonnegative(goal.updatedAt) }; }
      }
    } catch { invalid.push(key); }
  }
  return { values: values as NativeValues, invalid };
}
export function parseModelSelection(value: unknown): ModelSelection {
  const data = requireRecord(value); requireKeys(data, ['provider', 'model'], ['reasoningEffort']);
  return { provider: requireId(data.provider), model: requireId(data.model), ...(data.reasoningEffort === undefined ? {} : { reasoningEffort: requireId(data.reasoningEffort) }) };
}
export function parseModelCatalog(value: unknown): ModelCatalog {
  const data = requireRecord(value); const groups = list(data.groups, 64).map(item => {
    const group = requireRecord(item); const models = list(group.models, 500).map(item => {
      const model = requireRecord(item);
      let reasoning: ModelReasoning | undefined;
      if (model.reasoning !== undefined) {
        const levels = requireRecord(model.reasoning);
        const efforts = list(levels.efforts, 32).map(item => { const effort = requireRecord(item); return { id: requireId(effort.id), name: boundedString(effort.name, 512),
          ...(effort.description === undefined ? {} : { description: boundedString(effort.description, 2048) }) }; });
        unique(efforts.map(effort => effort.id));
        if (levels.defaultEffort !== undefined && !efforts.some(effort => effort.id === levels.defaultEffort)) throw new ProtocolFault('protocol');
        reasoning = { efforts, ...(levels.defaultEffort === undefined ? {} : { defaultEffort: requireId(levels.defaultEffort) }) };
      }
      return { id: requireId(model.id), name: boundedString(model.name, 512), ...(model.description === undefined ? {} : { description: boundedString(model.description, 2048) }), ...(reasoning === undefined ? {} : { reasoning }) };
    });
    unique(models.map(model => model.id));
    return { id: requireId(group.id), name: boundedString(group.name, 512), models };
  });
  unique(groups.map(group => group.id));
  const result = { default: parseModelSelection(data.default), groups, routableProviders: list(data.routableProviders, 64).map(requireId),
    failures: list(data.failures, 64).map(item => { const failure = requireRecord(item); return { id: requireId(failure.id), name: boundedString(failure.name, 512), message: '该提供方模型目录加载失败；可重试或使用原网页。' }; }) };
  if (JSON.stringify(result).length > 1024 * 1024) throw new ProtocolFault('budget');
  return result;
}
export function parseCommands(value: unknown): readonly CommandDescriptor[] {
  const commands = list(value, 500).map(item => {
    const command = requireRecord(item); const name = requireId(command.name);
    if (/[\s/]/u.test(name) || name.length > 128) throw new ProtocolFault('protocol');
    const input = command.input === undefined ? undefined : requireRecord(command.input);
    if (input?.attachments !== undefined && typeof input.attachments !== 'boolean') throw new ProtocolFault('protocol');
    return { name, description: boundedString(command.description, 2048, true), ...(command.definitionId === undefined ? {} : { definitionId: requireId(command.definitionId) }), ...(input === undefined ? {} : { input: { hint: boundedString(input.hint, 2048, true), ...(input.attachments === undefined ? {} : { attachments: input.attachments }) } }) };
  });
  unique(commands.map(command => command.name));
  return commands;
}
export function parseCommandExecution(value: unknown): CommandExecution {
  const execution = requireRecord(value); const result = requireRecord(execution.result);
  if (result.kind !== 'success' && result.kind !== 'error') throw new ProtocolFault('protocol');
  if (result.kind === 'error' && typeof result.text !== 'string') throw new ProtocolFault('protocol');
  return { commandId: requireId(execution.commandId), result: { kind: result.kind, ...(result.text === undefined ? {} : { text: boundedString(result.text, 65536, true) }) } };
}
export function parseGoalRef(value: unknown): GoalRef {
  const ref = requireRecord(value); requireKeys(ref, ['id', 'revision']);
  return { id: requireId(ref.id), revision: nonnegative(ref.revision, 1) };
}
export function parseGoalSnapshot(value: unknown): GoalSnapshot {
  const data = requireRecord(value);
  if (data.phase !== 'active' && data.phase !== 'paused' && data.phase !== 'blocked' && data.phase !== 'complete') throw new ProtocolFault('protocol');
  let blockedReason: GoalSnapshot['blockedReason'];
  if (data.phase === 'blocked') { const reason = requireRecord(data.blockedReason); blockedReason = { code: requireId(reason.code), message: boundedString(reason.message, 4096) }; }
  return { id: requireId(data.id), revision: nonnegative(data.revision, 1), objective: boundedString(data.objective, 16384), phase: data.phase,
    maxGoalRounds: nonnegative(data.maxGoalRounds, 1), ...(blockedReason === undefined ? {} : { blockedReason }) };
}
export function contextOccupancy(pressure: ContextPressure | undefined): { usedTokens: number; contextWindow: number; percent: number } | null {
  const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens;
  if (usedTokens === undefined || pressure?.contextWindow === undefined || pressure.contextWindow <= 0) return null;
  return { usedTokens, contextWindow: pressure.contextWindow, percent: Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100)) };
}
export function tokenTotals(usage: TokenUsage | undefined): { readonly input: number; readonly output: number; readonly total: number; readonly cacheHit: number | null } | null {
  if (usage === undefined) return null;
  const input = usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return { input, output: usage.outputTokens, total: input + usage.outputTokens, cacheHit: input === 0 ? null : usage.cacheReadTokens / input * 100 };
}
export function currentModel(values: NativeValues | undefined, catalog: ModelCatalog | null): ModelSelection | null {
  return values?.modelSelection === undefined ? null : values.modelSelection.next ?? catalog?.default ?? null;
}
export function nonnegative(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || Object.is(value, -0)) throw new ProtocolFault('protocol');
  return value;
}
export function boundedString(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || !empty && value.trim() === '') throw new ProtocolFault('protocol');
  return value;
}
function finiteNonnegative(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || Object.is(value, -0)) throw new ProtocolFault('protocol');
  return value;
}
function numericRecord(value: unknown, keys: readonly string[]): Record<string, number> {
  const record = requireRecord(value); return Object.fromEntries(keys.map(key => [key, nonnegative(record[key])]));
}
function list(value: unknown, max: number): readonly unknown[] { if (!Array.isArray(value) || value.length > max) throw new ProtocolFault('budget'); return value; }
function unique(values: readonly string[]): void { if (new Set(values).size !== values.length) throw new ProtocolFault('protocol'); }
