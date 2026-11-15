import { createRoot } from 'react-dom/client';
import { App } from './App.js';

// 只报告失败类型与行列号，不传递 message、URL、错误值或完整堆栈。
window.addEventListener('error', event => {
  if (window.dshDeck?.reportRendererFailure !== undefined) void window.dshDeck.reportRendererFailure({ kind: 'error', line: event.lineno, column: event.colno });
});
window.addEventListener('unhandledrejection', () => {
  if (window.dshDeck?.reportRendererFailure !== undefined) void window.dshDeck.reportRendererFailure({ kind: 'unhandled-rejection' });
});

const container = document.getElementById('root');
if (container === null) throw new Error('本地工作台入口缺失。');
createRoot(container).render(<App />);
