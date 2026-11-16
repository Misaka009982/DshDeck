import type { WindowBounds, WindowState } from '../../shared/window-state.js';
import { parseWindowState } from '../../shared/window-state.js';
import { readJson, writeJson } from '../storage/json-file.js';

interface WindowPort {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isFullScreen(): boolean;
  isMaximized(): boolean;
  getNormalBounds(): WindowBounds;
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
}

/** 窗口偏好独立于账户配置；退出先捕获再刷新，不写网页、路径或认证数据。 */
export class WindowStateStore {
  private value: WindowState | null = null;
  private signature: string | null = null;
  private writing: Promise<void> = Promise.resolve();
  private window: WindowPort | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private detach: (() => void) | undefined;
  constructor(private readonly path: string, private readonly failed: (error: unknown) => void = () => {},
    private readonly persist: (path: string, value: unknown, maxBytes: number) => Promise<void> = writeJson) {}

  async load(): Promise<WindowState | null> {
    try {
      const value = await readJson(this.path, 4096);
      this.value = value === undefined ? null : parseWindowState(value);
      this.signature = this.value === null ? null : JSON.stringify(this.value);
    } catch (error) { this.value = null; this.signature = null; this.failed(error); }
    return this.get();
  }
  get(): WindowState | null { return this.value === null ? null : { ...this.value, bounds: { ...this.value.bounds } }; }
  set(value: WindowState): Promise<void> {
    const next = parseWindowState(value); const signature = JSON.stringify(next);
    this.value = next;
    if (signature === this.signature) return this.writing;
    this.signature = signature;
    const task = this.writing.then(() => this.persist(this.path, next, 4096));
    this.writing = task.catch(error => { if (this.signature === signature) this.signature = null; this.failed(error); });
    return this.writing;
  }
  bind(window: WindowPort): void {
    this.detach?.(); this.window = window;
    const schedule = (): void => {
      this.clearTimer(); this.timer = setTimeout(() => { this.timer = undefined; this.capture(); }, 300);
    };
    const capture = (): void => { this.clearTimer(); this.capture(); };
    const closed = (): void => { this.detach?.(); };
    const listeners: readonly [string, () => void][] = [
      ['move', schedule], ['resize', schedule], ['maximize', capture], ['unmaximize', capture],
      ['leave-full-screen', capture], ['close', capture], ['closed', closed],
    ];
    for (const [event, listener] of listeners) window.on(event, listener);
    this.detach = () => {
      this.clearTimer();
      for (const [event, listener] of listeners) window.removeListener(event, listener);
      if (this.window === window) this.window = undefined;
      this.detach = undefined;
    };
  }
  async flush(): Promise<void> {
    this.clearTimer(); this.capture();
    let previous: Promise<void>;
    do { previous = this.writing; await previous; } while (previous !== this.writing);
  }
  private capture(): void {
    const window = this.window;
    if (window === undefined || window.isDestroyed() || window.isFullScreen()) return;
    try {
      const bounds = window.getNormalBounds();
      // 最小化不改变之前的最大化选择；最大化事件已即时捕获正常矩形。
      const maximized = window.isMinimized() ? this.value?.maximized ?? false : window.isMaximized();
      void this.set({ version: 1, bounds, maximized });
    } catch (error) { this.failed(error); }
  }
  private clearTimer(): void { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; }
}
