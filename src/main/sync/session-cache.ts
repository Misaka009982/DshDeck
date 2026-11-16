import type { AssistantBaseline, AssistantFrame, FollowSnapshot, Freshness, HistoryPage, ServerScope, SessionContext, WireEvent } from '../../shared/domain.js';
import { preferenceKey } from '../../shared/domain.js';
import { ProtocolFault, toPublicFailure } from '../../shared/faults.js';
import type { PublicFailure } from '../../shared/faults.js';
import { parseSessionTitle } from '../../shared/session-title.js';
import { NATIVE_KEYS, nonnegative, parseNativeValues } from '../../shared/native-controls.js';
import type { NativeFrame, NativeSnapshot, NativeKey, NativeValues } from '../../shared/native-controls.js';

interface CachedTitle { readonly text: string; readonly asOfSeq: number }
export interface CacheSnapshot {
  readonly context: SessionContext;
  readonly header: FollowSnapshot['header'];
  readonly title: CachedTitle | null;
  readonly native: NativeSnapshot;
  readonly events: readonly WireEvent[];
  readonly assistant: AssistantBaseline;
  readonly cursor: number;
  readonly hasMore: boolean;
  readonly hasGap: boolean;
  readonly freshness: Freshness;
  readonly syncing: boolean;
  readonly syncedAt: number;
  readonly failure: PublicFailure | null;
}
interface Entry {
  context: SessionContext;
  header: FollowSnapshot['header'];
  title: CachedTitle | null;
  native: NativeSnapshot;
  events: readonly WireEvent[];
  assistant: AssistantBaseline;
  cursor: number;
  hasMore: boolean;
  hasGap: boolean;
  freshness: Freshness;
  syncing: boolean;
  syncedAt: number;
  failure: PublicFailure | null;
  settlementSeq: number | null;
  bytes: number;
}

/** 有界内存缓存；旧代次只能展示，当前读取与写入仍要求新代次，持久历史另按不可变 header 校验。 */
export class SessionCache {
  private readonly entries = new Map<string, Entry>();
  private readonly scopes = new Map<string, ServerScope>();
  private readonly revoked = new Map<string, number>();
  private readonly revokedSessions = new Map<string, number>();
  private protectedKey: string | null = null;
  constructor(private readonly budget = 64 * 1024 * 1024, private readonly changed: () => void = () => {}, private readonly now: () => number = Date.now) {}
  beginScope(scope: ServerScope): void {
    const previous = this.scopes.get(scope.serverId);
    if (previous !== undefined && (scope.generation < previous.generation || scope.generation === previous.generation && scope.authProfileId !== previous.authProfileId)) throw new ProtocolFault('cancelled');
    this.scopes.set(scope.serverId, { ...scope }); this.markStale(scope.serverId);
  }
  protect(context: SessionContext | null): void { this.protectedKey = context === null ? null : key(context); }
  get(context: SessionContext): CacheSnapshot | undefined {
    const entry = this.match(context);
    return entry === undefined ? undefined : this.snapshot(entry, context);
  }
  /** 仅供 UI 保留已读正文；照实返回来源代次，不能用于接流、动作或确认已读。 */
  getForDisplay(context: SessionContext): CacheSnapshot | undefined {
    const current = this.get(context); if (current !== undefined) return current;
    const entry = this.entries.get(key(context)); const scope = this.scopes.get(context.serverId);
    if (entry === undefined || entry.context.generation > context.generation
      || scope !== undefined && (scope.authProfileId !== context.authProfileId || scope.generation < context.generation)) return undefined;
    return { ...this.snapshot(entry, entry.context), freshness: 'stale', syncing: false, native: { ...entry.native, state: 'stale' } };
  }
  applySnapshot(context: SessionContext, snapshot: FollowSnapshot): void {
    if (!this.scopeMatches(context) || (this.revoked.get(context.serverId) ?? -1) >= context.generation || (this.revokedSessions.get(key(context)) ?? -1) >= context.generation) throw new ProtocolFault('cancelled');
    const previous = this.entries.get(key(context));
    if (previous !== undefined && previous.context.generation > context.generation) return;
    const sameGeneration = previous?.context.generation === context.generation;
    const reusable = previous !== undefined && previous.header.id === snapshot.header.id
      && previous.header.createdAt === snapshot.header.createdAt && previous.header.version === snapshot.header.version;
    const events = merge(reusable ? previous.events : [], snapshot.events);
    const cursor = Math.max(reusable ? previous.cursor : -1, snapshot.cursor);
    // assistant revision 和投影属于当前载体基线，跨代次只合并持久事件，不让旧瞬态盖住新状态。
    const assistant = reusable && sameGeneration && (snapshot.cursor < previous.cursor || snapshot.assistant.revision < previous.assistant.revision) ? previous.assistant : snapshot.assistant;
    const first = events[0]?.seq ?? -1;
    const text = parseSessionTitle(snapshot.projections.title);
    const title = newerTitle(newerTitle(reusable ? previous.title : null, text === undefined ? null : { text, asOfSeq: snapshot.cursor }), titleFromEvents(events));
    const native: NativeSnapshot = reusable && sameGeneration && previous.native.asOfSeq >= snapshot.cursor ? previous.native
      : { asOfSeq: snapshot.cursor, ...parseNativeValues(snapshot.projections), state: reusable && sameGeneration && previous.native.state === 'live' ? 'live' : 'cached', failure: null };
    const entry: Entry = {
      context: { ...context }, header: { ...snapshot.header }, title, native, events, cursor, assistant,
      hasMore: first > 0 || (snapshot.hasMore && (!reusable || previous.hasMore)), hasGap: hasGap(events, cursor),
      freshness: 'fresh', syncing: sameGeneration ? previous?.syncing ?? false : false, syncedAt: this.now(), failure: null,
      settlementSeq: reusable && sameGeneration ? previous.settlementSeq : null, bytes: 0,
    };
    this.admit(context, entry);
  }
  applyPage(context: SessionContext, page: HistoryPage): void {
    const previous = this.require(context);
    if (page.cursor > previous.cursor) throw new ProtocolFault('protocol');
    const events = merge(previous.events, page.events);
    const entry = { ...previous, events, title: newerTitle(previous.title, titleFromEvents(page.events)), hasMore: (events[0]?.seq ?? -1) > 0 && page.hasMore,
      hasGap: hasGap(events, previous.cursor), freshness: 'fresh' as const, syncedAt: this.now(), failure: null };
    entry.hasMore = (events[0]?.seq ?? -1) > 0;
    this.admit(context, entry);
  }
  applyEvent(context: SessionContext, event: WireEvent): void {
    const previous = this.require(context);
    const events = merge(previous.events, [event]);
    const cursor = Math.max(previous.cursor, event.seq);
    const settled = previous.settlementSeq === event.seq && (event.type === 'assistant/message' || event.type === 'assistant/attempt');
    const entry = { ...previous, events, cursor, title: newerTitle(previous.title, titleFromEvents([event])), hasGap: hasGap(events, cursor), freshness: 'fresh' as const,
      syncedAt: this.now(), failure: null,
      assistant: settled ? { revision: previous.assistant.revision, activeAttempt: null } : previous.assistant,
      settlementSeq: settled ? null : previous.settlementSeq };
    this.admit(context, entry);
  }
  applyAssistant(context: SessionContext, frame: AssistantFrame): void {
    const previous = this.require(context);
    if (frame.revision <= previous.assistant.revision) return;
    if (frame.revision !== previous.assistant.revision + 1) throw new ProtocolFault('protocol');
    let assistant: AssistantBaseline;
    let settlementSeq = previous.settlementSeq;
    if (frame.type === 'start') {
      if (frame.startedAfterSeq > previous.cursor) throw new ProtocolFault('protocol');
      assistant = { revision: frame.revision, activeAttempt: { attemptId: frame.attemptId, startedAfterSeq: frame.startedAfterSeq,
        turn: frame.turn, step: frame.step, nextIndex: 0, stream: [] } };
      settlementSeq = null;
    } else {
      const active = previous.assistant.activeAttempt;
      if (active === null || active.attemptId !== frame.attemptId) return;
      if (frame.index !== active.nextIndex) throw new ProtocolFault('protocol');
      if (frame.type === 'chunk') {
        assistant = { revision: frame.revision, activeAttempt: { ...active, nextIndex: active.nextIndex + 1,
          stream: [...active.stream, { type: 'chunk', time: frame.time, chunk: frame.chunk }] } };
      } else if (frame.outcome.kind === 'abandoned') { assistant = { revision: frame.revision, activeAttempt: null }; settlementSeq = null; }
      else {
        settlementSeq = frame.outcome.seq;
        const persisted = previous.events.some(event => event.seq === settlementSeq);
        assistant = { revision: frame.revision, activeAttempt: persisted ? null : active };
        if (persisted) settlementSeq = null;
      }
    }
    const entry = { ...previous, assistant, settlementSeq, freshness: 'fresh' as const, syncedAt: this.now() };
    this.admit(context, entry);
  }
  applyProjections(context: SessionContext, frame: NativeFrame): void {
    const previous = this.require(context); const seq = frame.kind === 'baseline' ? nonnegative(frame.asOfSeq, -1) : nonnegative(frame.seq);
    if (seq < previous.native.asOfSeq || frame.kind === 'change' && seq === previous.native.asOfSeq) return;
    let values: NativeValues; let invalid: readonly NativeKey[];
    if (frame.kind === 'baseline') ({ values, invalid } = parseNativeValues(frame.values));
    else {
      const changed = Object.fromEntries(frame.changes.filter(change => (NATIVE_KEYS as readonly string[]).includes(change.key)).map(change => [change.key, change.val]));
      const parsed = parseNativeValues(changed); const next: Record<string, unknown> = { ...previous.native.values }; const unavailable = new Set(previous.native.invalid);
      for (const key of NATIVE_KEYS) if (Object.hasOwn(changed, key)) {
        if (parsed.invalid.includes(key)) { delete next[key]; unavailable.add(key); }
        else { next[key] = parsed.values[key]; unavailable.delete(key); }
      }
      values = next as NativeValues; invalid = [...unavailable];
    }
    const titleValue = frame.kind === 'baseline' ? frame.values.title : frame.changes.find(change => change.key === 'title')?.val;
    const title = parseSessionTitle(titleValue);
    this.admit(context, { ...previous, native: { asOfSeq: seq, values, invalid, state: 'live', failure: null },
      title: newerTitle(previous.title, title === undefined ? null : { text: title, asOfSeq: seq }) });
  }
  setNativeFailure(context: SessionContext, error: unknown): void {
    const entry = this.match(context);
    if (entry !== undefined) { entry.native = { ...entry.native, state: 'stale', failure: toPublicFailure(error) }; this.changed(); }
  }
  markNativeCached(context: SessionContext): void {
    const entry = this.match(context);
    if (entry?.native.state === 'live') { entry.native = { ...entry.native, state: 'cached' }; this.changed(); }
  }
  setSyncing(context: SessionContext, syncing: boolean): void {
    const entry = this.match(context);
    if (entry !== undefined && entry.syncing !== syncing) { entry.syncing = syncing; this.changed(); }
  }
  setFailure(context: SessionContext, error: unknown): void {
    const entry = this.match(context);
    if (entry !== undefined) { entry.failure = toPublicFailure(error); entry.freshness = 'stale'; entry.syncing = false; this.changed(); }
  }
  gapBefore(context: SessionContext): number | null {
    const entry = this.match(context);
    if (entry === undefined) return null;
    for (let index = 1; index < entry.events.length; index++) {
      const previous = entry.events[index - 1]; const next = entry.events[index];
      if (previous !== undefined && next !== undefined && next.seq > previous.seq + 1) return next.seq;
    }
    return null;
  }
  markStale(serverId: string): void { for (const entry of this.entries.values()) if (entry.context.serverId === serverId) { entry.freshness = 'stale'; entry.syncing = false; entry.native = { ...entry.native, state: 'stale' }; } this.changed(); }
  remove(context: SessionContext): void {
    if (!this.scopeMatches(context) || (this.entries.get(key(context))?.context.generation ?? -1) > context.generation) return;
    this.entries.delete(key(context)); this.revokedSessions.set(key(context), context.generation); this.changed();
  }
  revoke(serverId: string, generation?: number): void {
    let through = Math.max(generation ?? -1, this.scopes.get(serverId)?.generation ?? -1);
    for (const [key, entry] of this.entries) if (entry.context.serverId === serverId) { through = Math.max(through, entry.context.generation); this.entries.delete(key); }
    this.revoked.set(serverId, Math.max(this.revoked.get(serverId) ?? -1, through)); this.changed();
  }
  clear(): void { this.entries.clear(); this.scopes.clear(); this.revoked.clear(); this.revokedSessions.clear(); this.changed(); }
  bytes(): number { let total = 0; for (const entry of this.entries.values()) total += entry.bytes; return total; }

  private snapshot(entry: Entry, context: SessionContext): CacheSnapshot {
    this.entries.delete(key(context)); this.entries.set(key(context), entry);
    return {
      context: { ...context }, header: { ...entry.header }, title: entry.title === null ? null : { ...entry.title }, native: entry.native, events: entry.events, assistant: entry.assistant,
      cursor: entry.cursor, hasMore: entry.hasMore, hasGap: entry.hasGap, freshness: entry.freshness,
      syncing: entry.syncing, syncedAt: entry.syncedAt, failure: entry.failure,
    };
  }
  private scopeMatches(context: ServerScope): boolean {
    const scope = this.scopes.get(context.serverId);
    return scope === undefined || scope.authProfileId === context.authProfileId && scope.generation === context.generation;
  }
  private match(context: SessionContext): Entry | undefined {
    if (!this.scopeMatches(context)) return undefined;
    const entry = this.entries.get(key(context));
    return entry?.context.generation === context.generation ? entry : undefined;
  }
  private require(context: SessionContext): Entry { const entry = this.match(context); if (entry === undefined) throw new ProtocolFault('protocol'); return entry; }
  private admit(context: SessionContext, entry: Entry): void {
    entry.bytes = Buffer.byteLength(JSON.stringify({ events: entry.events, assistant: entry.assistant, title: entry.title, native: entry.native }), 'utf8');
    // 过大的正文或 attempt 保留旧缓存并报告，不无限扩大当前会话预算。
    if (entry.bytes > Math.min(this.budget, 8 * 1024 * 1024)) throw new ProtocolFault('budget');
    this.entries.delete(key(context)); this.entries.set(key(context), entry);
    while (this.bytes() > this.budget) {
      const candidate = [...this.entries.keys()].find(key => key !== this.protectedKey && key !== keyOfEntry(entry));
      if (candidate === undefined) {
        this.entries.delete(key(context));
        throw new ProtocolFault('budget');
      }
      this.entries.delete(candidate);
    }
    this.changed();
  }
}
function key(context: SessionContext): string { return preferenceKey(context.serverId, context.authProfileId, context.sessionId); }
function keyOfEntry(entry: Entry): string { return key(entry.context); }
function merge(previous: readonly WireEvent[], incoming: readonly WireEvent[]): readonly WireEvent[] {
  const events = new Map(previous.map(event => [event.seq, event]));
  for (const event of incoming) {
    const old = events.get(event.seq);
    if (old !== undefined && JSON.stringify(old) !== JSON.stringify(event)) throw new ProtocolFault('protocol');
    events.set(event.seq, event);
  }
  return [...events.values()].sort((left, right) => left.seq - right.seq);
}
function newerTitle(previous: CachedTitle | null, incoming: CachedTitle | null): CachedTitle | null {
  return incoming !== null && (previous === null || incoming.asOfSeq >= previous.asOfSeq) ? incoming : previous;
}
function titleFromEvents(events: readonly WireEvent[]): CachedTitle | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type !== 'session/title') continue;
    if (typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) throw new ProtocolFault('protocol');
    const text = parseSessionTitle(Reflect.get(event.data, 'title'));
    if (text !== undefined) return { text, asOfSeq: event.seq };
  }
  return null;
}
function hasGap(events: readonly WireEvent[], cursor: number): boolean {
  if (cursor >= 0 && (events.length === 0 || events[events.length - 1]?.seq !== cursor)) return true;
  for (let index = 1; index < events.length; index++) if (events[index]?.seq !== (events[index - 1]?.seq ?? -2) + 1) return true;
  return false;
}
