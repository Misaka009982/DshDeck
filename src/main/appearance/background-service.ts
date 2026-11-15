import { dialog, nativeImage, session } from 'electron';
import type { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import type { AppearanceView, BackgroundImageInfo } from '../../shared/appearance.js';
import { ProtocolFault } from '../../shared/faults.js';
import type { Preferences } from '../storage/preferences.js';
import type { DiagnosticLogger } from '../logging/diagnostic-logger.js';
import { MAX_BACKGROUND_BYTES, parseRasterInfo } from './image-size.js';

interface LoadedBackground { readonly path: string; readonly id: string; readonly bytes: Buffer; readonly mime: string; readonly info: BackgroundImageInfo }
/** 图片只注册到本地工作台分区。远程服务器网页既没有资产通道，也收不到路径或图片字节。 */
export class BackgroundService {
  private current: LoadedBackground | undefined;
  private unavailable = false;
  constructor(private readonly preferences: Preferences, private readonly changed: () => void, private readonly logger?: DiagnosticLogger) {}
  async initialize(): Promise<void> {
    session.fromPartition('dshdeck-workbench-ui').protocol.handle('dshdeck-image', request => {
      let url: URL; try { url = new URL(request.url); } catch { return new Response(null, { status: 404 }); }
      const current = this.current;
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
      if (current === undefined || url.hostname !== 'image' || url.pathname !== `/${current.id}` || url.search !== '' || url.hash !== '') return new Response(null, { status: 404 });
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(current.bytes), {
        headers: { 'Content-Type': current.mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      });
    });
    const path = this.preferences.backgroundPath();
    if (path !== null) {
      try { this.current = await loadBackground(path); }
      catch (error) { this.unavailable = true; this.logger?.fault('background-failed', error); }
    }
    this.changed();
  }
  view(): AppearanceView {
    return { settings: this.preferences.appearance(), image: this.current?.info ?? null,
      imageState: this.current === undefined ? this.unavailable ? 'unavailable' : 'empty' : 'ready',
      message: this.unavailable ? '背景图片不可用；原文件未删除，请重新选择本机图片。' : '图片仅在本机显示，不会上传或随安装包分发。' };
  }
  async choose(parent: BrowserWindow): Promise<void> {
    const choice = await dialog.showOpenDialog(parent, { title: '选择全区域背景图片', properties: ['openFile'],
      filters: [{ name: '静态图片（PNG、JPEG、WebP）', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    const path = choice.filePaths[0]; if (choice.canceled || path === undefined) return;
    const next = await loadBackground(path);
    await this.preferences.setBackgroundPath(next.path);
    this.current = next; this.unavailable = false; this.changed();
  }
  async clear(): Promise<void> {
    await this.preferences.setBackgroundPath(null); this.current = undefined; this.unavailable = false; this.changed();
  }
  dispose(): void { session.fromPartition('dshdeck-workbench-ui').protocol.unhandle('dshdeck-image'); this.current = undefined; }
}
async function loadBackground(path: string): Promise<LoadedBackground> {
  if (!isAbsolute(path) || /^(?:\\\\|\/\/)/u.test(path) || path.length > 4096) throw new ProtocolFault('unsupported');
  const canonical = await realpath(path);
  if (/^(?:\\\\|\/\/)/u.test(canonical)) throw new ProtocolFault('unsupported');
  const file = await open(canonical, 'r');
  let bytes: Buffer;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 24 || stat.size > MAX_BACKGROUND_BYTES) throw new ProtocolFault('budget');
    const data = Buffer.alloc(stat.size + 1); let size = 0;
    while (size < data.length) { const read = await file.read(data, size, data.length - size, size); if (read.bytesRead === 0) break; size += read.bytesRead; }
    if (size !== stat.size) throw new ProtocolFault('conflict'); bytes = data.subarray(0, size);
  } finally { await file.close(); }
  const info = parseRasterInfo(bytes);
  const decoded = nativeImage.createFromBuffer(bytes);
  const size = decoded.getSize();
  const oriented = size.width === info.width && size.height === info.height
    || info.mime === 'image/jpeg' && size.width === info.height && size.height === info.width;
  if (decoded.isEmpty() || !oriented) throw new ProtocolFault('unsupported');
  const id = randomUUID();
  return { path: canonical, bytes, mime: info.mime, id,
    info: { name: basename(canonical), assetUrl: `dshdeck-image://image/${id}`, width: size.width, height: size.height } };
}
