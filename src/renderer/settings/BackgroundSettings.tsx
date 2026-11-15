import { useEffect, useRef, useState } from 'react';
import type { PointerEvent, CSSProperties } from 'react';
import type { AppearanceSettings, AppearanceView, ImageSize } from '../../shared/appearance.js';
import { cropFrame, DEFAULT_APPEARANCE } from '../../shared/appearance.js';
import type { WorkbenchClientStore } from '../state/workbench-store.js';

export function BackgroundSettings({ appearance, value, change, store }: { readonly appearance: AppearanceView | undefined; readonly value: AppearanceSettings; readonly change: (value: AppearanceSettings) => void; readonly store: WorkbenchClientStore }) {
  const preview = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; offsetX: number; offsetY: number } | null>(null);
  const [viewport, setViewport] = useState<ImageSize>({ width: window.innerWidth, height: window.innerHeight });
  const [box, setBox] = useState<ImageSize>({ width: 480, height: 240 });
  const [busy, setBusy] = useState(false);
  const image = appearance?.image ?? null;
  useEffect(() => {
    const resize = (): void => setViewport({ width: Math.max(1, window.innerWidth), height: Math.max(1, window.innerHeight) });
    window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    const element = preview.current; if (element === null) return;
    const resize = (): void => setBox({ width: Math.max(1, element.clientWidth), height: Math.max(1, element.clientHeight) });
    resize(); const observer = new ResizeObserver(resize); observer.observe(element); return () => observer.disconnect();
  }, [image?.assetUrl]);
  const frame = image === null ? null : cropFrame(image, viewport, value.crop);
  const fit = image === null ? 1 : Math.min(box.width / image.width, box.height / image.height);
  const left = image === null ? 0 : (box.width - image.width * fit) / 2; const top = image === null ? 0 : (box.height - image.height * fit) / 2;
  const move = (event: PointerEvent<HTMLDivElement>): void => {
    if (image === null || frame === null || drag.current?.id !== event.pointerId) return;
    const rectangle = event.currentTarget.getBoundingClientRect();
    const centerX = (event.clientX - rectangle.left - left - drag.current.offsetX) / fit / image.width;
    const centerY = (event.clientY - rectangle.top - top - drag.current.offsetY) / fit / image.height;
    change({ ...value, crop: { ...value.crop, centerX: Math.max(0, Math.min(1, centerX)), centerY: Math.max(0, Math.min(1, centerY)) } });
  };
  const choose = (clear: boolean): void => {
    if (busy) return; setBusy(true);
    void store.action(clear ? store.api.clearBackground() : store.api.chooseBackground()).finally(() => setBusy(false));
  };
  const reset = (): void => change({ ...value, crop: { ...DEFAULT_APPEARANCE.crop } });
  const imageStyle: CSSProperties = image === null ? {} : { left, top, width: image.width * fit, height: image.height * fit };
  const frameStyle: CSSProperties = frame === null ? {} : { left: left + frame.left * fit, top: top + frame.top * fit, width: frame.width * fit, height: frame.height * fit };
  return <section className="settings-section background-settings"><h3>全区域背景</h3>
    <div className="path-setting"><span>{image?.name ?? '未选择本机图片'}</span><button type="button" disabled={busy} onClick={() => choose(false)}>选择图片</button><button type="button" disabled={busy || image === null && appearance?.imageState !== 'unavailable'} onClick={() => choose(true)}>移除背景</button></div>
    <label className="checkbox-setting"><input type="checkbox" checked={value.backgroundEnabled} disabled={image === null} onChange={event => change({ ...value, backgroundEnabled: event.target.checked })} />启用整个工作台背景图片</label>
    <label>会话区背景透明度：{value.sessionTransparency}% · 其他区域：{Math.min(100, value.sessionTransparency + 10)}%<input type="range" min={0} max={100} step={1} value={value.sessionTransparency} onChange={event => change({ ...value, sessionTransparency: Number(event.target.value) })} /></label>
    <p className="muted small">只改变背景，不让文字一起变淡。图片限静态 PNG／JPEG／WebP、24 MiB；原文件不会删除，不上传到服务器。</p>
    {image !== null && <><div className="crop-preview" ref={preview} onPointerDown={event => {
      if (event.button !== 0 || frame === null) return; event.preventDefault(); const rectangle = event.currentTarget.getBoundingClientRect();
      const inside = (event.target as HTMLElement).closest('.crop-frame') !== null;
      drag.current = { id: event.pointerId, offsetX: inside ? event.clientX - rectangle.left - left - frame.centerX * fit : 0, offsetY: inside ? event.clientY - rectangle.top - top - frame.centerY * fit : 0 };
      event.currentTarget.setPointerCapture(event.pointerId); move(event);
    }} onPointerMove={move} onPointerUp={event => { if (drag.current?.id === event.pointerId) { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); } }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
      <img src={image.assetUrl} alt="本机背景的显示范围预览" style={imageStyle} draggable={false} />
      <div className="crop-frame" style={frameStyle}><span>当前窗口的显示范围</span></div>
    </div><p className="muted small">显示框跟随当前程序内容区：{viewport.width} × {viewport.height}。拖动框或点击图片定位；调整窗口时保留选定中心。</p>
    <label>显示范围缩放：{value.crop.zoom.toFixed(2)}×<input type="range" min={1} max={8} step={0.05} value={value.crop.zoom} onChange={event => change({ ...value, crop: { ...value.crop, zoom: Number(event.target.value) } })} /></label>
    <button type="button" onClick={reset}>居中并填满窗口</button></>}
    {appearance?.imageState === 'unavailable' && <p className="muted small" role="status">{appearance.message}</p>}
    <p className="muted small">范围与透明度调整后点击“应用背景”；本地文件位置变动时重新选择。</p>
  </section>;
}
