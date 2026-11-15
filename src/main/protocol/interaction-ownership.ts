export interface WebInteractionOwner { readonly sessionId: string | null }
/** null owner 表示原生；owner.sessionId 为 null 时是用户显式打开的整站兼容页。 */
export function nativeOwnsInteraction(owner: WebInteractionOwner | null, sessionId: string): boolean {
  return owner === null || owner.sessionId !== null && owner.sessionId !== sessionId;
}
