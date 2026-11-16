import type { ReactNode } from 'react';

export type WorkbenchIconName = 'plus' | 'arrow-up' | 'stop' | 'target' | 'tasks' | 'chevron-down' | 'refresh' | 'edit' | 'trash' | 'pause' | 'play' | 'close' | 'external' | 'shield' | 'clock' | 'database' | 'activity' | 'star' | 'menu' | 'sidebar' | 'chat' | 'folder' | 'terminal' | 'events' | 'unread';
// 本机绘制的统一线性图标，不引入图标依赖、字体包或外部品牌素材。
const icons: Record<WorkbenchIconName, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  'arrow-up': <path d="M12 19V5m-6 6 6-6 6 6" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />,
  target: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /><path d="m12 12 8-8M17 3l1 3 3 1" /></>,
  tasks: <><path d="M10 6h10M10 12h10M10 18h10M3 5l1.5 1.5L7 4M3 11l1.5 1.5L7 10" /><circle cx="5" cy="18" r="1.5" /></>,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  refresh: <><path d="M19.5 8A8 8 0 0 0 5 6.5L3 9m0-5v5h5M4.5 16A8 8 0 0 0 19 17.5l2-2.5m0 5v-5h-5" /></>,
  edit: <><path d="m15 4 5 5M4 15 15 4a3.5 3.5 0 0 1 5 5L9 20l-6 1 1-6Z" /><path d="m4 15 5 5" /></>,
  trash: <><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" /></>,
  pause: <><path d="M8 5v14M16 5v14" strokeWidth="3" /></>,
  play: <path d="m8 4 12 8-12 8V4Z" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  external: <><path d="M14 4h6v6M20 4 10 14M10 5H5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-5" /></>,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l4 2" /></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0" /></>,
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  star: <path d="m12 3 2.8 5.8 6.2.9-4.5 4.4 1.1 6.2L12 17.4l-5.6 2.9 1.1-6.2L3 9.7l6.2-.9L12 3Z" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  sidebar: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
  chat: <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Z" />,
  folder: <path d="M3 7V5a1 1 0 0 1 1-1h5l3 3h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" />,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></>,
  events: <><path d="M8 4h12M8 12h12M8 20h12M4 4v16" /><circle cx="4" cy="4" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="4" cy="20" r="1" /></>,
  unread: <><path d="M3 9v10a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V9M3 9l9 6 9-6M3 9l9-7 3 1.8" /><circle cx="20" cy="4" r="2" /></>,
};
export function WorkbenchIcon({ name, size = 16, className = '' }: { readonly name: WorkbenchIconName; readonly size?: number; readonly className?: string }) {
  return <svg className={`workbench-icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{icons[name]}</svg>;
}
