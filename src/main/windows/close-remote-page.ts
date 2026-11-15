export interface ClosableRemotePage {
  isDestroyed(): boolean;
  once(event: 'destroyed', listener: () => void): unknown;
  close(options: { waitForBeforeUnload: false }): void;
}

/** 必须等网页实际销毁，不能把一次异步 close 调用当作已停止实时流。 */
export function closeRemotePage(page: ClosableRemotePage): Promise<void> {
  if (page.isDestroyed()) return Promise.resolve();
  return new Promise(resolve => {
    page.once('destroyed', resolve);
    page.close({ waitForBeforeUnload: false });
  });
}
