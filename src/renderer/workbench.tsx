import { createRoot } from 'react-dom/client';
import { App } from './App.js';

const container = document.getElementById('root');
if (container === null) throw new Error('本地工作台入口缺失。');
createRoot(container).render(<App />);
