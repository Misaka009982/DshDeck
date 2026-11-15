import type { AppBridge, AuthBridge, CredentialBridge } from '../shared/contracts.js';

declare global {
  interface Window {
    dshDeck: AppBridge;
    dshDeckAuth: AuthBridge;
    dshDeckCredential: CredentialBridge;
  }
}
export {};
