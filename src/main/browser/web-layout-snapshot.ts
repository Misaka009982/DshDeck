import { randomUUID } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { WebContents } from 'electron';
import { ProtocolFault, requireKeys, requireRecord } from '../../shared/faults.js';
import { writeJson } from '../storage/json-file.js';
import type { DiagnosticLogger } from '../logging/diagnostic-logger.js';

const TAGS = new Set(['main', 'aside', 'nav', 'header', 'footer', 'section', 'form', 'dialog', 'button', 'input', 'textarea', 'select', 'a']);
const ROLES = new Set(['button', 'tab', 'tablist', 'navigation', 'menu', 'menuitem', 'textbox', 'dialog', 'tree', 'treeitem', 'toolbar', 'listbox', 'combobox']);
const TYPES = new Set(['text', 'password', 'checkbox', 'radio', 'range', 'number', 'url', 'email', 'file', 'search', 'submit', 'button']);
const SAFE_LABELS = ['对话', '工具输出', '事件', '文件', '文件夹', '项目文件', '文件浏览器', '修改文件', '变更', '差异', '设置', '日志', '连接', '断开', '刷新', '搜索', '关闭', '返回', '新建会话', 'Conversation', 'Output', 'Events', 'Files', 'Project Files', 'File Explorer', 'Changes', 'Diff', 'Settings', 'Search', 'Close', 'Back'];
interface Rectangle { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
interface Region { readonly tag: string; readonly role: string | null; readonly rect: Rectangle }
interface Control extends Region { readonly type: string | null; readonly label: string | null; readonly disabled: boolean; readonly expanded: boolean | null }
interface LayoutSnapshot { readonly version: 1; readonly viewport: { width: number; height: number }; readonly regions: readonly Region[]; readonly controls: readonly Control[] }

/** 只在用户点“缓存原网页”时采样结构，不保存 HTML/JS、截图、输入值、正文或站点地址。 */
export class WebLayoutSnapshots {
  private saving: Promise<{ name: string }> | undefined;
  constructor(readonly directory: string, private readonly logger: DiagnosticLogger) {}
  async ensureDirectory(): Promise<void> { await mkdir(this.directory, { recursive: true }); }
  cache(contents: WebContents, validate: () => void): Promise<{ name: string }> {
    if (this.saving !== undefined) return this.saving;
    const task = this.capture(contents, validate); this.saving = task;
    void task.then(() => { if (this.saving === task) this.saving = undefined; }, () => { if (this.saving === task) this.saving = undefined; });
    return task;
  }
  private async capture(contents: WebContents, validate: () => void): Promise<{ name: string }> {
    validate(); await this.ensureDirectory();
    if ((await readdir(this.directory)).filter(name => /^layout-[\d-]+-[a-f\d-]+\.json$/u.test(name)).length >= 20) throw new ProtocolFault('budget');
    const value: unknown = await contents.executeJavaScript(`(() => {
      const tags = new Set(${JSON.stringify([...TAGS])}); const roles = new Set(${JSON.stringify([...ROLES])}); const types = new Set(${JSON.stringify([...TYPES])}); const labels = new Set(${JSON.stringify(SAFE_LABELS)});
      const viewport = { width: Math.min(32768, innerWidth), height: Math.min(32768, innerHeight) };
      const regions = []; const controls = []; const walk = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
      let inspected = 0; let element = walk.currentNode;
      const labelOf = node => {
        const accessible = node.getAttribute('aria-label'); if (accessible !== null) return accessible.length <= 64 && labels.has(accessible.trim()) ? accessible.trim() : null;
        const text = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); let item = text.nextNode(); let parts = ''; let count = 0;
        while (item && count++ < 8) { const piece = item.nodeValue || ''; if (parts.length + piece.length > 64) return null; parts += piece; item = text.nextNode(); }
        const label = parts.trim(); return item === null && labels.has(label) ? label : null;
      };
      while (element && inspected++ < 2000 && regions.length < 160 && controls.length < 240) {
        const tag = element.tagName.toLowerCase();
        if (tags.has(tag) && element instanceof HTMLElement && !element.closest('[data-composer-input],[contenteditable="true"]')) {
          const bounds = element.getBoundingClientRect();
          if (bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.right > 0 && bounds.top < viewport.height && bounds.left < viewport.width) {
            const x = Math.max(0, Math.round(bounds.x)); const y = Math.max(0, Math.round(bounds.y));
            const rect = { x, y, width: Math.max(0, Math.min(Math.round(bounds.width), viewport.width - x)), height: Math.max(0, Math.min(Math.round(bounds.height), viewport.height - y)) };
            const rawRole = element.getAttribute('role'); const role = roles.has(rawRole) ? rawRole : null;
            if (['button','input','textarea','select','a'].includes(tag)) {
              const rawType = element.getAttribute('type'); const expanded = element.getAttribute('aria-expanded');
              controls.push({ tag, role, rect, type: types.has(rawType) ? rawType : null,
                label: element.closest('nav,header,aside,[role="tablist"],[role="toolbar"]') ? labelOf(element) : null,
                disabled: element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true', expanded: expanded === 'true' ? true : expanded === 'false' ? false : null });
            } else regions.push({ tag, role, rect });
          }
        }
        element = walk.nextNode();
      }
      return { version: 1, viewport, regions, controls };
    })()`, true);
    validate(); const checked = sanitizeLayoutSnapshot(value);
    const name = `layout-${Date.now()}-${randomUUID()}.json`;
    await writeJson(join(this.directory, name), { ...checked, capturedAt: new Date().toISOString(), contentPolicy: 'layout-and-safe-labels-only' }, 256 * 1024);
    this.logger.record('info', 'web-layout-cached'); return { name };
  }
}
export function sanitizeLayoutSnapshot(value: unknown): LayoutSnapshot {
  const data = requireRecord(value); requireKeys(data, ['version', 'viewport', 'regions', 'controls']);
  if (data.version !== 1 || !Array.isArray(data.regions) || data.regions.length > 160 || !Array.isArray(data.controls) || data.controls.length > 240) throw new ProtocolFault('budget');
  const viewport = requireRecord(data.viewport); requireKeys(viewport, ['width', 'height']);
  const width = dimension(viewport.width); const height = dimension(viewport.height);
  const region = (value: unknown, control: boolean): Region | Control => {
    const data = requireRecord(value); requireKeys(data, ['tag', 'role', 'rect'], control ? ['type', 'label', 'disabled', 'expanded'] : []);
    if (typeof data.tag !== 'string' || !TAGS.has(data.tag) || data.role !== null && (typeof data.role !== 'string' || !ROLES.has(data.role))) throw new ProtocolFault('protocol');
    const rawRect = requireRecord(data.rect); requireKeys(rawRect, ['x', 'y', 'width', 'height']);
    const rect = { x: dimension(rawRect.x), y: dimension(rawRect.y), width: dimension(rawRect.width), height: dimension(rawRect.height) };
    if (rect.x + rect.width > width || rect.y + rect.height > height) throw new ProtocolFault('protocol');
    const result: Region = { tag: data.tag, role: data.role as string | null, rect };
    if (!control) return result;
    if (data.type !== null && (typeof data.type !== 'string' || !TYPES.has(data.type)) || data.label !== null && (typeof data.label !== 'string' || !SAFE_LABELS.includes(data.label))
      || typeof data.disabled !== 'boolean' || data.expanded !== null && typeof data.expanded !== 'boolean') throw new ProtocolFault('protocol');
    return { ...result, type: data.type as string | null, label: data.label as string | null, disabled: data.disabled, expanded: data.expanded as boolean | null };
  };
  return { version: 1, viewport: { width, height }, regions: data.regions.map(value => region(value, false) as Region), controls: data.controls.map(value => region(value, true) as Control) };
}
function dimension(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 32768) throw new ProtocolFault('protocol'); return value;
}
