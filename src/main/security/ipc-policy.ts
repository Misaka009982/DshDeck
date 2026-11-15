export interface IpcSenderFacts {
  readonly webContentsId: number;
  readonly frameUrl: string;
  readonly isMainFrame: boolean;
}

export interface IpcOwner {
  readonly webContentsId: number;
  readonly pageUrl: string;
}

/** sender 与 frame 信息由 main 从事件读取，不能相信请求体提供的身份。 */
export function isTrustedIpcSender(sender: IpcSenderFacts, owner: IpcOwner): boolean {
  return sender.webContentsId === owner.webContentsId
    && sender.isMainFrame
    && sender.frameUrl === owner.pageUrl;
}
