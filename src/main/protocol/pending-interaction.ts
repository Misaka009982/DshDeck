import { parseRemoteEventResult } from '@deepseek-ai/dsh-api-gateway/stream-protocol';
import type { RemoteEventResult } from '@deepseek-ai/dsh-api-gateway/stream-protocol';
import { isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol';
import type { AnswerInput, PendingInteraction, QuestionItem, ServerScope } from '../../shared/domain.js';
import { ProtocolFault, requireId, requireKeys, requireRecord } from '../../shared/faults.js';

export type EventFrame =
  | { readonly type: 'ready'; readonly clientId: string }
  | { readonly type: 'emit'; readonly event: string; readonly args: readonly unknown[] }
  | { readonly type: 'waterfall'; readonly event: string; readonly eventId: string; readonly agentId: string; readonly request: Readonly<Record<string, unknown>> }
  | { readonly type: 'cancel'; readonly eventId: string };

export function parseEventFrame(value: unknown): EventFrame {
  const frame = requireRecord(value);
  if (frame.type === 'ready') {
    requireKeys(frame, ['type', 'clientId', 'host']);
    const host = requireRecord(frame.host); requireKeys(host, ['home']);
    if (typeof host.home !== 'string') throw new ProtocolFault('protocol');
    return { type: 'ready', clientId: requireId(frame.clientId) };
  }
  if (frame.type === 'cancel') { requireKeys(frame, ['type', 'eventId']); return { type: 'cancel', eventId: requireId(frame.eventId) }; }
  if (frame.type === 'emit') {
    requireKeys(frame, ['type', 'event', 'args']);
    if (!Array.isArray(frame.args) || !isRemoteJsonValue(frame.args)) throw new ProtocolFault('protocol');
    return { type: 'emit', event: requireId(frame.event), args: frame.args };
  }
  if (frame.type === 'waterfall') {
    requireKeys(frame, ['type', 'event', 'eventId', 'agentId', 'request']);
    const request = requireRecord(frame.request);
    if (Object.hasOwn(request, 'agent') || Object.hasOwn(request, 'signal') || !isRemoteJsonValue(request)) throw new ProtocolFault('protocol');
    return { type: 'waterfall', event: requireId(frame.event), eventId: requireId(frame.eventId), agentId: requireId(frame.agentId), request };
  }
  throw new ProtocolFault('protocol');
}

/** pending 只暴露可显示字段；未知或限时 schema 不猜测结果。 */
export class PendingInteractions {
  private clientId: string | null = null;
  private readonly pending = new Map<string, PendingInteraction>();
  constructor(private readonly scope: ServerScope, private readonly changed: (pending: readonly PendingInteraction[]) => void) {}
  ready(clientId: string): void { this.clientId = clientId; this.pending.clear(); this.publish(); }
  receive(frame: Extract<EventFrame, { type: 'waterfall' }>): void {
    if (this.clientId === null || this.pending.has(frame.eventId) || this.pending.size >= 512) throw new ProtocolFault('protocol');
    let kind: PendingInteraction['kind'] = 'unsupported';
    let prompt = '该交互结构尚未安全适配，请使用兼容页面或明确交还处理。';
    let questions: readonly QuestionItem[] = [];
    if (frame.event === 'approval/request') {
      const request = frame.request;
      if (typeof request.toolName === 'string' && request.toolName.length <= 512 && (request.reason === undefined || typeof request.reason === 'string')) {
        kind = 'approval';
        const display = typeof request.displayReason === 'object' && request.displayReason !== null ? requireRecord(request.displayReason) : {};
        const reason = typeof display['zh-CN'] === 'string' ? display['zh-CN'] : typeof request.reason === 'string' ? request.reason : '';
        prompt = `工具 ${request.toolName} 请求权限${reason === '' ? '。' : `：${reason}`}`;
      }
    } else if (frame.event === 'user-questions/request') {
      try {
        const wait = frame.request.wait === undefined ? undefined : requireRecord(frame.request.wait);
        if (wait?.timed === true) throw new ProtocolFault('unsupported');
        questions = parseQuestions(frame.request.questions);
        kind = 'question'; prompt = questions.map(question => question.question).join('\n');
      } catch { questions = []; }
    }
    this.pending.set(frame.eventId, {
      ...this.scope, id: frame.eventId, sessionId: frame.agentId, name: frame.event, kind,
      prompt: prompt.slice(0, 16384), questions,
      choices: kind === 'approval' ? [{ id: 'allowed-once', label: '允许一次' }, { id: 'rejected', label: '拒绝' }] : [], openedAt: Date.now(),
    });
    this.publish();
  }
  cancel(eventId: string): void { if (this.pending.delete(eventId)) this.publish(); }
  all(): readonly PendingInteraction[] { return [...this.pending.values()].map(item => structuredClone(item)); }
  prepare(input: AnswerInput): { result: RemoteEventResult; commit: () => void } {
    const pending = this.pending.get(input.interactionId);
    if (pending === undefined || this.clientId === null || input.context.serverId !== this.scope.serverId
      || input.context.authProfileId !== this.scope.authProfileId || input.context.generation !== this.scope.generation
      || input.context.sessionId !== pending.sessionId) throw new ProtocolFault('cancelled');
    let outcome: RemoteEventResult['outcome'];
    if (input.value === '__delegate__') outcome = { kind: 'next' };
    else if (pending.kind === 'approval') {
      if (input.value !== 'allowed-once' && input.value !== 'rejected') throw new ProtocolFault('protocol');
      outcome = { kind: 'result', value: input.value };
    } else if (pending.kind === 'question') outcome = { kind: 'result', value: parseAnswer(input.value, pending.questions) };
    else throw new ProtocolFault('unsupported');
    const result = parseRemoteEventResult({ clientId: this.clientId, eventId: pending.id, outcome });
    return { result, commit: () => { if (this.pending.get(pending.id) === pending) this.cancel(pending.id); } };
  }
  dispose(): void { this.clientId = null; this.pending.clear(); this.publish(); }
  private publish(): void { this.changed(this.all()); }
}
function parseQuestions(value: unknown): readonly QuestionItem[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw new ProtocolFault('unsupported');
  const ids = new Set<string>();
  return value.map(value => {
    const question = requireRecord(value);
    requireKeys(question, ['id', 'question'], ['detail', 'header', 'options', 'multiSelect', 'intent']);
    const id = requireId(question.id);
    if (ids.has(id) || typeof question.question !== 'string' || question.question.length > 16384
      || (question.multiSelect !== undefined && typeof question.multiSelect !== 'boolean')) throw new ProtocolFault('unsupported');
    ids.add(id);
    const options = question.options === undefined ? [] : question.options;
    if (!Array.isArray(options) || options.length > 64) throw new ProtocolFault('unsupported');
    const labels = new Set<string>();
    const parsed = options.map(value => {
      const option = requireRecord(value); requireKeys(option, ['label'], ['description']);
      if (typeof option.label !== 'string' || option.label.length > 1024 || labels.has(option.label)
        || (option.description !== undefined && typeof option.description !== 'string')) throw new ProtocolFault('unsupported');
      labels.add(option.label);
      return { label: option.label, description: typeof option.description === 'string' ? option.description.slice(0, 8192) : '' };
    });
    const intent = question.intent === undefined ? null : requireRecord(question.intent);
    return { id, question: question.question, detail: typeof question.detail === 'string' ? question.detail.slice(0, 16384) : '',
      options: parsed, multiSelect: question.multiSelect === true, fixedApproval: intent?.kind === 'approval' };
  });
}
function parseAnswer(raw: string, questions: readonly QuestionItem[]): unknown {
  if (raw.length > 65536) throw new ProtocolFault('budget');
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; } catch { throw new ProtocolFault('protocol'); }
  const answer = requireRecord(value); requireKeys(answer, ['answers']);
  if (!Array.isArray(answer.answers) || answer.answers.length !== questions.length) throw new ProtocolFault('protocol');
  const ids = new Set<string>();
  for (const value of answer.answers) {
    const item = requireRecord(value); requireKeys(item, ['id', 'selected'], ['custom']);
    const id = requireId(item.id);
    const question = questions.find(question => question.id === id);
    if (ids.has(id) || question === undefined || !Array.isArray(item.selected)
      || item.selected.some(value => typeof value !== 'string' || !question.options.some(option => option.label === value))
      || new Set(item.selected).size !== item.selected.length || (!question.multiSelect && item.selected.length > 1)
      || (item.custom !== undefined && typeof item.custom !== 'string')
      || (question.fixedApproval && (item.selected.length !== 1 || (item.custom !== undefined && item.custom !== '')))
      || (item.selected.length === 0 && (typeof item.custom !== 'string' || item.custom.trim() === ''))) throw new ProtocolFault('protocol');
    ids.add(id);
  }
  if (!isRemoteJsonValue(answer)) throw new ProtocolFault('protocol');
  return answer;
}
