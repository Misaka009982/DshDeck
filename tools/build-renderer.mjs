import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// 仅由用户主动运行 build 时调用；不启动服务、不监听端口、不安装依赖。
const root = fileURLToPath(new URL('../', import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: ['src/renderer/workbench.tsx'],
  outfile: join(root, 'dist/renderer/workbench.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
  jsx: 'automatic',
  sourcemap: false,
  logLevel: 'info',
});
