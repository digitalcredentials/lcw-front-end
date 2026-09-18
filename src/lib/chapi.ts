import * as polyfill from 'credential-handler-polyfill';
import * as WebCredentialHandler from 'web-credential-handler';

// Registers this wallet with the browser's credential mediator (CHAPI), so
// issuer pages can offer it as a wallet choice. The handler URL and enabled
// types come from public/manifest.json.
export async function registerWallet() {
  await polyfill.loadOnce();
  await WebCredentialHandler.installHandler();
}
