import { app, dialog, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { join } from 'node:path';
import { readJson } from '../storage/json-file.js';
import { isRecord, ProtocolFault } from '../../shared/faults.js';

const PROJECT_URL = 'https://github.com/Misaka009982/DshDeck';
/** 入口、文件和网址全部由 main 固定，不接受任意路径或远程 URL。 */
export async function showLicenses(parent: BrowserWindow): Promise<void> {
  if (parent.isDestroyed()) throw new ProtocolFault('cancelled');
  const root = app.getAppPath(); const value = await readJson(join(root, 'dist/legal/build.json'), 16 * 1024).catch(() => undefined);
  const commit = isRecord(value) && typeof value.commit === 'string' && /^[a-f0-9]{40}$/u.test(value.commit) ? value.commit : null;
  const response = await dialog.showMessageBox(parent, { type: 'info', title: 'DshDeck 许可与对应源码',
    message: 'DshDeck · AGPL-3.0-or-later',
    detail: `Copyright (C) 2026 DshDeck contributors.\n内置宠物改编自 CLI-Manager/pet-e；原作者保留权利。\n可按 AGPL 条件复制、修改和再分发；本程序不提供担保。\n版本：${app.getVersion()}${commit === null ? '\n本机构建未记录公开提交，分发者需提供实际对应源码。' : `\n构建提交：${commit}`}\n官方构建页同时提供匹配提交的源码 ZIP；宠物图片不随包分发。`,
    buttons: ['查看完整许可', '打开对应源码', '关闭'], defaultId: 2, cancelId: 2,
  });
  if (response.response === 0) {
    const error = await shell.openPath(app.isPackaged ? join(process.resourcesPath, 'legal/LICENSE.txt') : join(root, 'LICENSE'));
    if (error !== '') throw new ProtocolFault('not-found');
  } else if (response.response === 1) await shell.openExternal(commit === null ? PROJECT_URL : `${PROJECT_URL}/tree/${commit}`);
}
