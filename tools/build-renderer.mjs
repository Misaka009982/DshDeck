import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

// 仅由用户主动运行 build 时调用；不启动服务、不监听端口、不安装依赖。
const root = fileURLToPath(new URL('../', import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: { workbench: 'src/renderer/workbench.tsx', pet: 'src/renderer/pet/pet.ts' },
  outdir: join(root, 'dist/renderer'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
  jsx: 'automatic',
  sourcemap: false,
  logLevel: 'info',
});

// 构建时记录公开提交，供安装版显示精确源码入口；不在应用运行时调用 Git 或执行任意命令。
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const commit = /^[a-f0-9]{40}$/u.test(process.env.GITHUB_SHA ?? '') ? process.env.GITHUB_SHA : null;
await mkdir(join(root, 'dist/legal'), { recursive: true });
await writeFile(join(root, 'dist/legal/build.json'), `${JSON.stringify({ version: metadata.version, commit })}\n`, 'utf8');
